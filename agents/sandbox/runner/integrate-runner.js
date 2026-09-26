#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function requireContractTool(name) {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'contracts', 'aca-sandbox', 'v1', 'tools', name),
    path.resolve('/opt/squad/contracts/aca-sandbox/v1/tools', name)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error(`Contract tool not found: ${name}`);
}
const { validateContract } = requireContractTool('validate.js');
const { validateChangedPaths } = requireContractTool('path-scope.js');

const TOKEN_PATTERN = /(github_pat_[A-Za-z0-9_]+|gh[ops]_[A-Za-z0-9_]+)/;
const DEFAULT_PLUMBING_CAPTURE = 64 * 1024 * 1024;
const MAX_PLUMBING_CAPTURE = 256 * 1024 * 1024;
const CHECK_CAPTURE = 64 * 1024;
const CONTRACT_TOOL_HINTS = [
  'contracts/aca-sandbox/v1/tools/validate.js',
  'contracts/aca-sandbox/v1/tools/path-scope.js'
];
void CONTRACT_TOOL_HINTS;

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function sha256Bytes(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function sha256File(file) { return sha256Bytes(fs.readFileSync(file)); }
function toPosix(value) { return value.split(path.sep).join('/'); }
function safeName(value) { return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'; }
function plumbingLimit() {
  const raw = process.env.SQUAD_INTEGRATION_MAX_PLUMBING_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_PLUMBING_CAPTURE;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error('Invalid SQUAD_INTEGRATION_MAX_PLUMBING_BYTES: expected an integer between 1 and 268435456.');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_PLUMBING_CAPTURE) {
    throw new Error('Invalid SQUAD_INTEGRATION_MAX_PLUMBING_BYTES: maximum is 268435456 bytes.');
  }
  return value;
}
function safeEnv(extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: extra.HOME || process.cwd(),
    LANG: process.env.LANG || 'C.UTF-8',
    TERM: process.env.TERM || 'dumb',
    ...extra
  };
}
function outputLimitError(message) {
  const error = new Error(message);
  error.code = 'output_limit_exceeded';
  return error;
}
function appendLimited(current, chunk, limit, failOnLimit) {
  const combinedLength = current.length + chunk.length;
  if (combinedLength <= limit) return { buffer: Buffer.concat([current, chunk]), exceeded: false, truncated: false };
  if (failOnLimit) return { buffer: current, exceeded: true, truncated: false };
  const available = Math.max(0, limit - current.length);
  const next = available > 0 ? Buffer.concat([current, chunk.subarray(0, available)]) : current;
  return { buffer: next, exceeded: false, truncated: true };
}
function killChildTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore'
      });
      killer.on('error', () => {
        try { child.kill('SIGTERM'); } catch { /* best effort */ }
      });
    } catch {
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
    }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    }, 1000).unref?.();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* best effort */ }
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
  }, 1000).unref?.();
}
function run(argv, options = {}) {
  return new Promise((resolve) => {
    const stdoutLimit = options.stdoutLimit || CHECK_CAPTURE;
    const stderrLimit = options.stderrLimit || CHECK_CAPTURE;
    const failOnLimit = options.failOnLimit === true;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: safeEnv(options.env),
      shell: false,
      detached: options.detached === true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let outputExceeded = false;
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      killChildTree(child);
    }, options.timeoutMs) : null;
    child.stdout?.on('data', chunk => {
      const next = appendLimited(stdout, chunk, stdoutLimit, failOnLimit);
      stdout = next.buffer;
      stdoutTruncated = stdoutTruncated || next.truncated;
      if (next.exceeded) {
        outputExceeded = true;
        killChildTree(child);
      }
    });
    child.stderr?.on('data', chunk => {
      const next = appendLimited(stderr, chunk, stderrLimit, failOnLimit);
      stderr = next.buffer;
      stderrTruncated = stderrTruncated || next.truncated;
      if (next.exceeded) {
        outputExceeded = true;
        killChildTree(child);
      }
    });
    child.on('error', error => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: Buffer.from(error.message), stdoutTruncated, stderrTruncated, timedOut, outputExceeded });
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr, stdoutTruncated, stderrTruncated, timedOut, outputExceeded });
    });
  });
}
async function checked(argv, options = {}) {
  const result = await run(argv, options);
  if (result.outputExceeded) throw outputLimitError(`${argv.join(' ')} exceeded output limit.`);
  if (result.exitCode !== 0) {
    const error = new Error(`${argv.join(' ')} failed with ${result.exitCode}: ${result.stderr.toString('utf8') || result.stdout.toString('utf8')}`);
    error.result = result;
    throw error;
  }
  return result;
}
async function checkedText(argv, options = {}) {
  const result = await checked(argv, { stdoutLimit: plumbingLimit(), stderrLimit: plumbingLimit(), failOnLimit: true, ...options });
  return result.stdout.toString('utf8');
}
async function checkedBuffer(argv, options = {}) {
  const result = await checked(argv, { stdoutLimit: plumbingLimit(), stderrLimit: plumbingLimit(), failOnLimit: true, ...options });
  return result.stdout;
}
async function gitDiffToFile(args, target, options = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = fs.createWriteStream(target, { flags: 'w' });
    const child = spawn('git', args, { cwd: options.cwd, env: safeEnv(options.env), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = Buffer.alloc(0);
    let bytes = 0;
    let exceeded = false;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > plumbingLimit()) {
        exceeded = true;
        killChildTree(child);
        child.stdout.destroy();
        return;
      }
      out.write(chunk);
    });
    child.stderr.on('data', chunk => {
      const next = appendLimited(stderr, chunk, plumbingLimit(), true);
      stderr = next.buffer;
      if (next.exceeded) {
        exceeded = true;
        killChildTree(child);
      }
    });
    child.on('error', error => {
      out.destroy();
      reject(error);
    });
    child.on('close', code => {
      out.end(() => {
        if (exceeded) return reject(outputLimitError(`git diff exceeded output limit.`));
        if (code !== 0) return reject(new Error(`git diff failed with ${code}: ${stderr.toString('utf8')}`));
        resolve();
      });
    });
  });
}
function ensureEmptyDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) throw new Error('Output directory must be empty before integration starts.');
}
function resolveArtifact(root, rel) {
  if (typeof rel !== 'string' || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(rel) || rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) {
    throw new Error(`unsafe artifact path: ${rel}`);
  }
  const target = path.resolve(root, ...rel.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`artifact path escapes root: ${rel}`);
  return target;
}
function normalizedPatchForGit(patchFile, workDir, taskId) {
  const bytes = fs.readFileSync(patchFile);
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0a) return patchFile;
  const normalized = path.join(workDir, `.integration-${safeName(taskId)}.patch`);
  fs.writeFileSync(normalized, Buffer.concat([bytes, Buffer.from('\n')]));
  return normalized;
}
function scanTreeForTokens(root) {
  const violations = [];
  function scanText(label, value) {
    if (TOKEN_PATTERN.test(value)) violations.push(label);
  }
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, full));
      scanText(rel, rel);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) scanText(rel, fs.readFileSync(full).toString('utf8'));
    }
  }
  walk(root);
  return violations;
}
function topologicalTasks(tasks) {
  const byId = new Map(tasks.map(task => [task.task_id, task]));
  const remaining = new Set(byId.keys());
  const done = new Set();
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => (byId.get(id).dependencies || []).every(dep => done.has(dep.task_id))).sort();
    if (!ready.length) throw new Error(`integration dependency cycle or missing dependency among: ${[...remaining].sort().join(', ')}`);
    for (const id of ready) {
      remaining.delete(id);
      done.add(id);
      ordered.push(byId.get(id));
    }
  }
  return ordered;
}
function parseNulPaths(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}
function normalizeRepoPath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}
function pathTouchesGitDir(value) {
  const normalized = normalizeRepoPath(value);
  return normalized === '.git' || normalized.startsWith('.git/');
}
function parseRawDiff(buffer) {
  const parts = buffer.toString('utf8').split('\0').filter(Boolean);
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
async function writeTree(cwd) {
  return (await checkedText(['git', 'write-tree'], { cwd })).trim();
}
async function patchDelta(cwd, beforeTree, afterTree) {
  const names = parseNulPaths(await checkedBuffer(['git', 'diff', '--no-renames', '-z', '--name-only', beforeTree, afterTree], { cwd }));
  const raw = parseRawDiff(await checkedBuffer(['git', 'diff-tree', '-r', '--no-renames', '--raw', '-z', beforeTree, afterTree], { cwd }));
  return { paths: [...new Set(names)], entries: raw };
}
async function patchPathsFromNumstat(patchFile, cwd) {
  const buffer = await checkedBuffer(['git', 'apply', '--numstat', '-z', patchFile], { cwd });
  const parts = buffer.toString('utf8').split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < parts.length; index++) {
    const token = parts[index];
    const fields = token.split('\t');
    if (fields.length >= 3) paths.push(fields[2]);
    else if (fields.length >= 2 && index + 1 < parts.length) paths.push(parts[++index]);
  }
  return [...new Set(paths.filter(Boolean))];
}
function validateDeltaPolicy(delta, task) {
  const violations = [];
  for (const changedPath of delta.paths) {
    if (pathTouchesGitDir(changedPath)) violations.push(`${changedPath}: .git paths are not allowed`);
  }
  for (const entry of delta.entries) {
    const modes = [entry.oldMode, entry.newMode];
    if (modes.includes('120000')) violations.push(`${entry.paths.join(',')}: symlinks are not allowed`);
    if (modes.includes('160000')) violations.push(`${entry.paths.join(',')}: gitlinks are not allowed`);
    const oldExec = entry.oldMode !== '000000' && entry.oldMode.endsWith('755');
    const newExec = entry.newMode !== '000000' && entry.newMode.endsWith('755');
    if (!oldExec && newExec && task.allow_executable_bits !== 'true') {
      violations.push(`${entry.paths.join(',')}: executable mode changes are not allowed`);
    }
  }
  return violations;
}
async function cachedChangedPaths(cwd, baseline) {
  return parseNulPaths(await checkedBuffer(['git', 'diff', '--cached', '--no-renames', '-z', '--name-only', baseline], { cwd }));
}
async function worktreeSnapshot(cwd) {
  const indexTree = await writeTree(cwd);
  return {
    indexTree,
    worktreeSha: fingerprintTree(cwd, { skipGitDir: true }),
    gitStateSha: fingerprintGitState(cwd)
  };
}
function sameSnapshot(left, right) {
  return left.indexTree === right.indexTree && left.worktreeSha === right.worktreeSha && left.gitStateSha === right.gitStateSha;
}
function fingerprintTree(root, options = {}) {
  const hash = crypto.createHash('sha256');
  function add(value) { hash.update(String(value)); hash.update('\0'); }
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (options.skipGitDir && dir === root && entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, full));
      const stat = fs.lstatSync(full);
      add(rel);
      add((stat.mode & 0o777777).toString(8));
      if (entry.isDirectory()) {
        add('dir');
        walk(full);
      } else if (entry.isSymbolicLink()) {
        add('symlink');
        add(fs.readlinkSync(full));
      } else if (entry.isFile()) {
        add('file');
        hash.update(fs.readFileSync(full));
        hash.update('\0');
      } else {
        add('other');
      }
    }
  }
  walk(root);
  return hash.digest('hex');
}
function fingerprintGitState(cwd) {
  const gitDir = path.join(cwd, '.git');
  const hash = crypto.createHash('sha256');
  for (const rel of ['config', 'hooks', 'info']) {
    const full = path.join(gitDir, rel);
    if (fs.existsSync(full)) {
      hash.update(rel);
      hash.update('\0');
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) hash.update(fingerprintTree(full));
      else if (stat.isFile()) hash.update(fs.readFileSync(full));
      else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(full));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}
