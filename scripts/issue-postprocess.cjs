'use strict';

// Repo-trusted post-integration formatting: argv-only allowlisted tools, bounded timeouts, and per-step path scopes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ALLOWED_TOOLS = new Set(['terraform', 'terraform-docs', 'node']);
const TOOL_KEYS = new Set(['terraform', 'terraform_docs']);
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_STEPS = 10;
const DENIED_ROOTS = ['.github', '.squad', 'dispatcher', 'scripts', 'infra'];

function fail(message) { throw new Error(message); }
function validPathPattern(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || /[\x00-\x1f\x7f]/u.test(value)) return false;
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.endsWith('.')) || /[*?]/u.test(segments[0])) return false;
  const root = segments[0].replace(/[?*].*$/u, '').toLowerCase();
  return !DENIED_ROOTS.some(denied => root === denied || root.startsWith(`${denied}/`));
}
function globToRegExp(pattern) {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; result += '(?:.*/)?'; }
        else result += '.*';
      } else result += '[^/]*';
    } else if (char === '?') result += '[^/]';
    else result += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${result}$`, 'u');
}
function pathMatches(pattern, file) { return globToRegExp(pattern).test(file); }
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== 1 || Object.keys(config).some(key => !['version', 'tools', 'steps'].includes(key))) fail('POSTPROCESS_CONFIG_INVALID version');
  if (!config.tools || typeof config.tools !== 'object' || Array.isArray(config.tools)) fail('POSTPROCESS_CONFIG_INVALID tools');
  for (const [key, version] of Object.entries(config.tools)) {
    if (!TOOL_KEYS.has(key) || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) fail(`POSTPROCESS_CONFIG_INVALID tool ${key}`);
  }
  if (!Array.isArray(config.steps) || config.steps.length > MAX_STEPS) fail('POSTPROCESS_CONFIG_INVALID steps');
  const names = new Set();
  for (const [index, step] of config.steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).some(key => !['name', 'run', 'paths', 'timeout_ms'].includes(key))) fail(`POSTPROCESS_CONFIG_INVALID step ${index}`);
    if (typeof step.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(step.name) || names.has(step.name)) fail(`POSTPROCESS_CONFIG_INVALID step ${index} name`);
    names.add(step.name);
    if (!Array.isArray(step.run) || step.run.length < 1 || step.run.some(arg => typeof arg !== 'string' || /[\x00\r\n]/u.test(arg))) fail(`POSTPROCESS_CONFIG_INVALID step ${step.name} run`);
    const executable = step.run[0];
    if (!ALLOWED_TOOLS.has(executable)) fail(`POSTPROCESS_CONFIG_INVALID executable ${executable}`);
    const unsafeArgument = step.run.slice(1).some(arg => {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
      return /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value) || /^(?:[\\/]|[A-Za-z]:[\\/])/u.test(value);
    });
    if (unsafeArgument) fail(`POSTPROCESS_CONFIG_INVALID step ${step.name} path traversal`);
    if (executable === 'terraform' && !config.tools.terraform) fail(`POSTPROCESS_CONFIG_INVALID terraform version missing`);
    if (executable === 'terraform-docs' && !config.tools.terraform_docs) fail(`POSTPROCESS_CONFIG_INVALID terraform_docs version missing`);
    if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || step.timeout_ms < 1000 || step.timeout_ms > MAX_TIMEOUT_MS)) fail(`POSTPROCESS_CONFIG_INVALID step ${step.name} timeout_ms`);
    if (!Array.isArray(step.paths) || step.paths.length < 1 || step.paths.some(pattern => !validPathPattern(pattern))) fail(`POSTPROCESS_CONFIG_INVALID step ${step.name} paths`);
  }
  return config;
}
function selectSteps(config, touchedPaths) {
  const normalized = touchedPaths.map(file => file.replace(/\\/g, '/'));
  return config.steps.filter(step => normalized.some(file => step.paths.some(pattern => pathMatches(pattern, file))));
}
function findScopeViolations(before, after, step) {
  const changed = new Set([...before.keys(), ...after.keys()]);
  const outOfScope = [];
  for (const file of changed) {
    if (before.get(file) === after.get(file)) continue;
    if (!step.paths.some(pattern => pathMatches(pattern, file))) outOfScope.push(file);
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
    if (stat.isSymbolicLink()) result.set(name, `symlink:${fs.readlinkSync(absolute)}`);
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

  const configPath = path.join(repo, '.squad', 'sandbox-postprocess.json');
  let config = null;
  if (fs.existsSync(configPath)) config = validateConfig(readJson(configPath));
  const touched = config ? patchTouchedPaths(repo, manifest.baseline_sha, patchBytes) : [];
  const selected = config ? selectSteps(config, touched) : [];
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
      const result = spawnSync(step.run[0], step.run.slice(1), { cwd: repo, stdio: 'inherit', shell: false, timeout: step.timeout_ms || DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      if (result.error || result.status !== 0) fail(`POSTPROCESS_STEP_FAILED ${step.name}${result.error?.code === 'ETIMEDOUT' ? '_TIMEOUT' : ''}`);
      const violations = findScopeViolations(before, snapshot(repo), step);
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
    const configPath = path.join(repo, '.squad', 'sandbox-postprocess.json');
    const config = fs.existsSync(configPath) ? validateConfig(readJson(configPath)) : { version: 1, tools: {}, steps: [] };
    for (const key of ['terraform', 'terraform_docs']) { const line = `${key}=${config.tools[key] || ''}\n`; if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line); else process.stdout.write(line); }
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
