const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { validateLocalInputs } = require('../local-preflight');
const { buildSafeChildEnv } = require('../lib/util');

const root = path.resolve(__dirname, '..', '..');
const image = `registry.example/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
const base = () => ({ repoRoot: root, concurrency: 1, timeoutMs: 300000, preflightOnly: true });
function work(t) {
  const parent = path.join(__dirname, '.work');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'local-operation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function makePlan(t, change = () => {}) {
  const dir = work(t);
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'dispatcher', 'fixtures', 'workflow-manual-plan.example.json')));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: buildSafeChildEnv() }).stdout.trim();
  plan.run_id = 'run-test-local';
  plan.baseline_sha = head;
  plan.tasks[0].baseline_sha = head;
  plan.issue = { repo: 'test-owner/test-repo', issue_number: 7 };
  change(plan);
  const planPath = path.join(dir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan));
  return { ...base(), planPath, repository: plan.issue.repo, issueNumber: '7' };
}

test('no-image preflight reports blockers without creating output or using a token', t => {
  const dir = work(t);
  const outDir = path.join(dir, 'never-created');
  const result = validateLocalInputs({ ...base(), outDir });
  assert.equal(result.ready, false);
  assert.match(result.blockers.join(' '), /Missing approved corrected immutable ImageRef/);
  assert.match(result.blockers.join(' '), /repo\/issue-bound/);
  assert.equal(fs.existsSync(outDir), false);
});

test('local parameters fail closed for timeout, concurrency, tags and old image', () => {
  for (const concurrency of [0, -1, 2, NaN, 1.5]) {
    assert.throws(() => validateLocalInputs({ ...base(), concurrency }), /concurrency/);
  }
  for (const timeoutMs of [0, 999, 300001, NaN, 1000.5]) {
    assert.throws(() => validateLocalInputs({ ...base(), timeoutMs }), /timeout/);
  }
  assert.throws(() => validateLocalInputs({ ...base(), imageRef: 'image:latest' }), /immutable/);
  assert.doesNotThrow(() => validateLocalInputs({ ...base(), imageRef: image.replace('persona-sandbox', 'another-image') }));
  assert.doesNotThrow(() => validateLocalInputs({ ...base(), imageRef: image.replace('a'.repeat(64), 'b'.repeat(64)) }));
  assert.throws(() => validateLocalInputs({ ...base(), repository: 'other/repo' }), /supplied together/);
});

test('local plan validator rejects malformed schema, wrong issue, baseline and checkout', t => {
  assert.throws(() => validateLocalInputs(makePlan(t, plan => { plan.tasks[0].owned_paths = []; })), /Execution plan is invalid/);
  assert.throws(() => validateLocalInputs({ ...makePlan(t), issueNumber: '43' }), /issue binding does not match/);
  assert.throws(() => validateLocalInputs(makePlan(t, plan => {
    plan.baseline_sha = '1'.repeat(40);
    plan.tasks[0].baseline_sha = plan.baseline_sha;
  })), /baseline must match/);
  assert.throws(() => validateLocalInputs({ ...makePlan(t), repository: 'other/repo' }), /Plan issue binding does not match/);
  assert.throws(() => validateLocalInputs(makePlan(t, plan => {
    plan.baseline_sha = '$CHECKED_OUT_SHA';
    plan.tasks[0].baseline_sha = '$CHECKED_OUT_SHA';
  })), /Execution plan is invalid/);
  const escaped = path.join(root, '..', 'outside.json');
  assert.throws(() => validateLocalInputs({ ...makePlan(t), planPath: escaped }), /parent segments/);
});

test('real operation cannot create output without a licensed caller token', t => {
  const options = { ...base(), preflightOnly: false, imageRef: image, outDir: path.join(work(t), 'output') };
  const script = `const { validateLocalInputs } = require(${JSON.stringify(path.join(root, 'dispatcher', 'local-preflight.js'))}); validateLocalInputs(${JSON.stringify(options)});`;
  const result = spawnSync(process.execPath, ['-e', script], { env: buildSafeChildEnv(), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SQUAD_COPILOT_TOKEN is required/);
  assert.equal(fs.existsSync(options.outDir), false);
});

test('reviewed single-persona plan works in a lab-bound checkout without workflow OIDC variables', t => {
  const dir = work(t);
  const checkout = path.join(dir, 'checkout');
  const runGit = (args, cwd) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: buildSafeChildEnv() });
    assert.equal(result.status, 0, result.stderr);
  };
  runGit(['clone', '--quiet', '--shared', '--no-checkout', root, checkout], dir);
  const options = makePlan(t);
  fs.copyFileSync(options.planPath, path.join(checkout, 'plan.json'));
  runGit(['remote', 'set-url', 'origin', `https://github.com/${options.repository}.git`], checkout);
  const result = validateLocalInputs({
    ...options, repoRoot: checkout, planPath: 'plan.json', imageRef: image, allowUnverifiedClient: true
  });
  assert.equal(result.ready, true);
  assert.equal(result.planPath, path.join(checkout, 'plan.json'));
  assert.throws(() => validateLocalInputs({ ...options, repoRoot: checkout, planPath: 'plan.json', issueNumber: '0' }), /positive decimal/);
  runGit(['remote', 'set-url', 'origin', 'https://github.com/test-owner/not-approved.git'], checkout);
  assert.throws(() => validateLocalInputs({ ...options, repoRoot: checkout, planPath: 'plan.json' }), /Checkout origin/);
});

