'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { activate, validateDescriptor, unwrap } = require('./activate.cjs');
function descriptor(backend = 'jobs') {
  const platform = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/example';
  const id = type => `${platform}/providers/${type}/example`;
  const client = '00000000-0000-0000-0000-000000000002';
  const image = `example.azurecr.io/worker@sha256:${'a'.repeat(64)}`;
  return {
    schema_version: 'backend/v1', release_version: 'v1.0.0', platform_id: platform,
    backend, location: 'example-region', tenant_id: client,
    registry_id: id('Microsoft.ContainerRegistry/registries'), monitoring_id: id('Microsoft.OperationalInsights/workspaces'),
    limits: { max_concurrency: 2, timeout_seconds: 1800 },
    oidc: [{ client_id: client, subject: backend === 'jobs' ? 'repo:example/repository:ref:refs/heads/main' : 'repo:example/repository:environment:squad-sandbox-issue', audience: 'api://AzureADTokenExchange' }],
    protected_environments: backend === 'jobs' ? [] : ['squad-sandbox-issue', 'squad-publish'],
    ...(backend === 'jobs' ? { jobs: {
      managed_environment_id: id('Microsoft.App/managedEnvironments'), job_id: id('Microsoft.App/jobs'),
      storage_account_id: id('Microsoft.Storage/storageAccounts'), queue_name: 'example-work', identity_client_id: client,
      image_ref: image, key_vault_id: id('Microsoft.KeyVault/vaults')
    } } : { sandbox: { group_id: id('Microsoft.App/sandboxGroups'), dispatcher_client_id: client, image_pull_client_id: client, image_ref: image } })
  };
}
function fixture(t, backend = 'jobs') {
  const root = fs.mkdtempSync(path.join(__dirname, '.activation-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'input.json');
  fs.writeFileSync(file, JSON.stringify(descriptor(backend)));
  const calls = [], logs = [];
  const dependencies = { env: {}, log: text => logs.push(text), execute: (...args) => { calls.push(args); return ''; } };
  return { root, file, calls, logs, dependencies, options: { descriptor: file, target: path.join(root, 'target') } };
}
for (const backend of ['jobs', 'sandbox']) {
  test(`valid ${backend} descriptor and all invalid field types are schema checked`, () => {
    assert.equal(validateDescriptor(descriptor(backend)).backend, backend);
    for (const change of [{ backend: 'both' }, { tenant_id: 'invalid' }, { limits: { max_concurrency: 0, timeout_seconds: 1 } }, { token: 'not-a-secret' }]) {
      assert.throws(() => validateDescriptor({ ...descriptor(backend), ...change }));
    }
  });
  test(`${backend} default prepares disabled local files and prints exact settings without CLI calls`, t => {
    const f = fixture(t, backend);
    const result = activate(f.options, f.dependencies);
    assert.equal(result.execution.enabled, false);
    assert.deepEqual(f.calls, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.target, '.squad', 'platform.json'))).backend, backend);
    assert.ok(f.logs.some(text => text.includes('GitHub unchanged.')));
    if (backend === 'sandbox') {
      assert.equal(result.variables.SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID, descriptor(backend).sandbox.image_pull_client_id);
      assert.match(f.logs.join('\n'), /SQUAD_GITHUB_APP_PRIVATE_KEY_PEM/);
    } else assert.equal(result.variables.SQUAD_QUEUE_NAME, 'example-work');
  });
  test(`${backend} idempotent re-run preserves bytes and timestamps`, t => {
    const f = fixture(t, backend);
    activate(f.options, f.dependencies);
    const files = ['execution.json', 'platform.json'].map(name => path.join(f.options.target, '.squad', name));
    const before = files.map(file => [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs]);
    activate(f.options, f.dependencies);
    assert.deepEqual(files.map(file => [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs]), before);
  });
}
test('Sandbox fails closed on each missing required field, image tags and partial deployment', t => {
  const f = fixture(t, 'sandbox');
  for (const key of ['group_id', 'dispatcher_client_id', 'image_pull_client_id', 'image_ref']) {
    const value = descriptor('sandbox'); delete value.sandbox[key];
    fs.writeFileSync(f.file, JSON.stringify(value));
    assert.throws(() => activate(f.options, f.dependencies), new RegExp(`sandbox.${key}`));
  }
  const value = descriptor('sandbox'); value.sandbox.image_ref = 'example.azurecr.io/worker:latest';
  assert.throws(() => validateDescriptor(value));
  assert.equal(fs.existsSync(f.options.target), false);
});
test('Terraform output envelope, selected output envelope and azd JSON-string values unwrap identically', () => {
  const value = descriptor();
  assert.deepEqual(unwrap({ platform_descriptor: { value } }, 'terraform'), value);
  assert.deepEqual(unwrap({ value }, 'terraform'), value);
  assert.deepEqual(unwrap({ platformDescriptor: value }, 'azd'), value);
  assert.deepEqual(unwrap({ PLATFORM_DESCRIPTOR: JSON.stringify(value) }, 'azd'), value);
  assert.deepEqual(unwrap({ PLATFORMDESCRIPTOR: JSON.stringify(value) }, 'azd'), value);
});
test('Terraform null output reports exact blockers and writes nothing', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify({ platform_descriptor: { value: null }, platform_descriptor_missing: { value: ['jobs_image_ref: missing digest'] } }));
  assert.throws(() => activate({ terraform: f.file, target: f.options.target }, f.dependencies), /jobs_image_ref: missing digest/);
  assert.equal(fs.existsSync(f.options.target), false);
  assert.deepEqual(f.calls, []);
  assert.throws(() => validateDescriptor(null), /enable_aca_sandbox=true/);
});
test('jobs default on omitted execution backend and new binding', t => {
  const f = fixture(t);
  const folder = path.join(f.options.target, '.squad'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'execution.json'), JSON.stringify({ schema_version: 'backend/v1', platform_id: descriptor().platform_id }));
  const result = activate(f.options, f.dependencies);
  assert.equal(result.execution.backend, 'jobs'); assert.equal(result.execution.enabled, false);
});
test('preview is entirely write-free', t => {
  const f = fixture(t);
  activate({ ...f.options, preview: true }, f.dependencies);
  assert.equal(fs.existsSync(f.options.target), false); assert.deepEqual(f.calls, []);
});
test('legacy environment, workflow and exported remote variables produce migration guidance', t => {
  const f = fixture(t);
  const folder = path.join(f.options.target, '.github', 'workflows'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'old.yml'), 'if: vars.SQUAD_ISSUE_FLOW_ENABLED\n# sandbox-run');
  const exported = path.join(f.root, 'legacy.json'); fs.writeFileSync(exported, '[{"name":"SQUAD_ISSUE_OPT_IN_NUMBER","value":"123"}]');
  const result = activate({ ...f.options, legacySettings: exported }, { ...f.dependencies, env: { SQUAD_ISSUE_FLOW_ENABLED: 'true' } });
  assert.deepEqual(result.legacy.sort(), ['SQUAD_ISSUE_FLOW_ENABLED', 'SQUAD_ISSUE_OPT_IN_NUMBER', 'sandbox-run'].sort());
  assert.match(f.logs.join('\n'), /no longer authorize or restrict/); assert.deepEqual(f.calls, []);
});
test('azd hook environment path avoids all CLI reads and stays preview-only', t => {
  const f = fixture(t, 'sandbox');
  activate({ azd: true, target: f.options.target, preview: true }, { ...f.dependencies, env: { PLATFORM_DESCRIPTOR: JSON.stringify(descriptor('sandbox')) } });
  assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.options.target), false);
});
test('azd CLI fallback consumes JSON values, not shell-evaluated exports', t => {
  const f = fixture(t);
  activate({ azd: true, target: f.options.target }, { ...f.dependencies, execute: (bin, args) => {
    assert.equal(bin, 'azd'); assert.deepEqual(args, ['env', 'get-values', '--output', 'json']);
    return JSON.stringify({ PLATFORM_DESCRIPTOR: JSON.stringify(descriptor()) });
  } });
});
test('explicit enable requires matching target OIDC and Sandbox protected environment declarations', t => {
  const f = fixture(t, 'sandbox');
  const options = { ...f.options, enable: true, repo: 'example/repository' };
  const value = descriptor('sandbox'); value.oidc = [];
  fs.writeFileSync(f.file, JSON.stringify(value));
  assert.throws(() => activate(options, f.dependencies), /Missing OIDC/);
  value.oidc = descriptor('sandbox').oidc; value.protected_environments = [];
  fs.writeFileSync(f.file, JSON.stringify(value));
  assert.throws(() => activate(options, f.dependencies), /Missing protected environments/);
  fs.writeFileSync(f.file, JSON.stringify(descriptor('sandbox')));
  assert.equal(activate(options, f.dependencies).execution.enabled, true);
});
test('backend change refuses active binding, then succeeds disabled after pause without touching receipts', t => {
  const f = fixture(t);
  activate({ ...f.options, enable: true, repo: 'example/repository' }, f.dependencies);
  const receipt = path.join(f.options.target, '.squad', 'receipt.json'); fs.writeFileSync(receipt, '{"backend":"jobs"}');
  fs.writeFileSync(f.file, JSON.stringify(descriptor('sandbox')));
  assert.throws(() => activate(f.options, f.dependencies), /Pause admission first/);
  const execution = path.join(f.options.target, '.squad', 'execution.json');
  const old = JSON.parse(fs.readFileSync(execution)); old.enabled = false; fs.writeFileSync(execution, JSON.stringify(old));
  assert.equal(activate(f.options, f.dependencies).execution.enabled, false);
  assert.equal(fs.readFileSync(receipt, 'utf8'), '{"backend":"jobs"}');
});
test('--apply is explicit, requires gh, uses argument arrays and applies only known variables', t => {
  const f = fixture(t, 'sandbox');
  const options = { ...f.options, apply: true, repo: 'example/repository', appId: '1', installationId: '2' };
  activate(options, f.dependencies);
  assert.deepEqual(f.calls[0], ['gh', ['--version']]);
  assert.equal(f.calls.at(-1)[1][2], 'SQUAD_EXECUTION_BACKEND');
  assert.equal(f.calls.some(call => call[1].includes('secret')), false);
  const f2 = fixture(t, 'sandbox');
  assert.throws(() => activate({ ...f2.options, apply: true, repo: 'example/repository' }, f2.dependencies), /--app-id/);
  assert.equal(fs.existsSync(f2.options.target), false); assert.deepEqual(f2.calls, []);
});
test('gh absence during explicit apply fails before local writes', t => {
  const f = fixture(t);
  assert.throws(() => activate({ ...f.options, apply: true, repo: 'example/repository' }, { ...f.dependencies, execute: () => { throw new Error('gh absent'); } }), /gh absent/);
  assert.equal(fs.existsSync(f.options.target), false);
});
test('CLI rejects unknown options and ambiguous inputs', () => {
  for (const args of [[], ['--apply'], ['--unknown'], ['--azd', '--descriptor', 'example.json']]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'activate.cjs'), ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /ACTIVATION_REJECTED/);
  }
});
test('active descriptor changes fail before settings apply, including same-backend image changes', t => {
  const f = fixture(t);
  const options = { ...f.options, repo: 'example/repository', enable: true };
  activate(options, f.dependencies);
  const value = descriptor(); value.jobs.image_ref = value.jobs.image_ref.replace('a'.repeat(64), 'b'.repeat(64));
  fs.writeFileSync(f.file, JSON.stringify(value));
  assert.throws(() => activate({ ...options, apply: true }, f.dependencies), /Pause admission before changing/);
  assert.deepEqual(f.calls, []);
});
test('junction target cannot redirect activation files', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.options.target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => activate(f.options, f.dependencies), /Unsafe activation path/);
  assert.equal(fs.existsSync(path.join(outside, '.squad')), false);
});
test('azd null descriptor preserves the exact published blockers', t => {
  const f = fixture(t);
  assert.throws(() => activate({ azd: true, target: f.options.target }, { ...f.dependencies, env: {
    PLATFORM_DESCRIPTOR: 'null', PLATFORM_DESCRIPTOR_MISSING: '["SQUAD_SANDBOX_IMAGE_REF: missing digest"]'
  } }), /SQUAD_SANDBOX_IMAGE_REF: missing digest/);
  assert.equal(fs.existsSync(f.options.target), false);
});

