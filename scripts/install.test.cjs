const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { install, parse, validate, hash, WORKFLOWS, MANIFEST, RECEIPT_HASH } = require('./install.cjs');
const { included } = require('./package-release.cjs');
const ROOT = path.resolve(__dirname, '..');
const SHA = 'a'.repeat(40);
function fixture(run) {
  const base = path.join(ROOT, `.install-fixture-${crypto.randomUUID()}`);
  const release = path.join(base, 'release');
  const target = path.join(base, 'target with spaces');
  function write(root, file, bytes) {
    const destination = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  for (const file of [...WORKFLOWS.map(name => `.github/workflows/${name}`), 'contracts/backend/v1/schemas/installation.schema.json', 'scripts/install.cjs', 'install.ps1', 'install.sh']) {
    write(release, file, fs.readFileSync(path.join(ROOT, ...file.split('/'))));
  }
  write(release, 'release.json', JSON.stringify({ repository: 'haflidif/squad-on-aca', release_version: 'v1.2.3', action_sha: SHA }));
  const logs = [];
  const invoke = extra => install({ version: 'v1.2.3', target, ...extra }, release, line => logs.push(line));
  const read = relative => fs.readFileSync(path.join(target, ...relative.split('/')), 'utf8');
  try { return run({ base, release, target, invoke, read, logs, write: (file, bytes) => write(target, file, bytes) }); }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
}
function snapshot(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file, { bigint: true });
      result.push([path.relative(root, file), String(stat.mtimeNs), entry.isDirectory() ? 'directory' : hash(fs.readFileSync(file))]);
      if (entry.isDirectory()) visit(file);
    }
  }
  visit(root);
  return result;
}
test('preview lists additions without creating a missing target, even with open-pr', () => fixture(({ target, invoke, logs }) => {
  const result = invoke({ preview: true, openPr: true });
  assert.equal(fs.existsSync(target), false);
  assert.equal(result.exitCode, 0);
  assert.ok(logs.includes(`ADD ${MANIFEST}`));
  assert.ok(logs.some(line => line.startsWith('PREVIEW:')));
}));
test('preview of an existing application leaves every file and timestamp unchanged', () => fixture(({ target, write, invoke }) => {
  write('src/application.txt', 'application data');
  const before = snapshot(target);
  invoke({ preview: true });
  assert.deepEqual(snapshot(target), before);
}));
test('fresh install defaults to Jobs, records valid ownership, and pins every engine consumer', () => fixture(({ target, release, invoke, read }) => {
  const result = invoke();
  assert.equal(result.exitCode, 0);
  const receipt = JSON.parse(read(MANIFEST));
  validate(receipt, JSON.parse(fs.readFileSync(path.join(release, 'contracts/backend/v1/schemas/installation.schema.json'))));
  assert.equal(receipt.backend, 'jobs');
  assert.equal(receipt.release_version, 'v1.2.3');
  assert.equal(receipt.action_sha, SHA);
  assert.equal(receipt.platform_id, undefined);
  assert.equal(read(RECEIPT_HASH).trim(), hash(read(MANIFEST)));
  assert.equal(receipt.generated_files.length, 7);
  for (const file of receipt.generated_files) assert.equal(hash(read(file.path)), file.sha256);
  for (const name of WORKFLOWS) {
    const workflow = read(`.github/workflows/${name}`);
    assert.ok(workflow.includes(`uses: haflidif/squad-on-aca/.github/actions/sandbox-engine@${SHA}`));
    assert.ok(!workflow.includes('uses: ./.github/actions/sandbox-engine'));
  }
  assert.match(read('.github/workflows/squad-router.yml'), /if: vars\.SQUAD_EXECUTION_BACKEND != '' && \(/);
  assert.match(read('.github/workflows/squad-sandbox-conflicts.yml'), /if: vars\.SQUAD_EXECUTION_BACKEND == 'sandbox'/);
  assert.equal(JSON.parse(read('.squad/execution.json')).enabled, false);
  assert.equal(fs.existsSync(path.join(target, 'dispatcher')), false);
  assert.equal(fs.existsSync(path.join(target, 'infra')), false);
}));
test('same version rerun is a byte and timestamp no-op', () => fixture(({ target, invoke }) => {
  invoke();
  const before = snapshot(target);
  const result = invoke();
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(snapshot(target), before);
}));
test('user edits are preserved with a printed diff; strict alone makes conflicts nonzero', () => fixture(({ target, invoke, read, write, logs }) => {
  invoke();
  const file = '.github/workflows/squad-router.yml';
  const ownedHash = JSON.parse(read(MANIFEST)).generated_files.find(entry => entry.path === file).sha256;
  write(file, '# user-owned router\n');
  const before = snapshot(target);
  const normal = invoke();
  assert.equal(normal.exitCode, 0);
  assert.ok(normal.conflicts.includes(file));
  assert.equal(invoke({ strict: true }).exitCode, 1);
  assert.equal(invoke({ strict: true, preview: true }).exitCode, 1);
  assert.deepEqual(snapshot(target), before);
  assert.ok(logs.some(line => line.startsWith(`--- current/${file}`)));
  assert.equal(JSON.parse(read(MANIFEST)).generated_files.find(entry => entry.path === file).sha256, ownedHash);
}));
test('existing Squad roster, flow configuration and custom workflows are not adopted or overwritten', () => fixture(({ write, invoke, read }) => {
  write('.squad/team.md', '# My own team\n');
  write('.squad/sandbox-flow.json', '{"version":1,"members":{"testing":{"allowed_paths":["tests/**"]}}}\n');
  write('.squad/agents/custom/charter.md', 'My charter\n');
  write('.github/workflows/build.yml', 'name: My build\n');
  write('.github/workflows/squad-router.yml', '# existing router\n');
  const result = invoke({ backend: 'sandbox' });
  assert.equal(read('.squad/team.md'), '# My own team\n');
  assert.match(read('.squad/sandbox-flow.json'), /tests/);
  assert.equal(read('.squad/agents/custom/charter.md'), 'My charter\n');
  assert.equal(read('.github/workflows/build.yml'), 'name: My build\n');
  assert.equal(read('.github/workflows/squad-router.yml'), '# existing router\n');
  assert.ok(result.conflicts.includes('.github/workflows/squad-router.yml'));
  const receipt = JSON.parse(read(MANIFEST));
  assert.equal(receipt.backend, 'sandbox');
  assert.equal(JSON.parse(read('.squad/execution.json')).backend, 'sandbox');
  assert.ok(!receipt.generated_files.some(file => file.path === '.squad/team.md'));
}));
test('an unchanged owned installation can change backend while staying disabled', () => fixture(({ invoke, read }) => {
  invoke();
  assert.equal(invoke({ backend: 'sandbox' }).exitCode, 0);
  assert.equal(JSON.parse(read(MANIFEST)).backend, 'sandbox');
  assert.equal(JSON.parse(read('.squad/execution.json')).backend, 'sandbox');
  assert.equal(JSON.parse(read('.squad/execution.json')).enabled, false);
}));
test('receipt edits, missing checksum and malformed receipt all stop writes', () => fixture(({ target, write, invoke, read }) => {
  invoke();
  const original = read(MANIFEST);
  write(MANIFEST, original.replace('v1.2.3', 'v9.9.9'));
  let before = snapshot(target);
  assert.equal(invoke().exitCode, 0);
  assert.equal(invoke({ strict: true }).exitCode, 1);
  assert.deepEqual(snapshot(target), before);
  write(MANIFEST, 'not JSON');
  write(RECEIPT_HASH, hash('not JSON'));
  before = snapshot(target);
  assert.equal(invoke({ strict: true }).exitCode, 1);
  assert.deepEqual(snapshot(target), before);
  fs.unlinkSync(path.join(target, RECEIPT_HASH));
  assert.equal(invoke({ strict: true }).exitCode, 1);
}));
test('invalid backend, ref, release mismatch and missing arguments fail before writing', () => fixture(({ target, invoke }) => {
  for (const options of [{ backend: 'both' }, { version: '../bad' }, { version: 'main' }, { version: 'b'.repeat(40) }, { version: undefined }, { target: undefined }]) {
    assert.throws(() => invoke(options));
    assert.equal(fs.existsSync(target), false);
  }
  assert.throws(() => parse(['--unknown']));
  assert.throws(() => parse(['--version']));
  assert.equal(parse(['--ref', SHA, '--target', target]).version, SHA);
}));
test('symlink or junction parents do not redirect writes outside the target', () => fixture(({ base, target, invoke }) => {
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(target);
  fs.symlinkSync(outside, path.join(target, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = invoke({ strict: true });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(result.conflicts.filter(file => file.startsWith('.github/')).length, WORKFLOWS.length);
}));
test('a hard-linked existing file is not overwritten', () => fixture(({ base, target, write, invoke }) => {
  write('.squad/team.md', 'preserve\n');
  const outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, 'external\n');
  fs.mkdirSync(path.join(target, '.github/workflows'), { recursive: true });
  fs.linkSync(outside, path.join(target, '.github/workflows/squad-router.yml'));
  const result = invoke({ strict: true });
  assert.equal(result.exitCode, 1);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'external\n');
}));
test('schema rejects invalid backend, unknown fields, invalid hashes and unsafe paths', () => fixture(({ invoke, read, release }) => {
  invoke();
  const schema = JSON.parse(fs.readFileSync(path.join(release, 'contracts/backend/v1/schemas/installation.schema.json')));
  const receipt = JSON.parse(read(MANIFEST));
  for (const change of [{ backend: 'both' }, { token: 'not-a-secret' }, { action_sha: 'main' }, { generated_files: [] }, { generated_files: [{ path: '../escape', sha256: 'f'.repeat(64) }] }, { generated_files: [{ path: 'safe.txt', sha256: 'bad' }] }]) {
    assert.throws(() => validate({ ...receipt, ...change }, schema));
  }
}));
test('release packaging includes runtime and IaC sources but excludes secrets and local state', () => {
  for (const file of ['install.sh', 'install.ps1', 'scripts/install.cjs', 'scripts/backend-router.cjs', 'dispatcher/cli.js', 'agents/base/Dockerfile', 'agents/sandbox/Dockerfile', 'infra/terraform/main.tf', 'infra/terraform/terraform.tfvars.example', 'infra/bicep/main.bicep', 'infra/hooks/postprovision.sh', 'azure.yaml', '.github/actions/sandbox-engine/run.cjs', '.github/workflows/squad-router.yml']) assert.equal(included(file), true, file);
  for (const file of ['.squad/team.md', '.azure/config.json', 'infra/terraform/terraform.tfstate', 'infra/terraform/project.tfstate.backup', 'infra/terraform/custom.tfvars', 'infra/terraform/custom.tfvars.json', 'infra/.env', 'dispatcher/app.pem', 'dispatcher/app.PEM', '.github/workflows/ci.yml']) assert.equal(included(file), false, file);
});
test('Node entry point previews a full SHA without writes', () => fixture(({ release, target }) => {
  const result = spawnSync(process.execPath, [path.join(release, 'scripts/install.cjs'), '--version', SHA, '--target', target, '--preview'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(target), false);
}));
for (const shell of ['pwsh', 'bash']) {
  test(`${shell} entry point installs and reruns with paths containing spaces`, t => fixture(({ release, target, invoke }) => {
    const args = shell === 'pwsh'
      ? ['-NoProfile', '-File', path.join(release, 'install.ps1'), '-Version', 'v1.2.3', '-Target', target, '-Backend', 'sandbox']
      : [path.join(release, 'install.sh'), '--version', 'v1.2.3', '--target', target, '--backend', 'sandbox'];
    const preview = spawnSync(shell, [...args, shell === 'pwsh' ? '-Preview' : '--preview'], { encoding: 'utf8' });
    if (preview.error?.code === 'ENOENT') { t.skip(`${shell} is not installed`); return; }
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(fs.existsSync(target), false);
    const actual = spawnSync(shell, args, { encoding: 'utf8' });
    assert.equal(actual.status, 0, actual.stderr);
    assert.deepEqual(invoke({ backend: 'sandbox' }).changed, []);
  }));
}
test('release upgrades repin only unchanged owned files and preserve edits', () => fixture(({ invoke, release, read, write }) => {
  invoke();
  write('.squad/team.md', '# User-initialized team\n');
  const upgraded = 'b'.repeat(40);
  fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify({ repository: 'haflidif/squad-on-aca', release_version: 'v2.0.0', action_sha: upgraded }));
  const result = invoke({ version: 'v2.0.0' });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.conflicts, ['.squad/team.md']);
  assert.equal(read('.squad/team.md'), '# User-initialized team\n');
  assert.equal(JSON.parse(read(MANIFEST)).action_sha, upgraded);
  for (const name of WORKFLOWS) assert.ok(read(`.github/workflows/${name}`).includes(`sandbox-engine@${upgraded}`));
}));
test('only explicit open-pr executes Git writes and pushes the installer-owned paths', () => fixture(({ release, target, read }) => {
  fs.mkdirSync(target, { recursive: true });
  const calls = [];
  const fakeCommand = (binary, args, cwd) => {
    calls.push({ binary, args, cwd });
    if (args[0] === 'rev-parse') return target.replaceAll('\\', '/');
    if (args[0] === 'status') return '';
    return 'test-result';
  };
  const result = install({ version: 'v1.2.3', target, openPr: true }, release, () => {}, fakeCommand);
  assert.equal(result.exitCode, 0);
  assert.equal(calls.filter(call => call.binary === 'gh' && call.args[0] === 'pr').length, 1);
  assert.equal(calls.filter(call => call.args[0] === 'push').length, 1);
  const added = calls.find(call => call.args[0] === 'add').args.slice(2);
  assert.deepEqual(added, result.changed);
  assert.equal(JSON.parse(read('.squad/execution.json')).enabled, false);
  const count = calls.length;
  install({ version: 'v1.2.3', target, openPr: true }, release, () => {}, fakeCommand);
  assert.equal(calls.length, count, 'a no-op must not create another PR');
}));
test('open-pr rejects a dirty repository before changing files', () => fixture(({ release, target }) => {
  fs.mkdirSync(target, { recursive: true });
  const fakeCommand = (binary, args) => args[0] === 'rev-parse' ? target.replaceAll('\\', '/') : args[0] === 'status' ? ' M application.txt' : '';
  assert.throws(() => install({ version: 'v1.2.3', target, openPr: true }, release, () => {}, fakeCommand), /clean target Git repository/);
  assert.deepEqual(fs.readdirSync(target), []);
}));
test('default installation, preview and conflicts never invoke PR operations', () => fixture(({ release, target, write }) => {
  const forbidden = () => { throw new Error('REMOTE_OPERATION_MUST_NOT_RUN'); };
  install({ version: 'v1.2.3', target, preview: true, openPr: true }, release, () => {}, forbidden);
  install({ version: 'v1.2.3', target }, release, () => {}, forbidden);
  write('.github/workflows/squad-router.yml', '# custom router\n');
  const result = install({ version: 'v1.2.3', target, openPr: true }, release, () => {}, forbidden);
  assert.ok(result.conflicts.length);
}));
