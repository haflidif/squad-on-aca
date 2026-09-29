const fs = require('node:fs');
const path = require('node:path');
const { validateContract } = require('../contracts/aca-sandbox/v1/tools/validate');
const { validateChangedPaths } = require('../contracts/aca-sandbox/v1/tools/path-scope');
const {
  readJson,
  writeJson,
  sha256Bytes,
  safeName,
  redact,
  containsToken,
  findBash,
  runChecked,
  toPosixPath
} = require('./lib/util');
const { FakeSandboxClient } = require('./clients/fake-sandbox-client');
const { AcaCliSandboxClient } = require('./clients/aca-cli-client');
const { validateSandboxImageRef } = require('./lib/sandbox-image');
const { runIntegrationPhase, integrationSummaryBase } = require('./integrate');

const DEFAULTS = { cpu: '1000m', memory: '2048Mi', autoSuspendSeconds: 300, concurrency: 3, timeoutMs: 300000, cloneTimeoutMs: 120000 };
const STATUS = { PENDING: 'pending', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', SKIPPED: 'skipped' };
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAX_ARTIFACTS = 64;
const MAX_ARTIFACT_SIZE_BYTES = 10 * 1024 * 1024;
const SAFE_ARTIFACT_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const WINDOWS_RESERVED_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu;

function artifactPathCollisionKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function validateArtifactRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return 'artifact path must be a non-empty string';
  if (value.includes('\0')) return 'artifact path must not contain NUL bytes';
  if (/[\x00-\x1F\x7F]/u.test(value)) return 'artifact path must not contain control characters';
  if (value.includes(':')) return 'artifact path must not contain colon characters';
  if (value.includes('\\')) return 'artifact path must use POSIX separators';
  if (value.startsWith('/')) return 'artifact path must be relative';
  if (/^[A-Za-z]:/.test(value)) return 'artifact path must not include a drive letter';
  if (!SAFE_ARTIFACT_PATH_PATTERN.test(value)) return 'artifact path contains unsupported characters or empty segments';
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') return 'artifact path must not contain dot segments';
    if (/[. ]$/u.test(segment)) return 'artifact path segments must not end in dot or space';
    const baseName = segment.normalize('NFC').split('.')[0];
    if (WINDOWS_RESERVED_DEVICE_PATTERN.test(baseName)) return 'artifact path must not contain Windows reserved device names';
  }
  return '';
}

function validateArtifactManifestPaths(artifacts) {
  const seen = new Map();
  for (const artifact of artifacts || []) {
    if (typeof artifact.path !== 'string') continue;
    const key = artifactPathCollisionKey(artifact.path);
    const existing = seen.get(key);
    if (existing && existing !== artifact.path) {
      return `artifact manifest contains case-insensitive path collision: ${JSON.stringify(existing)} and ${JSON.stringify(artifact.path)}`;
    }
    if (existing) {
      return `artifact manifest contains duplicate artifact path: ${JSON.stringify(artifact.path)}`;
    }
    seen.set(key, artifact.path);
  }
  return '';
}

function resolveArtifactHostPath(root, relativePath) {
  const reason = validateArtifactRelativePath(relativePath);
  if (reason) throw new Error(`unsafe artifact path ${JSON.stringify(relativePath)}: ${reason}`);
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`unsafe artifact path ${JSON.stringify(relativePath)}: resolved outside task output directory`);
  }
  return target;
}

function ensureNoSymlinkParents(root, target) {
  let current = path.resolve(root);
  const relativeParts = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
  for (const part of relativeParts) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`refusing to write artifact through symlink directory ${path.relative(root, current)}`);
      if (!stat.isDirectory()) throw new Error(`artifact parent path is not a directory: ${path.relative(root, current)}`);
    } else {
      fs.mkdirSync(current);
    }
  }
}

