'use strict';

// Repo-trusted post-integration steps use pinned tools, bounded timeouts, and per-step path scopes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { loadConfig, validateConfig: validateFlowConfig, validPathPattern, globToRegExp, isDeniedPath } = require('./sandbox-flow-config.cjs');
const DEFAULT_TIMEOUT_MS = 120000;

function fail(message) { throw new Error(message); }
function pathMatches(pattern, file) { return globToRegExp(pattern).test(file); }
function validateConfig(config) {
  validateFlowConfig(config);
  return config.postprocess || { tools: {}, steps: [] };
}
function selectSteps(config, touchedPaths) {
  const normalized = touchedPaths.map(file => file.replace(/\\/g, '/'));
  return config.steps.filter(step => normalized.some(file => step.paths.some(pattern => pathMatches(pattern, file))));
}
function findScopeViolations(before, after, step, root = process.cwd()) {
  const changed = new Set([...before.keys(), ...after.keys()]);
  const outOfScope = [];
  for (const file of changed) {
    if (before.get(file) === after.get(file)) continue;
    if (isDeniedPath(file, root) || !step.paths.some(pattern => pathMatches(pattern, file))) outOfScope.push(file);
  }
  return outOfScope.sort();
}
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function git(repo, args, options = {}) {
  const result = spawnSync('git', args, { cwd: repo, encoding: options.encoding === null ? null : (options.encoding || 'utf8'), maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`POSTPROCESS_GIT_FAILED ${result.error?.message || result.stderr || args.join(' ')}`);
  return result.stdout;
}
function snapshot(repo) {
  const names = git(repo, ['ls-files', '-co', '--exclude-standard']).split(/\r?\n/u).filter(Boolean);
  const result = new Map();
  for (const name of names) {
    const absolute = path.resolve(repo, name);
    if (!absolute.startsWith(`${path.resolve(repo)}${path.sep}`)) fail('POSTPROCESS_SCOPE_VIOLATION path escaped repository');
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { result.set(name, '<deleted>'); continue; }
    if (stat.isSymbolicLink()) {
      let target;
      try { target = fs.realpathSync(absolute); } catch { fail('POSTPROCESS_SCOPE_VIOLATION symlink target unresolved'); }
      const relativeTarget = path.relative(path.resolve(repo), target);
      if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) fail('POSTPROCESS_SCOPE_VIOLATION symlink escaped repository');
      result.set(name, `symlink:${fs.readlinkSync(absolute)}`);
    }
    else if (stat.isFile()) result.set(name, hash(fs.readFileSync(absolute)));
    else result.set(name, `type:${stat.mode}`);
  }
  return result;
}
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '').replace(/-/g, '_');
    if (!argv[i]?.startsWith('--') || result[key] !== undefined || !argv[i + 1]) fail('POSTPROCESS_ARGUMENTS_INVALID');
    result[key] = argv[i + 1];
  }
  return result;
}
function contained(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('POSTPROCESS_ARTIFACT_PATH_INVALID');
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) fail('POSTPROCESS_ARTIFACT_PATH_INVALID');
  return absolute;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function runPostprocess({ artifactDir, repo, outputDir, runId, runAttempt }) {
  const inputSummaryFile = path.join(artifactDir, 'dispatcher-summary.json');
  const summary = readJson(inputSummaryFile);
  const manifestFile = path.join(artifactDir, 'integration', 'artifact-manifest.json');
  const manifest = readJson(manifestFile);
  const patchRel = summary.integration?.integrated_patch_path;
  const inputPatch = contained(artifactDir, patchRel);
  const patchBytes = fs.readFileSync(inputPatch);
  const patchSha = hash(patchBytes);
  const patchEntry = manifest.artifacts?.find(item => item.kind === 'patch');
  if (manifest.task_id !== 'integration' || manifest.run_id !== summary.run_id || !manifest.baseline_sha ||
      manifest.baseline_sha !== summary.baseline_sha && summary.baseline_sha ||
      patchEntry?.sha256?.toLowerCase() !== patchSha || summary.integration.sha256?.toLowerCase() !== patchSha ||
      `integration/${patchEntry?.path}` !== patchRel.replace(/\\/g, '/')) fail('POSTPROCESS_INPUT_INTEGRITY_FAILED');

  const fullConfig = loadConfig(repo);
  const config = validateConfig(fullConfig);
  const touched = config.steps.length ? patchTouchedPaths(repo, manifest.baseline_sha, patchBytes) : [];
  const selected = selectSteps(config, touched);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.cpSync(artifactDir, outputDir, { recursive: true, dereference: false });
  let finalBytes = patchBytes;
  if (selected.length) {
    const status = git(repo, ['status', '--porcelain', '--untracked-files=all']);
    if (process.env.SQUAD_REVISE_CONTEXT) {
      const { readContext, validateBaseline } = require('./issue-revise.cjs');
      const context = readContext(process.env.SQUAD_REVISE_CONTEXT, process.env.GITHUB_REPOSITORY, process.env.SQUAD_ISSUE_NUMBER);
      validateBaseline(repo, context);
      if (manifest.baseline_sha !== context.head_sha || git(repo, ['write-tree']).trim() !== git(repo, ['rev-parse', `${context.head_sha}^{tree}`]).trim()) fail('REVISE_POSTPROCESS_BASELINE_MISMATCH');
      git(repo, ['diff', '--exit-code']);
    } else if (status.trim()) fail('POSTPROCESS_CHECKOUT_NOT_CLEAN');
    const patchFile = path.join(artifactDir, ...patchRel.split('/'));
    git(repo, ['apply', '--index', '--binary', '--whitespace=nowarn', patchFile]);
    for (const step of selected) {
      const before = snapshot(repo);
      const executable = step.run[0] === 'node' ? process.execPath : step.run[0];
      const result = spawnSync(executable, step.run.slice(1), { cwd: repo, stdio: 'inherit', shell: false, timeout: step.timeout_ms || DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      if (result.error || result.status !== 0) fail(`POSTPROCESS_STEP_FAILED ${step.name}${result.error?.code === 'ETIMEDOUT' ? '_TIMEOUT' : ''}`);
      const violations = findScopeViolations(before, snapshot(repo), step, repo);
      if (violations.length) fail(`POSTPROCESS_SCOPE_VIOLATION ${step.name}: ${violations.join(', ')}`);
    }
    git(repo, ['add', '--all']);
    finalBytes = git(repo, ['diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-ext-diff', manifest.baseline_sha], { encoding: null });
    if (!Buffer.isBuffer(finalBytes)) finalBytes = Buffer.from(finalBytes || '');
  }
  const outputPatch = contained(outputDir, patchRel);
  fs.writeFileSync(outputPatch, finalBytes);
  const finalSha = hash(finalBytes);
  summary.integration.sha256 = finalSha;
  summary.baseline_sha = manifest.baseline_sha;
  manifest.artifacts = manifest.artifacts.map(item => item.kind === 'patch' ? { ...item, sha256: finalSha, size_bytes: finalBytes.length } : item);
  fs.writeFileSync(path.join(outputDir, 'dispatcher-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'integration', 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'postprocess-binding.json'), `${JSON.stringify({
    schema_version: 1, run_id: String(runId), run_attempt: String(runAttempt), execution_id: summary.run_id,
    baseline_sha: manifest.baseline_sha, patch_sha256: finalSha
  }, null, 2)}\n`);
  console.log(`POSTPROCESS_RESULT selected=${selected.map(step => step.name).join(',') || 'none'} sha256=${finalSha}`);
}
function patchTouchedPaths(repo, baseline, patchBytes) {
  const check = spawnSync('git', ['apply', '--numstat', '--'], { cwd: repo, input: patchBytes, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (check.error || check.status !== 0) fail('POSTPROCESS_PATCH_INVALID');
  const names = new Set();
  for (const row of (check.stdout || '').split(/\r?\n/u)) {
    const name = row.split('\t').at(-1);
    if (name && name !== '-') names.add(name);
  }
  return [...names];
}
function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'validate') {
    const args = parseArgs(argv);
    const repo = path.resolve(args.repo || process.cwd());
    const config = validateConfig(loadConfig(repo));
    if (!process.env.GITHUB_OUTPUT) process.stdout.write(`tools=${Object.keys(config.tools).length}\n`);
    return;
  }
  if (command !== 'run') fail('POSTPROCESS_COMMAND_INVALID');
  const args = parseArgs(argv);
  const repo = path.resolve(args.repo || process.cwd());
  if (!args.artifact || !args.output || !args.run_id || !args.run_attempt) fail('POSTPROCESS_ARGUMENTS_INVALID');
  runPostprocess({ artifactDir: path.resolve(args.artifact), repo, outputDir: path.resolve(args.output), runId: args.run_id, runAttempt: args.run_attempt });
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateConfig, validPathPattern, pathMatches, selectSteps, findScopeViolations, runPostprocess };
