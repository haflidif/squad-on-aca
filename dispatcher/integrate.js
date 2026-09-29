const fs = require('node:fs');
const path = require('node:path');
const { validateContract } = require('../contracts/aca-sandbox/v1/tools/validate');
const { validateChangedPaths } = require('../contracts/aca-sandbox/v1/tools/path-scope');
const {
  readJson,
  writeJson,
  sha256Bytes,
  sha256File,
  safeName,
  redact,
  containsToken,
  findBash,
  toPosixPath
} = require('./lib/util');

const SAFE_ARTIFACT_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const WINDOWS_RESERVED_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu;
function validateArtifactRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return 'artifact path must be a non-empty string';
  if (value.includes('\0')) return 'artifact path must not contain NUL bytes';
  if (/[\x00-\x1F\x7F]/u.test(value)) return 'artifact path must not contain control characters';
  if (value.includes(':')) return 'artifact path must not contain colon characters';
  if (value.includes('\\')) return 'artifact path must use POSIX separators';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'artifact path must be relative';
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
    const key = artifact.path.normalize('NFC').toLowerCase();
    const existing = seen.get(key);
    if (existing) return `artifact manifest contains path collision: ${existing} and ${artifact.path}`;
    seen.set(key, artifact.path);
  }
  return '';
}
function parsePatchChangedPaths(patchText) {
  const changed = [];
  for (const line of patchText.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!match) continue;
    for (const candidate of [match[1], match[2]]) if (candidate !== '/dev/null') changed.push(candidate);
  }
  return [...new Set(changed)];
}
function patchPathWithTrailingNewline(source, workDir, label) {
  const bytes = fs.readFileSync(source);
  if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return source;
  const target = path.join(workDir, `${safeName(label)}.normalized.patch`);
  fs.writeFileSync(target, Buffer.concat([bytes, Buffer.from('\n')]));
  return target;
}
function parseNulPaths(text) {
  return String(text || '').split('\0').filter(Boolean);
}
function normalizeRepoPath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}
function pathTouchesGitDir(value) {
  const normalized = normalizeRepoPath(value);
  return normalized === '.git' || normalized.startsWith('.git/');
}
function pathTouchesProtected(value) {
  const normalized = normalizeRepoPath(value);
  return normalized === '.squad' || normalized.startsWith('.squad/') || normalized === '.github/workflows' || normalized.startsWith('.github/workflows/');
}
function parseRawDiffText(text) {
  const parts = String(text || '').split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < parts.length;) {
    const meta = parts[index++];
    if (!meta.startsWith(':')) continue;
    const filePath = parts[index++];
    if (!filePath) break;
    const fields = meta.slice(1).split(' ');
    entries.push({ oldMode: fields[0], newMode: fields[1], status: fields[4] || '', paths: [filePath] });
  }
  return entries;
}

const STATUS = { SUCCEEDED: 'succeeded', FAILED: 'failed', SKIPPED: 'skipped' };
const MAX_ARTIFACT_SIZE_BYTES = 10 * 1024 * 1024;