function writeFreshArtifactFile(root, relativePath, bytes) {
  const hostPath = resolveArtifactHostPath(root, relativePath);
  ensureNoSymlinkParents(root, hostPath);
  if (fs.existsSync(hostPath) && fs.lstatSync(hostPath).isSymbolicLink()) {
    throw new Error(`refusing to write artifact through symlink file ${relativePath}`);
  }
  const fd = fs.openSync(hostPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
  return hostPath;
}

function buildDispatch(plan, task) {
  const dispatch = {
    schema_version: plan.schema_version,
    message_type: 'persona.dispatch',
    run_id: plan.run_id,
    task_id: task.task_id,
    owner: task.owner,
    objective: task.objective,
    required_capabilities: task.required_capabilities,
    dependencies: task.dependencies,
    baseline_sha: plan.baseline_sha,
    roster: plan.roster,
    provider: plan.provider,
    artifact_refs: task.artifact_refs || [],
    owned_paths: task.owned_paths
  };
  if (plan.parent_run_id) dispatch.parent_run_id = plan.parent_run_id;
  return dispatch;
}

function parsePatchChangedPaths(patchText) {
  const changed = [];
  for (const line of patchText.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!match) continue;
    for (const candidate of [match[1], match[2]]) {
      if (candidate !== '/dev/null') changed.push(candidate);
    }
  }
  return [...new Set(changed)];
}

function scanBufferTreeForToken(files, token) {
  for (const [name, bytes] of files) {
    if (containsToken(name, token) || containsToken(bytes, token)) return name;
  }
  return null;
}

async function createBundle(repoPath, baselineSha, workDir, config = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const bundlePath = path.join(workDir, 'baseline.bundle');
  fs.rmSync(bundlePath, { force: true });
  const refName = 'refs/heads/squad-dispatch-baseline';
  await runChecked('git', ['update-ref', refName, baselineSha], { cwd: repoPath, secretEnvKeys: config.secretEnvKeys || [] });
  try {
    await runChecked('git', ['bundle', 'create', bundlePath, refName], { cwd: repoPath, secretEnvKeys: config.secretEnvKeys || [] });
  } finally {
    await runChecked('git', ['update-ref', '-d', refName], { cwd: repoPath, secretEnvKeys: config.secretEnvKeys || [] });
  }
  return bundlePath;
}

async function cloneBundleInSandbox(client, handle, bundleRemotePath, sourceRemotePath, baselineSha, timeoutMs) {
  const result = await client.exec(handle, ['bash', '-lc', 'rm -rf "$2" && git clone --no-checkout "$1" "$2" >/dev/null && cd "$2" && git checkout --detach "$3" >/dev/null', 'bash', bundleRemotePath, sourceRemotePath, baselineSha], { timeoutMs });
  if (result.exitCode !== 0) throw new Error(`sandbox baseline clone failed: ${result.stderr || result.stdout}`);
}