test('Terraform CLI stdin accepts full output JSON and BOM, including target paths with spaces', t => {
  const f = fixture(t);
  const target = path.join(f.root, 'target with spaces');
  const input = '\uFEFF' + JSON.stringify({ platform_descriptor: { sensitive: false, type: 'object', value: descriptor() } });
  const result = spawnSync(process.execPath, [path.join(__dirname, 'activate.cjs'), '--terraform', '-', '--target', target], { encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, '.squad', 'execution.json'))).enabled, false);
  assert.match(result.stdout, /GitHub unchanged/);
});
test('azd-values CLI file produces a matching disabled Sandbox binding', t => {
  const f = fixture(t, 'sandbox');
  fs.writeFileSync(f.file, JSON.stringify({ PLATFORM_DESCRIPTOR: JSON.stringify(descriptor('sandbox')) }));
  const result = spawnSync(process.execPath, [path.join(__dirname, 'activate.cjs'), '--azd-values', f.file, '--target', f.options.target], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const binding = JSON.parse(fs.readFileSync(path.join(f.options.target, '.squad', 'execution.json')));
  assert.equal(binding.backend, 'sandbox'); assert.equal(binding.enabled, false);
});

const oidcCases = require('../contracts/backend/v1/fixtures/oidc-subjects.json');
for (const example of oidcCases) {
  test(`OIDC ${example.backend} ${example.name}: ${example.valid ? 'enables exact binding' : 'rejects without writes or calls'}`, t => {
    const f = fixture(t, example.backend);
    const value = descriptor(example.backend); value.oidc[0].subject = example.subject;
    fs.writeFileSync(f.file, JSON.stringify(value));
    const options = { ...f.options, enable: true, repo: 'example/repository' };
    if (example.valid) {
      const result = activate(options, f.dependencies);
      assert.equal(result.execution.enabled, true);
      assert.equal(result.descriptor.oidc[0].subject, example.subject);
    } else {
      assert.throws(() => activate(options, f.dependencies));
      assert.equal(fs.existsSync(f.options.target), false);
    }
    assert.deepEqual(f.calls, []);
  });
}
test('immutable binding still requires the selected identity and exact audience', t => {
  const f = fixture(t, 'sandbox');
  for (const changes of [{ client_id: '00000000-0000-0000-0000-000000000099' }, { audience: 'other' }]) {
    const value = descriptor('sandbox');
    Object.assign(value.oidc[0], { subject: 'repo:example@123/repository@456:environment:squad-sandbox-issue' }, changes);
    fs.writeFileSync(f.file, JSON.stringify(value));
    assert.throws(() => activate({ ...f.options, enable: true, repo: 'example/repository' }, f.dependencies));
    assert.equal(fs.existsSync(f.options.target), false);
  }
});
