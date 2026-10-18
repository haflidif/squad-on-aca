const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const tfVariables = read('infra', 'terraform', 'variables.tf');
const tfBackend = read('infra', 'terraform', 'backend.tf');
const bicep = read('infra', 'bicep', 'main.bicep');
const schema = JSON.parse(read('contracts', 'backend', 'v1', 'schemas', 'platform-descriptor.schema.json'));

test('Terraform and Bicep expose the contract selector with the same values and default', () => {
  const variable = tfVariables.match(/variable "execution_backend" \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(variable);
  assert.match(variable, /type\s*=\s*string/);
  assert.match(variable, /default\s*=\s*"jobs"/);
  assert.match(variable, /nullable\s*=\s*false/);
  assert.deepEqual(JSON.parse(variable.match(/contains\((\[[^\]]+\])/)[1]), schema.properties.backend.enum);
  const parameter = bicep.match(/@allowed\((\[[^\]]+\])\)\s*param executionBackend string = '([^']+)'/);
  assert.ok(parameter);
  assert.deepEqual(JSON.parse(parameter[1].replaceAll("'", '"')), schema.properties.backend.enum);
  assert.equal(parameter[2], schema.properties.backend.default);
});

test('both descriptor outputs expose every required common and backend field', () => {
  assert.match(tfBackend, /output "platform_descriptor"/);
  assert.match(bicep, /output platformDescriptor object\?/);
  for (const key of [...schema.required, ...schema.properties.jobs.required, ...schema.properties.sandbox.required]) {
    assert.match(tfBackend, new RegExp(`\\b${key}\\s*=`), `Terraform ${key}`);
    assert.match(bicep, new RegExp(`\\b${key}:`), `Bicep ${key}`);
  }
  for (const source of [tfBackend, bicep]) {
    assert.match(source, /backend\/v1/);
    assert.match(source, /api:\/\/AzureADTokenExchange/);
    assert.match(source, /environment:squad-sandbox-issue/);
    assert.match(source, /squad-publish/);
    assert.match(source, /descriptor_ready|descriptorReady/);
  }
});

test('azd maps selector, image pins, and original Jobs inputs in a tracked source parameter file', () => {
  const parameters = JSON.parse(read('infra', 'bicep', 'main.parameters.json')).parameters;
  assert.equal(parameters.executionBackend.value, '${SQUAD_EXECUTION_BACKEND=jobs}');
  assert.equal(parameters.jobsImageRef.value, '${SQUAD_JOBS_IMAGE_REF=}');
  assert.equal(parameters.sandboxImageRef.value, '${SQUAD_SANDBOX_IMAGE_REF=}');
  for (const name of ['githubAppId', 'githubAppInstallationId', 'deployerPrincipalId', 'targetRepos']) {
    assert.ok(parameters[name]);
  }
  assert.match(read('.gitignore'), /!infra\/bicep\/main\.parameters\.json/);
  assert.match(read('azure.yaml'), /shell: sh/);
  assert.match(read('azure.yaml'), /run: bash infra\/hooks\/preprovision\.sh/);
  assert.match(read('azure.yaml'), /run: bash infra\/hooks\/postprovision\.sh/);
});