function integrationSummaryBase() {
  return {
    status: 'not_run',
    reason: '',
    sandbox_id: '',
    integrated_patch_path: '',
    sha256: '',
    failed_task_id: '',
    check_results: [],
    deletion_error: ''
  };
}
function taskOutputDir(outDir, taskId) { return path.join(outDir, 'tasks', safeName(taskId)); }
function patchArtifactForTask(outDir, summary, task) {
  const taskDir = taskOutputDir(outDir, task.task_id);
  const manifestPath = path.join(taskDir, 'artifact-manifest.json');
  const resultPath = path.join(taskDir, 'persona-result.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(resultPath)) throw new Error(`missing persona artifacts for ${task.task_id}`);
  const manifest = readJson(manifestPath);
  const result = readJson(resultPath);
  const patch = manifest.artifacts.find(artifact => artifact.kind === 'patch');
  if (!patch) throw new Error(`missing patch artifact for ${task.task_id}`);
  const patchPath = path.join(taskDir, ...patch.path.split('/'));
  if (!fs.existsSync(patchPath)) throw new Error(`missing patch file for ${task.task_id}`);
  const actualSha = sha256File(patchPath);
  if (actualSha !== patch.sha256.toLowerCase()) throw new Error(`persona patch sha256 mismatch for ${task.task_id}`);
  const changedPaths = parsePatchChangedPaths(fs.readFileSync(patchPath, 'utf8'));
  const scope = validateChangedPaths(changedPaths, task.owned_paths || []);
  if (scope.violations.length) throw new Error(`persona patch ownership drift for ${task.task_id}: ${JSON.stringify(scope)}`);
  return { task, manifest, result, patch, patchPath, changedPaths, sha256: actualSha };
}
function topologicalTasks(tasks) {
  const byId = new Map(tasks.map(task => [task.task_id, task]));
  const remaining = new Set(byId.keys());
  const done = new Set();
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => (byId.get(id).dependencies || []).every(dep => done.has(dep.task_id))).sort();
    if (!ready.length) throw new Error(`No integration ordering progress possible for tasks: ${[...remaining].join(', ')}`);
    for (const id of ready) {
      remaining.delete(id);
      done.add(id);
      ordered.push(byId.get(id));
    }
  }
  return ordered;
}
function buildIntegrationDispatch(plan, patchInfos) {
  const byId = new Map(patchInfos.map(info => [info.task.task_id, info]));
  const envelope = {
    schema_version: plan.schema_version,
    message_type: 'integration.dispatch',
    run_id: plan.run_id,
    provider: plan.provider,
    baseline_sha: plan.baseline_sha,
    roster: plan.roster,
    allow_3way: plan.integration?.allow_3way === 'true' ? 'true' : 'false',
    tasks: topologicalTasks(plan.tasks).map(task => {
      const info = byId.get(task.task_id);
      return {
        task_id: task.task_id,
        owner: task.owner,
        dependencies: task.dependencies || [],
        owned_paths: task.owned_paths,
        ...(task.allow_executable_bits === 'true' ? { allow_executable_bits: 'true' } : {}),
        patch_ref: { path: `patches/${safeName(task.task_id)}.patch`, sha256: info.sha256 }
      };
    })
  };
  if (plan.integration?.check_commands) envelope.check_commands = plan.integration.check_commands;
  return envelope;
}
async function collectIntegrationArtifacts({ client, handle, outDir, integrationDir, plan, personaUnionPaths, token }) {
  fs.mkdirSync(integrationDir, { recursive: true });
  const files = new Map();
  async function download(remotePath, hostRelative) {
    const reason = validateArtifactRelativePath(hostRelative);
    if (reason) throw new Error(`unsafe integration artifact path ${JSON.stringify(hostRelative)}: ${reason}`);
    const bytes = await client.readFile(handle, remotePath);
    if (bytes.length > MAX_ARTIFACT_SIZE_BYTES) throw new Error(`integration artifact ${hostRelative} exceeds size limit`);
    const target = path.join(integrationDir, ...hostRelative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    files.set(hostRelative, bytes);
    return target;
  }
  const resultPath = await download('/workspace/output/integration-result.json', 'integration-result.json');
  const manifestPath = await download('/workspace/output/artifact-manifest.json', 'artifact-manifest.json');
  const integrationResult = readJson(resultPath);
  const manifest = readJson(manifestPath);
  const resultValidation = validateContract('integration-result.schema.json', integrationResult, plan);
  if (!resultValidation.valid) throw new Error(`integration-result validation failed: ${resultValidation.errors.join('; ')}`);
  const manifestValidation = validateContract('artifact-manifest.schema.json', manifest, plan);
  if (!manifestValidation.valid) throw new Error(`integration artifact-manifest validation failed: ${manifestValidation.errors.join('; ')}`);
  const pathReason = validateArtifactManifestPaths(manifest.artifacts);
  if (pathReason) throw new Error(pathReason);
  const artifactHostPaths = [resultPath, manifestPath];
  for (const artifact of manifest.artifacts) {
    if (artifact.path === 'integration-result.json' || artifact.path === 'artifact-manifest.json') continue;
    const hostPath = await download(`/workspace/output/${artifact.path}`, artifact.path);
    artifactHostPaths.push(hostPath);
    const actual = sha256Bytes(files.get(artifact.path));
    if (actual !== artifact.sha256.toLowerCase()) throw new Error(`sha256 mismatch for integration artifact ${artifact.path}`);
  }
  for (const [name, bytes] of files) {
    if (containsToken(name, token) || containsToken(bytes, token)) throw new Error(`credential material detected in integration artifact ${name}`);
  }
  if (integrationResult.status !== 'succeeded') return { integrationResult, manifest, artifactHostPaths, patchPath: '', patchSha: '' };
  const patchArtifact = manifest.artifacts.find(artifact => artifact.kind === 'patch');
  if (!patchArtifact) throw new Error('successful integration did not emit an integrated patch');
  const resultPatchArtifact = (integrationResult.artifacts || []).find(artifact => artifact.kind === 'patch');
  if (!resultPatchArtifact) throw new Error('successful integration result did not report the integrated patch');
  if (resultPatchArtifact.sha256?.toLowerCase() !== patchArtifact.sha256.toLowerCase()) {
    throw new Error('integration result patch sha256 does not match artifact manifest sha256');
  }
  const patchPath = path.join(integrationDir, ...patchArtifact.path.split('/'));
  const integratedPaths = parsePatchChangedPaths(fs.readFileSync(patchPath, 'utf8')).sort();
  const expected = [...new Set(personaUnionPaths)].sort();
  if (JSON.stringify(integratedPaths) !== JSON.stringify(expected)) {
    throw new Error(`integrated patch paths ${JSON.stringify(integratedPaths)} do not match persona union ${JSON.stringify(expected)}`);
  }
  return { integrationResult, manifest, artifactHostPaths, patchPath, patchSha: patchArtifact.sha256.toLowerCase() };
}
const { hardenedGit, hardenedGitBuffer } = require('./lib/hardened-git');
async function createVerificationContext({ bundlePath, baselineSha, workDir, label, config }) {
  const root = path.join(workDir, label);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const ctx = {
    cwd: root,
    repoDir: path.join(root, 'repo.git'),
    homeDir: path.join(root, 'home'),
    hooksDir: path.join(root, 'hooks'),
    globalConfig: path.join(root, 'global.gitconfig'),
    secretEnvKeys: config.secretEnvKeys || [],
    onVerificationGitSpawn: config.onVerificationGitSpawn
  };
  fs.mkdirSync(ctx.homeDir, { recursive: true });
  fs.mkdirSync(ctx.hooksDir, { recursive: true });
  fs.writeFileSync(ctx.globalConfig, '');
  await hardenedGit(ctx, ['init', '--bare', ctx.repoDir]);
  await hardenedGit(ctx, [`--git-dir=${ctx.repoDir}`, 'fetch', bundlePath, `${baselineSha}:refs/heads/baseline`]);
  fs.mkdirSync(path.join(ctx.repoDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(ctx.repoDir, 'info', 'attributes'), '* -text -filter -diff -merge\n');
  const actual = (await hardenedGit(ctx, [`--git-dir=${ctx.repoDir}`, 'rev-parse', 'refs/heads/baseline'])).trim();
  if (actual !== baselineSha) throw new Error(`verification baseline ${actual} does not equal ${baselineSha}`);
  return ctx;
}
async function applyPatchToIndex(ctx, baselineSha, patchPath, indexName) {
  const indexFile = path.join(ctx.cwd, indexName);
  fs.rmSync(indexFile, { force: true });
  await hardenedGit(ctx, [`--git-dir=${ctx.repoDir}`, 'read-tree', `${baselineSha}^{tree}`], { env: { GIT_INDEX_FILE: indexFile } });
  await hardenedGit(ctx, [`--git-dir=${ctx.repoDir}`, 'apply', '--cached', patchPath], { env: { GIT_INDEX_FILE: indexFile } });
  return indexFile;
}
async function indexEntry(ctx, indexFile, relPath) {
  const result = await hardenedGit(ctx, [`--git-dir=${ctx.repoDir}`, 'ls-files', '-s', '--', relPath], { env: { GIT_INDEX_FILE: indexFile } });
  if (!result) return null;
  const match = /^(\d{6}) ([0-9a-f]{40,64}) \d\t(.+)$/m.exec(result);
  return match ? { mode: match[1], oid: match[2] } : null;
}
async function catBlob(ctx, oid) {
  return hardenedGitBuffer(ctx, [`--git-dir=${ctx.repoDir}`, 'cat-file', 'blob', oid]);
}
async function indexDelta(ctx, baselineSha, indexFile) {
  const tree = (await hardenedGit(ctx, [`--git-dir=${ctx.repoDir}`, 'write-tree'], { env: { GIT_INDEX_FILE: indexFile } })).trim();
  const names = parseNulPaths(await hardenedGit(ctx, [`--git-dir=${ctx.repoDir}`, 'diff', '--no-renames', '-z', '--name-only', baselineSha, tree]));
  const raw = parseRawDiffText(await hardenedGit(ctx, [`--git-dir=${ctx.repoDir}`, 'diff-tree', '-r', '--no-renames', '--raw', '-z', baselineSha, tree]));
  return { tree, paths: [...new Set(names)], entries: raw };
}
function validateIntegratedDeltaPolicy(delta, patchInfos) {
  const owners = new Map();
  for (const info of patchInfos) for (const relPath of info.changedPaths) owners.set(relPath, info);
  const violations = [];
  const scope = validateChangedPaths(delta.paths, [...owners.keys()]);
  for (const violation of scope.violations) violations.push(`outside persona ownership: ${JSON.stringify(violation)}`);
  for (const changedPath of delta.paths) {
    if (pathTouchesGitDir(changedPath)) violations.push(`${changedPath}: .git paths are not allowed`);
    if (pathTouchesProtected(changedPath)) violations.push(`${changedPath}: protected paths are not allowed`);
    if (!owners.has(changedPath)) violations.push(`${changedPath}: path is outside the union of persona-owned changes`);
  }
  for (const entry of delta.entries) {
    const relPath = entry.paths[entry.paths.length - 1];
    const owner = owners.get(relPath);
    const modes = [entry.oldMode, entry.newMode];
    if (modes.includes('120000')) violations.push(`${relPath}: symlinks are not allowed`);
    if (modes.includes('160000')) violations.push(`${relPath}: gitlinks are not allowed`);
    const oldExec = entry.oldMode !== '000000' && entry.oldMode.endsWith('755');
    const newExec = entry.newMode !== '000000' && entry.newMode.endsWith('755');
    if (!oldExec && newExec && owner?.task.allow_executable_bits !== 'true') {
      violations.push(`${relPath}: executable mode changes are not allowed`);
    }
  }
  return violations;
}
async function verifyIntegratedPatchContent({ bundlePath, baselineSha, patchPath, patchInfos, workDir, config }) {
  const ctx = await createVerificationContext({ bundlePath, baselineSha, workDir, label: 'integration-content-verify', config });
  const integratedIndex = await applyPatchToIndex(ctx, baselineSha, patchPath, 'integrated.index');
  const delta = await indexDelta(ctx, baselineSha, integratedIndex);
  const policyViolations = validateIntegratedDeltaPolicy(delta, patchInfos);
  if (policyViolations.length) throw new Error(`integrated patch violates dispatcher delta policy: ${policyViolations.join('; ')}`);
  for (const info of patchInfos) {
    const personaPatchPath = patchPathWithTrailingNewline(info.patchPath, workDir, info.task.task_id);
    const personaIndex = await applyPatchToIndex(ctx, baselineSha, personaPatchPath, `${safeName(info.task.task_id)}.index`);
    for (const relPath of info.changedPaths) {
      const integratedEntry = await indexEntry(ctx, integratedIndex, relPath);
      const personaEntry = await indexEntry(ctx, personaIndex, relPath);
      assertEqualIndexEntry(relPath, info.task.task_id, integratedEntry, personaEntry);
      if (integratedEntry && personaEntry) {
        const integratedBytes = await catBlob(ctx, integratedEntry.oid);
        const personaBytes = await catBlob(ctx, personaEntry.oid);
        if (!integratedBytes.equals(personaBytes)) {
          throw new Error(`integrated patch bytes for ${relPath} differ from persona patch ${info.task.task_id}`);
        }
      }
    }
  }
}
function assertEqualIndexEntry(relPath, taskId, integratedEntry, personaEntry) {
  const left = integratedEntry ? `${integratedEntry.mode}:${integratedEntry.oid}` : '<deleted>';
  const right = personaEntry ? `${personaEntry.mode}:${personaEntry.oid}` : '<deleted>';
  if (left !== right) {
    throw new Error(`integrated patch content for ${relPath} differs from persona patch ${taskId}`);
  }
}
async function runIntegrationPhase({ plan, taskSummaries, outDir, client, bundlePath, config, token, log, projectRoot }) {
  const summary = integrationSummaryBase();
  const failedTask = taskSummaries.find(task => task.status !== STATUS.SUCCEEDED);
  if (failedTask) {
    summary.status = STATUS.SKIPPED;
    summary.reason = `required task ${failedTask.task_id} did not succeed`;
    summary.failed_task_id = failedTask.task_id;
    return summary;
  }
  let handle;
  let originalError;
  try {
    summary.status = 'running';
    const patchInfos = plan.tasks.map(task => patchArtifactForTask(outDir, taskSummaries.find(item => item.task_id === task.task_id), task));
    const personaUnionPaths = patchInfos.flatMap(info => info.changedPaths);
    const integrationRoot = path.join(outDir, '.dispatcher-work', 'integration-input');
    fs.rmSync(integrationRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(integrationRoot, 'patches'), { recursive: true });
    const envelope = buildIntegrationDispatch(plan, patchInfos);
    const dispatchValidation = validateContract('integration-dispatch.schema.json', envelope, plan);
    if (!dispatchValidation.valid) throw new Error(`integration dispatch validation failed: ${dispatchValidation.errors.join('; ')}`);
    for (const info of patchInfos) fs.copyFileSync(info.patchPath, path.join(integrationRoot, 'patches', `${safeName(info.task.task_id)}.patch`));
    const dispatchPath = path.join(integrationRoot, 'integration-dispatch.json');
    writeJson(dispatchPath, envelope);

    handle = await client.create({
      name: safeName(`${plan.run_id}-integration`),
      image: config.image,
      labels: { execution_id: plan.run_id, phase: 'integration' },
      cpu: config.cpu,
      memory: config.memory,
      autoSuspendSeconds: config.autoSuspendSeconds
    });
    summary.sandbox_id = handle.id || handle.name || '';
    await client.putFile(handle, '/workspace/baseline.bundle', fs.readFileSync(bundlePath));
    await client.putFile(handle, '/workspace/integration/integration-dispatch.json', fs.readFileSync(dispatchPath));
    for (const info of patchInfos) {
      await client.putFile(handle, `/workspace/integration/patches/${safeName(info.task.task_id)}.patch`, fs.readFileSync(info.patchPath));
    }
    const env = {
      SQUAD_INTEGRATION_DISPATCH_PATH: '/workspace/integration/integration-dispatch.json',
      SQUAD_BASELINE_BUNDLE_PATH: '/workspace/baseline.bundle',
      SQUAD_OUTPUT_DIR: '/workspace/output'
    };
    const runnerArgv = config.clientKind === 'fake'
      ? [findBash(), path.join(projectRoot, 'agents', 'sandbox', 'runner', 'integrate-run.sh'), '/workspace/integration/integration-dispatch.json', '/workspace/baseline.bundle', '/workspace/output']
      : ['/opt/squad-sandbox/runner/integrate-run.sh', '/workspace/integration/integration-dispatch.json', '/workspace/baseline.bundle', '/workspace/output'];
    if (!runnerArgv[0]) throw new Error('bash is required for fake integration runner execution');
    const bootstrapArgv = config.clientKind === 'fake'
      ? ['node', path.join(projectRoot, 'agents', 'sandbox', 'runner', 'exec-with-env.js'), ...runnerArgv]
      : ['node', '/opt/squad-sandbox/runner/exec-with-env.js', ...runnerArgv];
    const execResult = await client.exec(handle, bootstrapArgv, { stdin: `${JSON.stringify(env)}\n`, timeoutMs: config.timeoutMs });
    log(`integration runner exit ${execResult.exitCode}`);
    if (execResult.stdout) log(`integration stdout ${redact(execResult.stdout, token)}`);
    if (execResult.stderr) log(`integration stderr ${redact(execResult.stderr, token)}`);
    if (containsToken(execResult.stdout, token) || containsToken(execResult.stderr, token)) throw new Error('credential material detected in integration stdout or stderr');
    if (execResult.timedOut) throw new Error('integration runner timed out');
    const integrationDir = path.join(outDir, 'integration');
    fs.rmSync(integrationDir, { recursive: true, force: true });
    const collected = await collectIntegrationArtifacts({ client, handle, outDir, integrationDir, plan, personaUnionPaths, token });
    summary.check_results = collected.integrationResult.check_results || [];
    if (collected.integrationResult.status !== 'succeeded') {
      summary.failed_task_id = collected.integrationResult.failed_task_id || '';
      throw new Error(collected.integrationResult.error?.message || 'integration failed');
    }
    await verifyIntegratedPatchContent({ bundlePath, baselineSha: plan.baseline_sha, patchPath: collected.patchPath, patchInfos, workDir: path.join(outDir, '.dispatcher-work'), config });
    summary.status = STATUS.SUCCEEDED;
    summary.reason = 'integration succeeded';
    summary.integrated_patch_path = toPosixPath(path.relative(outDir, collected.patchPath));
    summary.sha256 = collected.patchSha;
  } catch (error) {
    originalError = error;
    summary.status = STATUS.FAILED;
    summary.reason = redact(error.message, token);
    const match = /Task ([^ ]+)|Patch ([^ ]+)|for ([A-Za-z0-9._:-]+)/.exec(summary.reason);
    if (match) summary.failed_task_id = match[1] || match[2] || match[3] || '';
  } finally {
    if (handle) {
      try {
        await client.delete(handle);
      } catch (deleteError) {
        summary.deletion_error = redact(deleteError.message, token);
        if (!originalError) {
          summary.status = STATUS.FAILED;
          summary.reason = `integration sandbox delete failed: ${summary.deletion_error}`;
        }
      }
    }
  }
  return summary;
}

module.exports = { runIntegrationPhase, buildIntegrationDispatch, integrationSummaryBase };