async function materializeTreeCopy({ cwd, tree, parent, label, homeDir }) {
  const checkRoot = fs.mkdtempSync(path.join(parent, `.integration-check-${safeName(label)}.`));
  const indexFile = path.join(parent, `.integration-check-${safeName(label)}.index`);
  try {
    const materializeTree = process.env.SQUAD_INTEGRATION_TEST_MATERIALIZE_TREE || tree;
    await checked(['git', 'read-tree', materializeTree], { cwd, env: { HOME: homeDir, GIT_INDEX_FILE: indexFile } });
    await checked(['git', `--work-tree=${checkRoot}`, 'checkout-index', '-a', '-f'], { cwd, env: { HOME: homeDir, GIT_INDEX_FILE: indexFile } });
    assertNoMaterializedSymlinks(checkRoot);
    try { fs.rmSync(indexFile, { force: true }); } catch { /* best effort */ }
    return checkRoot;
  } catch (error) {
    try { fs.rmSync(indexFile, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(checkRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}
async function treeSpecialEntries(cwd, tree) {
  const buffer = await checkedBuffer(['git', 'ls-tree', '-r', '-z', '--full-tree', tree], { cwd });
  const entries = [];
  for (const record of buffer.toString('utf8').split('\0')) {
    if (!record) continue;
    const match = /^(\d{6})\s+\S+\s+[0-9a-f]+\t(.+)$/.exec(record);
    if (match && (match[1] === '120000' || match[1] === '160000')) entries.push({ mode: match[1], path: match[2] });
  }
  return entries;
}
function assertNoMaterializedSymlinks(root) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        const rel = toPosix(path.relative(root, full));
        const error = new Error(`materialized check tree contains symlink: ${rel}`);
        error.code = 'check_tree_contains_symlink';
        throw error;
      }
      if (stat.isDirectory()) walk(full);
    }
  }
  walk(root);
}
function buildResult(envelope, status, taskStatuses, artifacts, options = {}) {
  const result = {
    schema_version: envelope.schema_version,
    message_type: 'integration.result',
    run_id: envelope.run_id,
    provider: envelope.provider,
    baseline_sha: envelope.baseline_sha,
    roster: envelope.roster,
    status,
    tasks: envelope.tasks.map(task => ({
      task_id: task.task_id,
      status: taskStatuses.get(task.task_id) || (status === 'succeeded' ? 'succeeded' : 'skipped'),
      owner: task.owner,
      result_ref: task.patch_ref.path
    })),
    artifacts,
    check_results: options.checkResults || []
  };
  if (options.failedTaskId) result.failed_task_id = options.failedTaskId;
  if (options.error) result.error = options.error;
  return result;
}
async function publish({ envelope, outputDir, stagingDir, status, taskStatuses, artifacts, checkResults, failedTaskId, error }) {
  const result = buildResult(envelope, status, taskStatuses, artifacts.map(({ path: _path, size_bytes: _size, ...artifact }) => artifact), { checkResults, failedTaskId, error });
  writeJson(path.join(stagingDir, 'integration-result.json'), result);
  const manifestArtifacts = [
    ...artifacts.map(({ uri: _uri, ...artifact }) => artifact),
    {
      artifact_id: 'integration-result',
      kind: 'other',
      path: 'integration-result.json',
      sha256: sha256File(path.join(stagingDir, 'integration-result.json')),
      size_bytes: fs.statSync(path.join(stagingDir, 'integration-result.json')).size
    }
  ];
  const manifest = {
    schema_version: envelope.schema_version,
    run_id: envelope.run_id,
    task_id: 'integration',
    baseline_sha: envelope.baseline_sha,
    roster: envelope.roster,
    provider: envelope.provider,
    artifacts: manifestArtifacts
  };
  writeJson(path.join(stagingDir, 'artifact-manifest.json'), manifest);
  const resultValidation = validateContract('integration-result.schema.json', result);
  if (!resultValidation.valid) throw new Error(`internal integration-result validation failed: ${resultValidation.errors.join('; ')}`);
  const manifestValidation = validateContract('artifact-manifest.schema.json', manifest);
  if (!manifestValidation.valid) throw new Error(`internal artifact-manifest validation failed: ${manifestValidation.errors.join('; ')}`);
  const leaks = scanTreeForTokens(stagingDir);
  if (leaks.length) throw new Error(`token pattern detected in integration artifacts: ${leaks.join(', ')}`);
  if (fs.readdirSync(outputDir).length > 0) throw new Error('Output directory was modified before integration publish.');
  for (const entry of fs.readdirSync(stagingDir)) fs.renameSync(path.join(stagingDir, entry), path.join(outputDir, entry));
}
async function failAndPublish(context, code, message, failedTaskId = '') {
  const taskStatuses = context.taskStatuses || new Map();
  if (failedTaskId) taskStatuses.set(failedTaskId, 'failed');
  await publish({
    ...context,
    status: 'failed',
    taskStatuses,
    artifacts: [],
    failedTaskId,
    error: { code, message }
  });
  process.exitCode = 1;
}
async function main() {
  for (const key of Object.keys(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|PAT$/i.test(key)) delete process.env[key];
  }
  const dispatchPath = path.resolve(process.argv[2] || process.env.SQUAD_INTEGRATION_DISPATCH_PATH || '');
  const bundlePath = path.resolve(process.argv[3] || process.env.SQUAD_BASELINE_BUNDLE_PATH || '');
  const outputDir = path.resolve(process.argv[4] || process.env.SQUAD_OUTPUT_DIR || '');
  if (!dispatchPath || !bundlePath || !outputDir) throw new Error('Usage: integrate-runner.js <integration-dispatch> <baseline-bundle> <output-dir>');
  plumbingLimit();
  ensureEmptyDir(outputDir);
  const parent = path.dirname(outputDir);
  const stagingDir = process.env.SQUAD_INTEGRATION_ARTIFACTS_DIR
    ? path.resolve(process.env.SQUAD_INTEGRATION_ARTIFACTS_DIR)
    : fs.mkdtempSync(path.join(parent, '.integration-artifacts.'));
  const workDir = process.env.SQUAD_INTEGRATION_WORKTREE_DIR
    ? path.resolve(process.env.SQUAD_INTEGRATION_WORKTREE_DIR)
    : fs.mkdtempSync(path.join(parent, '.integration-worktree.'));
  const homeDir = process.env.SQUAD_INTEGRATION_HOME_DIR
    ? path.resolve(process.env.SQUAD_INTEGRATION_HOME_DIR)
    : fs.mkdtempSync(path.join(parent, '.integration-home.'));
  for (const dir of [stagingDir, workDir, homeDir]) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readdirSync(dir).length > 0) throw new Error(`Integration temp directory is not empty: ${dir}`);
  }
  const envelope = readJson(dispatchPath);
  const taskStatuses = new Map(envelope.tasks.map(task => [task.task_id, 'skipped']));
  const context = { envelope, outputDir, stagingDir, taskStatuses, checkResults: [] };
  try {
    const validation = validateContract('integration-dispatch.schema.json', envelope);
    if (!validation.valid) return await failAndPublish(context, 'INTEGRATION_DISPATCH_INVALID', validation.errors.join('; '));
    await checked(['git', 'clone', '--no-checkout', bundlePath, workDir], { cwd: parent, env: { HOME: homeDir } });
    await checked(['git', 'checkout', '--detach', envelope.baseline_sha], { cwd: workDir, env: { HOME: homeDir } });
    const head = (await checkedText(['git', 'rev-parse', 'HEAD'], { cwd: workDir })).trim();
    if (head !== envelope.baseline_sha) return await failAndPublish(context, 'BASELINE_SHA_MISMATCH', `Checked-out HEAD ${head} does not equal ${envelope.baseline_sha}.`);
    const clean = await checkedBuffer(['git', 'status', '--porcelain=v1', '-z'], { cwd: workDir });
    if (clean.length) return await failAndPublish(context, 'DIRTY_BASELINE', 'Integration worktree was not clean at baseline.');
    const seenPaths = new Map();
    const dispatchDir = path.dirname(dispatchPath);
    const ordered = topologicalTasks(envelope.tasks);
    for (const task of ordered) {
      const patchFile = resolveArtifact(dispatchDir, task.patch_ref.path);
      if (!fs.existsSync(patchFile)) return await failAndPublish(context, 'PATCH_NOT_FOUND', `Patch file not found for ${task.task_id}.`, task.task_id);
      const actualSha = sha256File(patchFile);
      if (actualSha !== task.patch_ref.sha256.toLowerCase()) return await failAndPublish(context, 'PATCH_SHA_MISMATCH', `Patch sha256 mismatch for ${task.task_id}.`, task.task_id);
      const applyPatchFile = normalizedPatchForGit(patchFile, workDir, task.task_id);
      let preliminaryPaths;
      try {
        preliminaryPaths = await patchPathsFromNumstat(applyPatchFile, workDir);
      } catch (error) {
        if (error.code === 'output_limit_exceeded') return await failAndPublish(context, 'output_limit_exceeded', error.message, task.task_id);
        return await failAndPublish(context, 'PATCH_PATH_PARSE_FAILED', error.message, task.task_id);
      }
      for (const changedPath of preliminaryPaths) {
        if (seenPaths.has(changedPath)) return await failAndPublish(context, 'OVERLAPPING_PATCH_PATH', `Path ${changedPath} is changed by both ${seenPaths.get(changedPath)} and ${task.task_id}.`, task.task_id);
      }
      const applyArgs = ['git', 'apply', '--check'];
      if (envelope.allow_3way === 'true') applyArgs.push('--3way');
      applyArgs.push(applyPatchFile);
      const check = await run(applyArgs, { cwd: workDir, env: { HOME: homeDir }, stdoutLimit: plumbingLimit(), stderrLimit: plumbingLimit(), failOnLimit: true });
      if (check.outputExceeded) return await failAndPublish(context, 'output_limit_exceeded', `Patch ${task.task_id} apply check exceeded output limit.`, task.task_id);
      if (check.exitCode !== 0) return await failAndPublish(context, 'PATCH_APPLY_CHECK_FAILED', `Patch ${task.task_id} failed git apply --check: ${check.stderr.toString('utf8') || check.stdout.toString('utf8')}`, task.task_id);
      const beforeTree = await writeTree(workDir);
      const indexArgs = ['git', 'apply', '--index'];
      if (envelope.allow_3way === 'true') indexArgs.push('--3way');
      indexArgs.push(applyPatchFile);
      const applied = await run(indexArgs, { cwd: workDir, env: { HOME: homeDir }, stdoutLimit: plumbingLimit(), stderrLimit: plumbingLimit(), failOnLimit: true });
      if (applied.outputExceeded) return await failAndPublish(context, 'output_limit_exceeded', `Patch ${task.task_id} apply exceeded output limit.`, task.task_id);
      if (applied.exitCode !== 0) return await failAndPublish(context, 'PATCH_APPLY_FAILED', `Patch ${task.task_id} failed git apply --index: ${applied.stderr.toString('utf8') || applied.stdout.toString('utf8')}`, task.task_id);
      const afterTree = await writeTree(workDir);
      const delta = await patchDelta(workDir, beforeTree, afterTree);
      if (!delta.paths.length) return await failAndPublish(context, 'EMPTY_PATCH_DELTA', `Patch ${task.task_id} did not change the index.`, task.task_id);
      const policyViolations = validateDeltaPolicy(delta, task);
      if (policyViolations.length) return await failAndPublish(context, 'PATCH_CONTENT_POLICY_VIOLATION', `Task ${task.task_id} patch changed disallowed content: ${policyViolations.join('; ')}.`, task.task_id);
      const scope = validateChangedPaths(delta.paths, task.owned_paths || []);
      if (scope.violations.length) return await failAndPublish(context, 'PATH_OWNERSHIP_VIOLATION', `Task ${task.task_id} patch changed disallowed paths: ${JSON.stringify(scope)}.`, task.task_id);
      for (const changedPath of delta.paths) {
        if (seenPaths.has(changedPath)) return await failAndPublish(context, 'OVERLAPPING_PATCH_PATH', `Path ${changedPath} is changed by both ${seenPaths.get(changedPath)} and ${task.task_id}.`, task.task_id);
      }
      const cachedPaths = await cachedChangedPaths(workDir, envelope.baseline_sha);
      for (const changedPath of delta.paths) {
        if (!cachedPaths.includes(changedPath)) return await failAndPublish(context, 'PATCH_PATH_NOT_APPLIED', `Patch path ${changedPath} was not present in the applied index.`, task.task_id);
        seenPaths.set(changedPath, task.task_id);
      }
      taskStatuses.set(task.task_id, 'succeeded');
    }
    fs.mkdirSync(path.join(stagingDir, 'patches'), { recursive: true });
    const patchRel = 'patches/integrated.patch';
    const patchPath = path.join(stagingDir, 'patches', 'integrated.patch');
    try {
      await gitDiffToFile(['diff', '--binary', '--cached', envelope.baseline_sha], patchPath, { cwd: workDir, env: { HOME: homeDir } });
    } catch (error) {
      if (error.code === 'output_limit_exceeded') return await failAndPublish(context, 'output_limit_exceeded', 'Integrated patch exceeded output limit.');
      throw error;
    }
    const preCheckSnapshot = await worktreeSnapshot(workDir);
    const preCheckTree = preCheckSnapshot.indexTree;
    const integratedSha = sha256File(patchPath);
    const checkResults = [];
    if ((envelope.check_commands || []).length) {
      const specialEntries = await treeSpecialEntries(workDir, preCheckTree);
      if (specialEntries.length) {
        const details = specialEntries.map(entry => `${entry.path}: mode ${entry.mode}`).join('; ');
        return await failAndPublish(context, 'check_tree_contains_symlink', `Integration check commands cannot run because the integrated tree contains symlinks or gitlinks: ${details}.`);
      }
    }
    for (const command of envelope.check_commands || []) {
      if (!Array.isArray(command.argv)) return await failAndPublish(context, 'CHECK_COMMAND_INVALID', `Check command ${command.name} argv must be an array.`);
      const checkRoot = await materializeTreeCopy({ cwd: workDir, tree: preCheckTree, parent, label: command.name, homeDir });
      const checkHome = fs.mkdtempSync(path.join(parent, `.integration-check-home-${safeName(command.name)}.`));
      try {
        const checkEnv = { HOME: checkHome };
        if (process.env.SQUAD_INTEGRATION_TEST_EXPOSE_SOURCE_REPO === '1') {
          checkEnv.SQUAD_INTEGRATION_TEST_SOURCE_REPO_PATH = workDir;
        }
        const result = await run(command.argv, { cwd: checkRoot, timeoutMs: command.timeout_ms || 120000, env: checkEnv, detached: true, stdoutLimit: CHECK_CAPTURE, stderrLimit: CHECK_CAPTURE });
        const checkResult = {
          name: command.name,
          status: result.exitCode === 0 ? 'succeeded' : 'failed',
          exit_code: result.exitCode,
          stdout: result.stdout.toString('utf8'),
          stderr: result.stderr.toString('utf8'),
          timed_out: result.timedOut ? 'true' : 'false',
          truncated: result.stdoutTruncated || result.stderrTruncated
        };
        checkResults.push(checkResult);
        const postCheckSnapshot = await worktreeSnapshot(workDir);
        if (!sameSnapshot(preCheckSnapshot, postCheckSnapshot)) {
          context.checkResults = checkResults;
          return await failAndPublish(context, 'checks_mutated_tree', `Check command ${command.name} modified the integration index, worktree, or git metadata.`);
        }
        if (result.exitCode !== 0) {
          context.checkResults = checkResults;
          return await failAndPublish(context, 'CHECK_COMMAND_FAILED', `Check command ${command.name} failed with exit code ${result.exitCode}.`);
        }
      } finally {
        fs.rmSync(checkRoot, { recursive: true, force: true });
        fs.rmSync(checkHome, { recursive: true, force: true });
      }
    }
    const artifacts = [{ artifact_id: 'integration-patch', kind: 'patch', path: patchRel, uri: patchRel, sha256: integratedSha, size_bytes: fs.statSync(patchPath).size }];
    await publish({ envelope, outputDir, stagingDir, status: 'succeeded', taskStatuses, artifacts, checkResults });
  } catch (error) {
    if (error.code === 'output_limit_exceeded') return await failAndPublish(context, 'output_limit_exceeded', error.message);
    throw error;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