async function collectAndVerifyArtifacts({ client, handle, task, dispatch, plan, taskOutDir, token }) {
  fs.mkdirSync(taskOutDir, { recursive: true });
  const files = new Map();
  async function download(remotePath, hostRelative) {
    const reason = validateArtifactRelativePath(hostRelative);
    if (reason) throw new Error(`unsafe artifact path ${JSON.stringify(hostRelative)}: ${reason}`);
    const bytes = await client.readFile(handle, remotePath);
    if (bytes.length > MAX_ARTIFACT_SIZE_BYTES) {
      throw new Error(`artifact ${hostRelative} exceeds ${MAX_ARTIFACT_SIZE_BYTES} byte size limit`);
    }
    const hostPath = writeFreshArtifactFile(taskOutDir, hostRelative, bytes);
    files.set(hostRelative, bytes);
    return hostPath;
  }

  const resultPath = await download('/workspace/output/persona-result.json', 'persona-result.json');
  const manifestPath = await download('/workspace/output/artifact-manifest.json', 'artifact-manifest.json');
  const personaResult = readJson(resultPath);
  const manifest = readJson(manifestPath);

  const resultValidation = validateContract('persona-result.schema.json', personaResult, plan);
  if (!resultValidation.valid) throw new Error(`persona-result validation failed: ${resultValidation.errors.join('; ')}`);
  const manifestValidation = validateContract('artifact-manifest.schema.json', manifest, plan);
  if (!manifestValidation.valid) throw new Error(`artifact-manifest validation failed: ${manifestValidation.errors.join('; ')}`);
  if (personaResult.task_id !== task.task_id || manifest.task_id !== task.task_id) throw new Error('artifact task_id does not match dispatched task');
  if (JSON.stringify(personaResult.owner) !== JSON.stringify(dispatch.owner)) throw new Error('persona-result owner does not match dispatch owner');
  if (manifest.artifacts.length > MAX_ARTIFACTS) throw new Error(`artifact manifest exceeds ${MAX_ARTIFACTS} artifact limit`);
  const manifestPathReason = validateArtifactManifestPaths(manifest.artifacts);
  if (manifestPathReason) throw new Error(manifestPathReason);

  const artifactHostPaths = [resultPath, manifestPath];
  for (const artifact of manifest.artifacts) {
    if (artifact.path === 'persona-result.json' || artifact.path === 'artifact-manifest.json') continue;
    const reason = validateArtifactRelativePath(artifact.path);
    if (reason) throw new Error(`unsafe artifact path ${JSON.stringify(artifact.path)}: ${reason}`);
    if (artifact.size_bytes !== undefined && artifact.size_bytes > MAX_ARTIFACT_SIZE_BYTES) {
      throw new Error(`artifact ${artifact.path} exceeds ${MAX_ARTIFACT_SIZE_BYTES} byte size limit`);
    }
    const remotePath = `/workspace/output/${artifact.path}`;
    const hostPath = await download(remotePath, artifact.path);
    artifactHostPaths.push(hostPath);
    const actual = sha256Bytes(files.get(artifact.path));
    if (actual !== artifact.sha256.toLowerCase()) throw new Error(`sha256 mismatch for ${artifact.path}`);
  }

  const leak = scanBufferTreeForToken(files, token);
  if (leak) throw new Error(`credential material detected in downloaded artifact ${leak}`);

  const patchArtifact = manifest.artifacts.find(artifact => artifact.kind === 'patch');
  if (patchArtifact && files.has(patchArtifact.path)) {
    const changedPaths = parsePatchChangedPaths(files.get(patchArtifact.path).toString('utf8'));
    const scope = validateChangedPaths(changedPaths, task.owned_paths);
    if (scope.violations.length > 0) throw new Error(`dispatcher path ownership check failed: ${JSON.stringify(scope)}`);
  }

  if (personaResult.status !== 'succeeded') throw new Error(personaResult.error?.message || personaResult.summary || 'persona failed');

  return { artifactHostPaths, personaResult, manifest };
}

function taskSummaryBase(task) {
  return {
    task_id: task.task_id,
    logical_member_id: task.owner.logical_member_id,
    status: STATUS.PENDING,
    reason: '',
    started_at: '',
    ended_at: '',
    sandbox_id: '',
    artifact_paths: [],
    deletion_error: ''
  };
}