test('PowerShell wrapper restores environment on success and errors; preflight only allows reads', { skip: process.platform !== 'win32' }, t => {
  const dir = work(t);
  const script = path.join(root, 'infra', 'hooks', 'sandbox-lab-local.ps1');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const harness = path.join(dir, 'check.ps1');
  fs.writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
. ${quote(script)}
$options = @{
  PreflightOnly = $true; RepoPath = ${quote(root)}; AzureConfigDir = ${quote(dir)}
  AcaBin = ${quote(harness)}; Concurrency = 1; TimeoutMs = 300000
  SubscriptionId = '00000000-0000-0000-0000-000000000000'; TenantId = '11111111-1111-4111-8111-111111111111'
  Region = 'swedencentral'; ResourceGroup = 'rg-sandbox-test'; SandboxGroup = 'sbg-sandbox-test'
  ImagePullClientId = '22222222-2222-4222-8222-222222222222'; ImagePullIdentityName = 'identity-test'
}
$env:AZURE_CONFIG_DIR = 'original-context'
$env:SQUAD_ENABLE_PUBLISH = 'original-publish'
$env:ACA_SANDBOX_MANAGED_IDENTITY = 'original-identity'
$env:LOCAL_TEST_SECRET = 'test-only-sentinel'
[Environment]::SetEnvironmentVariable('LOCAL_TEST_EMPTY_SECRET', '', 'Process')
$env:SQUAD_COPILOT_TOKEN = 'test-only-not-a-token'
Remove-Item Env:SQUAD_ENABLE_ACA_SANDBOX -ErrorAction SilentlyContinue
$script:calls = @()
$script:failure = ''
$script:blocked = $false
function Invoke-LabRead {
  param([string]$File, [string[]]$Arguments)
  if ($env:AZURE_CONFIG_DIR -ne $options.AzureConfigDir -or $env:SQUAD_ENABLE_PUBLISH -ne '0' -or
      $env:LOCAL_TEST_SECRET -or $env:SQUAD_COPILOT_TOKEN -or $env:ACA_SANDBOX_MANAGED_IDENTITY) { throw 'Environment was not isolated' }
  $script:calls += ,$Arguments
  if ($Arguments[0] -like '*local-preflight.js') {
    if ($script:blocked) { return '{"blockers":["Missing approved corrected immutable ImageRef"],"ready":false}' }
    return '{"blockers":[],"ready":true}'
  }
  if ($Arguments[0] -eq '--version') {
    if ($File -eq $options.AcaBin) { return 'aca 1.0.0-preview.4' }
    return 'v24.1.0'
  }
  if ($Arguments[0] -eq 'version') { return '{}' }
  if ($Arguments[0] -eq 'account') {
    if ($script:failure -eq 'account') { return '{"id":"wrong","tenantId":"wrong","isDefault":true,"state":"Enabled"}' }
    return '{"id":"00000000-0000-0000-0000-000000000000","tenantId":"11111111-1111-4111-8111-111111111111","isDefault":true,"state":"Enabled"}'
  }
  if ($Arguments[0] -eq 'resource') {
    $id = "/subscriptions/$($options.SubscriptionId)/resourceGroups/$($options.ResourceGroup)/providers/Microsoft.App/sandboxGroups/$($options.SandboxGroup)"
    $region = if ($script:failure -eq 'region') { 'other' } else { 'swedencentral' }
    return (@{id=$id;location=$region;state='Succeeded'} | ConvertTo-Json -Compress)
  }
  if ($Arguments[0] -eq 'identity') {
    $id = "/subscriptions/$($options.SubscriptionId)/resourceGroups/$($options.ResourceGroup)/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$($options.ImagePullIdentityName)"
    return (@{id=$id;clientId=$options.ImagePullClientId;tenantId=$options.TenantId} | ConvertTo-Json -Compress)
  }
  if ($Arguments[0] -eq '--region' -and $Arguments -contains 'list') {
    if ($Arguments[2] -ne '--subscription' -or $Arguments[4] -ne '--resource-group' -or $Arguments[3] -ne $options.SubscriptionId) { throw 'Missing explicit scope' }
    return '[]'
  }
  throw 'Forbidden preflight command'
}
function Assert-Restored {
  if ($env:AZURE_CONFIG_DIR -ne 'original-context' -or $env:SQUAD_ENABLE_PUBLISH -ne 'original-publish' -or
      $env:ACA_SANDBOX_MANAGED_IDENTITY -ne 'original-identity' -or $env:LOCAL_TEST_SECRET -ne 'test-only-sentinel' -or
      $env:SQUAD_COPILOT_TOKEN -ne 'test-only-not-a-token' -or
      [Environment]::GetEnvironmentVariable('LOCAL_TEST_EMPTY_SECRET','Process') -cne '' -or
      $null -ne [Environment]::GetEnvironmentVariable('SQUAD_ENABLE_ACA_SANDBOX','Process')) { throw 'Environment restoration failed' }
}
Invoke-SandboxLabLocal $options | Out-Null
Assert-Restored
foreach ($failure in @('account', 'region', 'blocked')) {
  $script:failure = $failure
  $script:blocked = $failure -eq 'blocked'
  $threw = $false
  try { Invoke-SandboxLabLocal $options | Out-Null } catch { $threw = $true }
  if (-not $threw) { throw 'Expected fail-closed preflight' }
  Assert-Restored
}
$before = $script:calls.Count
foreach ($name in @('SubscriptionId','TenantId','ImagePullClientId')) {
  $original = $options[$name]
  $options[$name] = 'not-a-guid'
  try { Invoke-SandboxLabLocal $options; throw 'Invalid GUID accepted' } catch {
    if ($_.Exception.Message -notlike '*must be a GUID*') { throw }
  }
  $options[$name] = $original
}
$original = $options.Region
$options.Region = ''
try { Invoke-SandboxLabLocal $options; throw 'Missing config accepted' } catch {
  if ($_.Exception.Message -notlike '*Missing required Sandbox configuration*') { throw }
}
$options.Region = $original
foreach ($invalid in @(0, 999, 1000.5, 300001)) {
  $options.TimeoutMs = $invalid
  try { Invoke-SandboxLabLocal $options; throw 'Timeout accepted' } catch {
    if ($_.Exception.Message -notlike '*Concurrency must be 1*') { throw }
  }
}
$options.TimeoutMs = 300000
if ($script:calls.Count -ne $before) { throw 'Wrong scope reached tools' }
Assert-Restored
$script:blocked = $false
$script:failure = ''
$options.PreflightOnly = $false
try { Invoke-SandboxLabLocal $options | Out-Null; throw 'Missing licensed token accepted' } catch {
  if ($_.Exception.Message -notlike '*caller-supplied licensed*') { throw }
}
Assert-Restored
Write-Output 'LOCAL_WRAPPER_OK'
`);
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', harness], {
    cwd: root, env: buildSafeChildEnv(), encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /LOCAL_WRAPPER_OK/);
});