test('default Jobs singleton resources have explicit state moves and unchanged image fallback', () => {
  const main = read('infra', 'terraform', 'main.tf');
  const moves = read('infra', 'terraform', 'backend-migrations.tf').replaceAll('\r\n', '\n');
  const counted = [...main.matchAll(/(?:module "([^"\n]+)"|resource "([^"\n]+)" "([^"\n]+)") \{\s*count = local\.jobs_enabled \? 1 : 0/g)];
  assert.equal(counted.length, 11);
  for (const match of counted) {
    const address = match[1] ? `module.${match[1]}` : `${match[2]}.${match[3]}`;
    assert.ok(moves.includes(`from = ${address}\n`), address);
    assert.ok(moves.includes(`to   = ${address}[0]`), address);
  }
  assert.match(main, /var\.jobs_image_ref != "" \? var\.jobs_image_ref : "\$\{module\.acr\.resource\.login_server\}\/squad-agent:latest"/);
  const job = read('infra', 'bicep', 'modules', 'container-app-job.bicep');
  assert.match(job, /param containerImage string = 'mcr\.microsoft\.com\/hello-world:latest'/);
  assert.match(bicep, /empty\(jobsImageRef\) \? 'mcr\.microsoft\.com\/hello-world:latest' : jobsImageRef/);
});

test('Bicep conditions Jobs modules and leaves shared modules unconditional', () => {
  for (const name of ['identity', 'storage', 'keyvault', 'acaEnvironment', 'agentJob']) {
    assert.match(bicep, new RegExp(`module ${name} '[^']+' = if \\(jobsEnabled\\)`));
  }
  for (const name of ['acr', 'monitoring']) {
    assert.match(bicep, new RegExp(`module ${name} '[^']+' = \\{`));
  }
  assert.match(bicep, /module sandbox '[^']+' = if \(!jobsEnabled\)/);
  const sandbox = read('infra', 'bicep', 'modules', 'sandbox.bicep');
  assert.match(sandbox, /Microsoft\.App\/sandboxGroups@2026-07-01/);
  assert.match(sandbox, /resource dispatcher /);
  assert.match(sandbox, /resource imagePull /);
  assert.match(sandbox, /scope: group/);
  assert.match(sandbox, /scope: registry/);
  assert.match(sandbox, /c24cf47c-5077-412d-a19c-45202126392c/);
  assert.doesNotMatch(sandbox, /AcrPush|KeyVault|Storage/);
});

const gitBash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
for (const [variant, executable, args] of [
  ['PowerShell', process.platform === 'win32' ? 'pwsh.exe' : 'pwsh', ['-NoProfile', '-File']],
  ['POSIX', gitBash, []]
]) {
  const probe = spawnSync(executable, variant === 'POSIX' ? ['--version'] : ['-NoProfile', '-Command', '[Environment]::ProcessPath'], { encoding: 'utf8' });
  const available = !probe.error && probe.status === 0;
  const shell = variant === 'PowerShell' && available ? probe.stdout.trim() : executable;
  function hook(name, variables = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(SQUAD_|GITHUB_APP_|EXECUTION_BACKEND$|JOBS_IMAGE_REF$|TARGET_REPOS$|AZURE_PRINCIPAL_ID$|PATH$)/i.test(key)) delete env[key];
    }
    Object.assign(env, variables);
    // Neither preflight nor the Sandbox post-hook may need Azure/GitHub tools.
    env.PATH = path.dirname(shell);
    return spawnSync(shell, [...args, path.join(root, 'infra', 'hooks', `${name}.${variant === 'POSIX' ? 'sh' : 'ps1'}`)], { encoding: 'utf8', env, timeout: 20000 });
  }
  const pin = `example.azurecr.io/worker@sha256:${'a'.repeat(64)}`;
  test(`${variant} preflight preserves omitted/default Jobs requirements`, { skip: !available }, () => {
    const failed = hook('preprovision');
    assert.notEqual(failed.status, 0);
    const passed = hook('preprovision', { GITHUB_APP_ID: '1', GITHUB_APP_INSTALLATION_ID: '2', AZURE_PRINCIPAL_ID: 'synthetic-principal' });
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  });
  test(`${variant} Sandbox preflight needs an immutable image, not Jobs credentials`, { skip: !available }, () => {
    const result = hook('preprovision', { SQUAD_EXECUTION_BACKEND: 'sandbox', SQUAD_SANDBOX_IMAGE_REF: pin });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /no Jobs Key Vault/);
    for (const image of ['', 'example.azurecr.io/worker:latest', pin.toUpperCase()]) {
      assert.notEqual(hook('preprovision', { SQUAD_EXECUTION_BACKEND: 'sandbox', SQUAD_SANDBOX_IMAGE_REF: image }).status, 0);
    }
  });
  test(`${variant} preflight rejects invalid selectors rather than defaulting`, { skip: !available }, () => {
    for (const backend of ['', 'both', 'sandboxes', 'JOBS']) {
      const result = hook('preprovision', { SQUAD_EXECUTION_BACKEND: backend });
      assert.notEqual(result.status, 0, backend);
      assert.match(result.stdout + result.stderr, /must be jobs or sandbox/);
    }
  });
  test(`${variant} pinned Jobs post-hook does not build or restore latest`, { skip: !available }, () => {
    const result = hook('postprovision', {
      EXECUTION_BACKEND: 'jobs', JOBS_IMAGE_REF: pin,
      RESOURCE_GROUP_NAME: 'example-group', ACR_LOGIN_SERVER: 'example.azurecr.io',
      KEY_VAULT_NAME: 'example-vault', STORAGE_ACCOUNT_NAME: 'examplestorage',
      QUEUE_NAME: 'example-queue', SQUAD_AGENT_CLIENT_ID: 'synthetic-client',
      SQUAD_AGENT_TENANT_ID: 'synthetic-tenant', AGENT_JOB_NAME: 'example-job',
      AZURE_SUBSCRIPTION_ID: 'synthetic-subscription'
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Using the pinned Jobs image/);
    assert.doesNotMatch(result.stdout, /Building squad-agent|Updating Container App Job/);
  });
  test(`${variant} Sandbox post-hook skips all Jobs and legacy GitHub setup`, { skip: !available }, () => {
    const result = hook('postprovision', { EXECUTION_BACKEND: 'sandbox', SQUAD_EXECUTION_BACKEND: 'sandbox' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Skipping Jobs image build/);
    assert.match(result.stdout, /Execution has not been enabled/);
    const mismatch = hook('postprovision', { EXECUTION_BACKEND: 'jobs', SQUAD_EXECUTION_BACKEND: 'sandbox' });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stdout + mismatch.stderr, /Requested backend differs/);
  });
}