async function runTask({ plan, task, projectRoot, outDir, client, bundlePath, config, token, log }) {
  const summary = taskSummaryBase(task);
  summary.status = STATUS.RUNNING;
  summary.started_at = new Date().toISOString();
  let handle;
  let originalError;
  try {
    const dispatch = buildDispatch(plan, task);
    const dispatchValidation = validateContract('persona-dispatch.schema.json', dispatch, plan);
    if (!dispatchValidation.valid) throw new Error(`dispatch validation failed: ${dispatchValidation.errors.join('; ')}`);

    handle = await client.create({
      name: safeName(`${plan.run_id}-${task.task_id}`),
      image: config.image,
      labels: {
        execution_id: plan.run_id,
        task_id: task.task_id,
        logical_member_id: task.owner.logical_member_id
      },
      cpu: config.cpu,
      memory: config.memory,
      autoSuspendSeconds: config.autoSuspendSeconds
    });
    summary.sandbox_id = handle.id || handle.name || '';

    await client.putFile(handle, '/workspace/baseline.bundle', fs.readFileSync(bundlePath));
    await cloneBundleInSandbox(client, handle, '/workspace/baseline.bundle', '/workspace/source', plan.baseline_sha, config.cloneTimeoutMs);
    await client.putFile(handle, '/workspace/dispatch.json', Buffer.from(`${JSON.stringify(dispatch, null, 2)}\n`));

    const env = {
      SQUAD_SOURCE_REPO_PATH: '/workspace/source',
      SQUAD_OUTPUT_DIR: '/workspace/output',
      SQUAD_COPILOT_TOKEN: token
    };
    if (config.clientKind === 'fake') {
      env.PATH_SCOPE_TOOL = path.join(projectRoot, 'contracts', 'aca-sandbox', 'v1', 'tools', 'path-scope.js');
      if (process.env.SQUAD_COPILOT_BIN) env.SQUAD_COPILOT_BIN = process.env.SQUAD_COPILOT_BIN;
      if (process.env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST) env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST = process.env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST;
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('FAKE_')) env[key] = value;
      }
    }
    const runnerArgv = config.clientKind === 'fake'
      ? [findBash(), path.join(projectRoot, 'agents', 'sandbox', 'runner', 'persona-run.sh'), '/workspace/dispatch.json']
      : ['/persona-run.sh', '/workspace/dispatch.json'];
    if (!runnerArgv[0]) throw new Error('bash is required for fake sandbox runner execution');

    const bootstrapArgv = config.clientKind === 'fake'
      ? ['node', path.join(projectRoot, 'agents', 'sandbox', 'runner', 'exec-with-env.js'), ...runnerArgv]
      : ['node', '/opt/squad-sandbox/runner/exec-with-env.js', ...runnerArgv];
    const execResult = await client.exec(handle, bootstrapArgv, {
      stdin: `${JSON.stringify(env)}\n`,
      timeoutMs: config.timeoutMs
    });
    log(`task ${task.task_id} runner exit ${execResult.exitCode}`);
    if (execResult.stdout) log(`task ${task.task_id} stdout ${redact(execResult.stdout, token)}`);
    if (execResult.stderr) log(`task ${task.task_id} stderr ${redact(execResult.stderr, token)}`);
    if (containsToken(execResult.stdout, token) || containsToken(execResult.stderr, token)) {
      throw new Error('credential material detected in runner stdout or stderr');
    }
    if (execResult.timedOut) throw new Error('sandbox runner timed out');

    const collected = await collectAndVerifyArtifacts({ client, handle, task, dispatch, plan, taskOutDir: path.join(outDir, 'tasks', safeName(task.task_id)), token });
    summary.artifact_paths = collected.artifactHostPaths.map(file => toPosixPath(path.relative(outDir, file)));
    summary.status = STATUS.SUCCEEDED;
    summary.reason = collected.personaResult.summary || 'succeeded';
  } catch (error) {
    originalError = error;
    summary.status = STATUS.FAILED;
    summary.reason = redact(error.message, token);
  } finally {
    if (handle) {
      try {
        await client.delete(handle);
      } catch (deleteError) {
        summary.deletion_error = redact(deleteError.message, token);
        if (!originalError) {
          summary.status = STATUS.FAILED;
          summary.reason = `sandbox delete failed: ${summary.deletion_error}`;
        }
      }
    }
    summary.ended_at = new Date().toISOString();
  }
  return summary;
}

