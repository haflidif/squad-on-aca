#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = 'haflidif/squad-on-aca';
const MANIFEST = '.squad/aca-installation.json';
const RECEIPT_HASH = '.squad/aca-installation.sha256';
const WORKFLOWS = ['squad-router.yml', 'squad-queue.yml', 'squad-sandbox-issue.yml', 'squad-sandbox-conflicts.yml'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function command(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${binary} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
  return result.stdout.trim();
}
function parse(args) {
  const options = { backend: 'jobs', preview: false, strict: false, openPr: false };
  const names = { '--version': 'version', '--ref': 'version', '--target': 'target', '--backend': 'backend' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (Object.hasOwn(names, arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[names[arg]] = args[++i];
    } else if (arg === '--preview') options.preview = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--open-pr') options.openPr = true;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}
function validate(value, schema) {
  if (schema.type) {
    const ok = schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'array' ? Array.isArray(value) : typeof value === schema.type;
    if (!ok) throw new Error(`Expected ${schema.type}`);
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const || schema.enum && !schema.enum.includes(value)) throw new Error('Invalid contract value');
  if (typeof value === 'string' && (schema.pattern && !new RegExp(schema.pattern).test(value) || schema.minLength && value.length < schema.minLength)) throw new Error('Invalid contract string');
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems || schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) throw new Error('Invalid contract array');
    if (schema.items) value.forEach(child => validate(child, schema.items));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`Missing ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validate(child, schema.properties[key]);
      else if (schema.additionalProperties === false) throw new Error(`Unknown field ${key}`);
    }
  }
}
function source(version, root) {
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version)) throw new Error('Version must be a full commit SHA or tag (not a branch)');
  const metadataFile = path.join(root, 'release.json');
  if (fs.existsSync(metadataFile)) {
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    if (!/^[0-9a-f]{40}$/.test(metadata.action_sha) || metadata.repository !== SOURCE || ![metadata.release_version, metadata.action_sha].includes(version)) throw new Error('Version does not match this release archive');
    return metadata.action_sha;
  }
  // Source checkout use is local-only: the requested revision must be checked out.
  const sha = command('git', ['rev-parse', '--verify', 'HEAD^{commit}'], root);
  const requested = /^[0-9a-f]{40}$/.test(version) ? version
    : command('git', ['rev-parse', '--verify', `refs/tags/${version}^{commit}`], root);
  if (requested !== sha) throw new Error('Extract the requested release archive, or run from that exact checked-out commit');
  return sha;
}
function inspect(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
    if (stat.isSymbolicLink()) return { blocked: 'symbolic link or junction' };
    if (current !== path.join(root, ...relative.split('/')) && !stat.isDirectory()) return { blocked: 'parent is not a directory' };
  }
  if (!fs.statSync(current).isFile() || fs.statSync(current).nlink > 1) return { blocked: 'not a regular, single-link file' };
  return { exists: true, bytes: fs.readFileSync(current) };
}
function templates(root, sha, backend, freshSquad) {
  const result = new Map();
  for (const name of WORKFLOWS) {
    let content = fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8').replace(/\r\n/g, '\n');
    if (!content.includes('uses: ./.github/actions/sandbox-engine')) throw new Error(`Release workflow has no engine reference: ${name}`);
    content = content.replaceAll('uses: ./.github/actions/sandbox-engine', `uses: ${SOURCE}/.github/actions/sandbox-engine@${sha}`);
    // Do not activate an existing target's router just by installing files.
    if (name === 'squad-router.yml') content = content.replace(/^(    if: )(.+)$/m, "$1vars.SQUAD_EXECUTION_BACKEND != '' && ($2)");
    if (name === 'squad-sandbox-conflicts.yml') content = content.replace('  hint:\n', "  hint:\n    if: vars.SQUAD_EXECUTION_BACKEND == 'sandbox'\n");
    result.set(`.github/workflows/${name}`, content);
  }
  result.set('.squad/execution.json', json({ schema_version: 'backend/v1', platform_id: '/subscriptions/unconfigured/resourceGroups/unconfigured', backend, enabled: false }));
  if (freshSquad) {
    result.set('.squad/team.md', '# Squad team\n\nInitialize Squad in this repository before enabling execution.\nChoose your own members and roles. No application stack is assumed.\n');
    result.set('.squad/sandbox-flow.json', json({ version: 1, members: {}, postprocess: { tools: {}, steps: [] } }));
  }
  return result;
}
function printDiff(relative, current, proposed, log) {
  const before = current.replace(/\r\n/g, '\n').split('\n');
  const after = proposed.split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (start === before.length && start === after.length) { log('Content matches, but this installer does not own the file.'); return; }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  log(`--- current/${relative}\n+++ proposed/${relative}\n@@ -${start + 1},${endBefore - start} +${start + 1},${endAfter - start} @@`);
  before.slice(start, endBefore).forEach(line => log(`-${line}`));
  after.slice(start, endAfter).forEach(line => log(`+${line}`));
}
function install(options, sourceRoot = ROOT, log = console.log, runCommand = command) {
  const { version, backend = 'jobs', preview = false, strict = false, openPr = false } = options;
  if (!options.target) throw new Error('--target is required');
  if (!['jobs', 'sandbox'].includes(backend)) throw new Error('Backend must be jobs or sandbox');
  const root = path.resolve(options.target);
  // Resolve existing ancestors before reading or writing any target content.
  let ancestor = root;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonical = fs.realpathSync(ancestor);
  if (process.platform === 'win32' ? canonical.toLowerCase() !== ancestor.toLowerCase() : canonical !== ancestor) throw new Error('Target ancestors must not contain symbolic links or junctions');
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) throw new Error('Target must be a directory');
  if (root === sourceRoot) throw new Error('Target must be separate from the release source');
  const sha = source(version, sourceRoot);
  const schema = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'contracts', 'backend', 'v1', 'schemas', 'installation.schema.json'), 'utf8'));
  const manifestState = inspect(root, MANIFEST);
  const checksumState = inspect(root, RECEIPT_HASH);
  let previous;
  const blockedReceipt = reason => {
    log(`CONFLICT ${MANIFEST}: ${reason}; skipped all files. Restore the original receipt and checksum before retrying.`);
    return { conflicts: [MANIFEST], changed: [], exitCode: strict ? 1 : 0 };
  };
  if (manifestState.blocked || checksumState.blocked) return blockedReceipt('unsafe receipt path');
  if (manifestState.exists || checksumState.exists) {
    if (!manifestState.exists || !checksumState.exists || checksumState.bytes.toString().trim() !== hash(manifestState.bytes)) return blockedReceipt('receipt or checksum was edited');
    try {
      previous = JSON.parse(manifestState.bytes.toString());
      validate(previous, schema);
      if (new Set(previous.generated_files.map(file => file.path)).size !== previous.generated_files.length) throw new Error('Duplicate ownership path');
    } catch { return blockedReceipt('invalid installation contract'); }
  }
  const old = new Map((previous?.generated_files || []).map(file => [file.path, file.sha256]));
  const squadState = inspect(root, '.squad/team.md');
  const squadExists = fs.existsSync(path.join(root, '.squad'));
  const files = templates(sourceRoot, sha, backend, !squadExists || old.has('.squad/team.md'));
  if (squadState.blocked) return blockedReceipt('unsafe Squad path');
  const changes = [];
  const conflicts = [];
  const ownership = new Map(old);
  for (const [relative, content] of files) {
    const state = inspect(root, relative);
    const wanted = hash(content);
    const current = state.exists ? hash(state.bytes) : undefined;
    // Only an unchanged owned file can be replaced; never adopt pre-existing files.
    if (state.blocked || state.exists && (!old.has(relative) || current !== old.get(relative))) {
      conflicts.push(relative);
      log(`CONFLICT ${relative}: ${state.blocked || 'unowned or user-modified file'}; skipped. Proposed SHA256 ${wanted}`);
      if (state.exists) printDiff(relative, state.bytes.toString(), content, log);
      continue;
    }
    ownership.set(relative, wanted);
    if (current === wanted) log(`KEEP ${relative}`);
    else { changes.push({ relative, content, original: state.exists ? hash(state.bytes) : undefined }); log(`${state.exists ? 'CHANGE' : 'ADD'} ${relative}`); }
  }
  if (!ownership.size) return { conflicts, changed: [], exitCode: strict && conflicts.length ? 1 : 0 };
  const receipt = json({ schema_version: 'backend/v1', ...(previous?.platform_id ? { platform_id: previous.platform_id } : {}), release_version: version, action_sha: sha, backend,
    generated_files: [...ownership].map(([file, sha256]) => ({ path: file, sha256 })).sort((a, b) => a.path.localeCompare(b.path)) });
  validate(JSON.parse(receipt), schema);
  for (const [relative, content, state] of [[MANIFEST, receipt, manifestState], [RECEIPT_HASH, `${hash(receipt)}\n`, checksumState]]) {
    if (!state.exists || !state.bytes.equals(Buffer.from(content))) {
      changes.push({ relative, content, original: state.exists ? hash(state.bytes) : undefined }); log(`${state.exists ? 'CHANGE' : 'ADD'} ${relative}`);
    } else log(`KEEP ${relative}`);
  }
  if (preview) log('PREVIEW: no files, Git branches, commits, or remote settings were changed.');
  else {
    if (openPr && changes.length && !conflicts.length) {
      runCommand('gh', ['--version'], root);
      const gitRoot = path.resolve(runCommand('git', ['rev-parse', '--show-toplevel'], root));
      const sameRoot = process.platform === 'win32' ? gitRoot.toLowerCase() === root.toLowerCase() : gitRoot === root;
      if (!sameRoot || runCommand('git', ['status', '--porcelain', '--untracked-files=all'], root)) throw new Error('--open-pr requires a clean target Git repository root');
    }
    for (const { relative, original } of changes) {
      const state = inspect(root, relative);
      if (state.blocked || (state.exists ? hash(state.bytes) : undefined) !== original) throw new Error(`Target changed during planning: ${relative}`);
    }
    for (const { relative, content } of changes) {
      const file = path.join(root, ...relative.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { flag: inspect(root, relative).exists ? 'w' : 'wx' });
    }
    if (openPr && changes.length && !conflicts.length) {
      const branch = `squad-on-aca/install-${sha.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`;
      runCommand('git', ['switch', '-c', branch], root);
      runCommand('git', ['add', '--', ...changes.map(change => change.relative)], root);
      runCommand('git', ['commit', '-m', `Install Squad on ACA ${version}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`], root);
      runCommand('git', ['push', '--set-upstream', 'origin', branch], root);
      log(runCommand('gh', ['pr', 'create', '--title', `Install Squad on ACA ${version}`, '--body', 'Adds pinned, target-owned Squad on ACA callers. Execution remains disabled; review the installation receipt and complete platform setup before enabling.', '--head', branch], root));
    } else if (openPr && conflicts.length) log('PR skipped because ownership conflicts need local review.');
  }
  log('Next: deploy the selected backend using infra/terraform or azure.yaml (azd). This installer never deploys Azure or changes variables/secrets.');
  log(`Then import the platform descriptor into .squad/platform.json, bind .squad/execution.json to its platform_id, initialize Squad, review settings, and set enabled=true. Set SQUAD_EXECUTION_BACKEND=${backend} in the target repository only when ready.`);
  log('See docs/install.md for backend-specific variables, environments, credentials, and ownership guidance.');
  return { conflicts, changed: changes.map(change => change.relative), exitCode: strict && conflicts.length ? 1 : 0 };
}
if (require.main === module) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/install.cjs --version <SHA|tag> --target <path> [--backend jobs|sandbox] [--preview] [--strict] [--open-pr]');
    else process.exitCode = install(options).exitCode;
  } catch (error) { console.error(`INSTALL_FAILED: ${error.message}`); process.exitCode = 1; }
}
module.exports = { install, parse, validate, hash, WORKFLOWS, MANIFEST, RECEIPT_HASH };