async function runDispatcher(options) {
  const repoPath = path.resolve(options.repoPath || options.repo || process.cwd());
  const planPath = path.resolve(options.planPath || options.plan);
  const outDir = path.resolve(options.outDir || options.out);
  const plan = readJson(planPath);
  const validation = validateContract('coordinator-execution.schema.json', plan);
  if (!validation.valid) throw new Error(`Execution plan is invalid: ${validation.errors.join('; ')}`);
  const clientKind = options.clientKind || options.client || 'fake';
  if (clientKind === 'aca') {
    const { assertIssueBinding, issueNumber } = require('./lib/issue-binding');
    if (!options.repoFullName) throw new Error('Live dispatch requires --repo-full-name.');
    if (process.env.GITHUB_REPOSITORY && options.repoFullName !== process.env.GITHUB_REPOSITORY) {
      throw new Error('Live dispatch repository does not match the workflow repository.');
    }
    assertIssueBinding(plan, options.repoFullName, issueNumber(options.issueNumber), true);
    if (options.repoFullName === 'AzureViking/squad-on-aca-sandbox-lab') {
      if (process.env.SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID !== 'e69b8a95-fe38-42da-b5e6-e3e0a833cf9e') {
        throw new Error('Lab dispatch requires the approved subscription.');
      }
    }
  }

  const token = options.copilotToken ?? process.env.SQUAD_COPILOT_TOKEN ?? '';
  delete process.env.SQUAD_COPILOT_TOKEN;
  if (!token) throw new Error('SQUAD_COPILOT_TOKEN is required.');
  if (token.startsWith('ghp_')) throw new Error('ACA Sandbox Copilot credentials require fine-grained github_pat_ tokens, not classic ghp_ tokens.');

  const config = { ...DEFAULTS, ...(options.config || {}) };
  config.concurrency = Number(options.concurrency || config.concurrency || DEFAULTS.concurrency);
  config.clientKind = clientKind;
  if (clientKind === 'aca') config.image = validateSandboxImageRef(options.image || config.image || process.env.SQUAD_SANDBOX_IMAGE_REF);
  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, 'dispatcher.log');
  const log = (line) => fs.appendFileSync(logPath, `${redact(line, token)}\n`);

  let client = options.clientInstance;
  if (!client) {
    if (config.clientKind === 'aca') client = new AcaCliSandboxClient({ ...(options.aca || {}), image: config.image, secretEnvKeys: config.secretEnvKeys || [] });
    else client = new FakeSandboxClient({ root: path.join(outDir, '.fake-sandboxes'), secretEnvKeys: config.secretEnvKeys || [] });
  }

  const workDir = path.join(outDir, '.dispatcher-work');
  const bundlePath = await createBundle(repoPath, plan.baseline_sha, workDir, config);
  const startedAt = new Date().toISOString();
  const summaries = new Map(plan.tasks.map(task => [task.task_id, taskSummaryBase(task)]));
  const tasksById = new Map(plan.tasks.map(task => [task.task_id, task]));
  const remaining = new Set(plan.tasks.map(task => task.task_id));
  const running = new Map();

  async function launch(task) {
    remaining.delete(task.task_id);
    const promise = runTask({ plan, task, projectRoot: PROJECT_ROOT, outDir, client, bundlePath, config, token, log })
      .then(summary => summaries.set(task.task_id, summary))
      .finally(() => running.delete(task.task_id));
    running.set(task.task_id, promise);
  }

  while (remaining.size > 0 || running.size > 0) {
    let madeProgress = false;
    for (const taskId of [...remaining]) {
      if (running.size >= config.concurrency) break;
      const task = tasksById.get(taskId);
      const deps = task.dependencies || [];
      const failedDep = deps.find(dep => summaries.get(dep.task_id)?.status === STATUS.FAILED || summaries.get(dep.task_id)?.status === STATUS.SKIPPED);
      if (failedDep) {
        const skipped = taskSummaryBase(task);
        skipped.status = STATUS.SKIPPED;
        skipped.reason = `dependency ${failedDep.task_id} did not succeed`;
        skipped.started_at = new Date().toISOString();
        skipped.ended_at = skipped.started_at;
        summaries.set(taskId, skipped);
        remaining.delete(taskId);
        madeProgress = true;
        continue;
      }
      const depsReady = deps.every(dep => summaries.get(dep.task_id)?.status === STATUS.SUCCEEDED);
      if (depsReady) {
        await launch(task);
        madeProgress = true;
      }
    }
    if (running.size > 0 && (!madeProgress || running.size >= config.concurrency)) {
      await Promise.race([...running.values()]);
      madeProgress = true;
    }
    if (!madeProgress && running.size === 0 && remaining.size > 0) {
      throw new Error(`No dispatch progress possible for tasks: ${[...remaining].join(', ')}`);
    }
  }

  const taskSummaries = plan.tasks.map(task => summaries.get(task.task_id));
  let integration = integrationSummaryBase();
  if (options.integrate !== false) {
    integration = await runIntegrationPhase({ plan, taskSummaries, outDir, client, bundlePath, config, token, log, projectRoot: PROJECT_ROOT });
  }
  const executionStatus = taskSummaries.every(task => task.status === STATUS.SUCCEEDED) && (options.integrate === false || integration.status === STATUS.SUCCEEDED) ? STATUS.SUCCEEDED : STATUS.FAILED;
  const summary = {
    schema_version: 'aca-sandbox/v1',
    message_type: 'dispatcher.summary',
    run_id: plan.run_id,
    status: executionStatus,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    integration,
    tasks: taskSummaries
  };
  const summaryValidation = validateContract('dispatcher-summary.schema.json', summary);
  if (!summaryValidation.valid) throw new Error(`internal dispatcher summary validation failed: ${summaryValidation.errors.join('; ')}`);
  const summaryPath = path.join(outDir, 'dispatcher-summary.json');
  writeJson(summaryPath, summary);
  return { summary, summaryPath, client };
}

module.exports = { runDispatcher, buildDispatch, parsePatchChangedPaths, validateArtifactRelativePath, validateArtifactManifestPaths };
