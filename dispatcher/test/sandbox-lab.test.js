const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { readVariables, parseArguments, verifyEnvironment } = require('../../infra/hooks/sandbox-lab-bootstrap');

const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('lab Terraform roots own only isolated state and dispatch resources', () => {
  const state = read('infra/terraform/sandbox-lab-state/main.tf');
  const lab = read('infra/terraform/sandbox-lab/main.tf');
  assert.match(state, /resource "azurerm_resource_group" "lab"/);
  assert.match(state, /shared_access_key_enabled\s*=\s*false/);
  assert.match(state, /default_action\s*=\s*var\.network_default_action/);
  assert.match(read('infra/terraform/sandbox-lab-state/variables.tf'), /variable "network_default_action" \{[^}]*default\s*=\s*"Deny"/);
  assert.match(state, /container_access_type\s*=\s*"private"/);
  assert.match(state, /state_operator_principal_id == null \? 0 : 1/);
  assert.match(lab, /backend "azurerm"/);
  assert.match(lab, /data "azurerm_resource_group" "lab"/);
  assert.match(lab, /data "azurerm_container_registry" "images"/);
  assert.match(lab, /Microsoft.App\/sandboxGroups@2026-07-01/);
  assert.match(lab, /scope\s*=\s*azapi_resource.sandbox_group.id/);
  assert.match(lab, /repo:AzureViking\/squad-on-aca-sandbox-lab:environment:squad-sandbox-dispatch/);
  assert.match(lab, /image_pull_principal_id == null \? 0 : 1/);
  assert.doesNotMatch(lab + state, /resource "(?:azurerm_container_registry|azurerm_container_app_job|azurerm_storage_queue|github_)/);
  assert.doesNotMatch(lab, /AcrPush|SecurityControl/);
  assert.match(read('infra/terraform/sandbox-lab/backend.hcl.example'), /key\s*=\s*"sandbox-lab.tfstate"/);
});

test('bootstrap helper dry run never calls ghp or emits secrets or legacy settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lab-helper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'outputs.json');
  const value = v => ({ value: v });
  const outputs = {
    subscription_id: value('e69b8a95-fe38-42da-b5e6-e3e0a833cf9e'),
    resource_group_name: value('rg-squad-aca-sandbox-lab'),
    sandbox_group_name: value('sbg-squad-aca-sandbox-lab'),
    dispatcher_client_id: value('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    dispatcher_tenant_id: value('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  };
  fs.writeFileSync(outputPath, JSON.stringify(outputs));
  const options = ['--outputs', outputPath, '--repo', 'AzureViking/squad-on-aca-sandbox-lab', '--environment', 'squad-sandbox-dispatch'];
  assert.equal(Object.keys(readVariables(outputPath)).length, 4);
  assert.throws(() => parseArguments([...options.slice(0, 2), '--repo', 'haflidif/squad-on-aca', ...options.slice(4)]), /Usage/);
  outputs.subscription_id.value = 'other';
  fs.writeFileSync(outputPath, JSON.stringify(outputs));
  assert.throws(() => readVariables(outputPath), /approved subscription/);
  outputs.subscription_id.value = 'e69b8a95-fe38-42da-b5e6-e3e0a833cf9e';
  fs.writeFileSync(outputPath, JSON.stringify(outputs));
  const result = spawnSync(process.execPath, [path.join(root, 'infra/hooks/sandbox-lab-bootstrap.js'), ...options], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN/);
  assert.doesNotMatch(result.stdout, /bbbbbbbb|secret|SQUAD_STORAGE_ACCOUNT|SQUAD_QUEUE_NAME/i);
  assert.doesNotMatch(read('infra/hooks/sandbox-lab-bootstrap.js'), /spawnSync\('gh'/);
});

const LAB_REPO = 'AzureViking/squad-on-aca-sandbox-lab';
const LAB_ENV = 'squad-sandbox-dispatch';
const labOutputs = () => ({
  subscription_id: { value: 'e69b8a95-fe38-42da-b5e6-e3e0a833cf9e' },
  resource_group_name: { value: 'rg-squad-aca-sandbox-lab' },
  sandbox_group_name: { value: 'sbg-squad-aca-sandbox-lab' },
  dispatcher_client_id: { value: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
  dispatcher_tenant_id: { value: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
});

// Shape of GET /repos/{owner}/{repo}/environments/{name}: prevent_self_review lives on the required_reviewers rule.
const protectedEnvironment = () => ({
  id: 161088068,
  node_id: 'EN_kwDOAbCdEs4JmfpE',
  name: LAB_ENV,
  url: `https://api.github.com/repos/${LAB_REPO}/environments/${LAB_ENV}`,
  html_url: `https://github.com/${LAB_REPO}/deployments/activity_log?environments_filter=${LAB_ENV}`,
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:05:00Z',
  can_admins_bypass: false,
  protection_rules: [
    { id: 3736, node_id: 'GA_kwDOAbCdEs4AAA6Y', type: 'wait_timer', wait_timer: 0 },
    {
      id: 3755,
      node_id: 'GA_kwDOAbCdEs4AAA6r',
      prevent_self_review: true,
      type: 'required_reviewers',
      reviewers: [
        { type: 'User', reviewer: { login: 'lab-approver', id: 1234567, node_id: 'U_kgDOABLaBw', type: 'User', site_admin: false } },
        { type: 'Team', reviewer: { id: 7654321, node_id: 'T_kwDOAbCdEs4AdM2x', name: 'sandbox-approvers', slug: 'sandbox-approvers', privacy: 'closed', permission: 'pull' } }
      ]
    },
    { id: 3756, node_id: 'GA_kwDOAbCdEs4AAA6s', type: 'branch_policy' }
  ],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
});
const mainOnlyPolicies = () => ({ total_count: 1, branch_policies: [{ id: 361471, node_id: 'MDE2OkdhdGVCcmFuY2hQb2xpY3kzNjE0NzE=', name: 'main', type: 'branch' }] });

function runApplyWithStubGhp(t, environment, policies = mainOnlyPolicies()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lab-apply-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'outputs.json');
  const logPath = path.join(dir, 'ghp-calls.jsonl');
  fs.writeFileSync(outputPath, JSON.stringify(labOutputs()));
  fs.writeFileSync(path.join(dir, 'environment.json'), JSON.stringify(environment));
  fs.writeFileSync(path.join(dir, 'policies.json'), JSON.stringify(policies));
  const stub = path.join(dir, 'ghp-stub.js');
  fs.writeFileSync(stub, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');`,
    `const envPath = 'repos/${LAB_REPO}/environments/${LAB_ENV}';`,
    "if (args[0] === 'api' && args[1] === envPath) process.stdout.write(fs.readFileSync(path.join(__dirname, 'environment.json'), 'utf8'));",
    "else if (args[0] === 'api' && args[1] === envPath + '/deployment-branch-policies') process.stdout.write(fs.readFileSync(path.join(__dirname, 'policies.json'), 'utf8'));",
    "else if (args[0] === 'variable' && args[1] === 'set') process.stdout.write('');",
    "else { process.stderr.write('unexpected ghp call'); process.exit(2); }"
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'ghp.cmd'), `@"${process.execPath}" "${stub}" %*\r\n`);
  fs.writeFileSync(path.join(dir, 'ghp'), `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(root, 'infra/hooks/sandbox-lab-bootstrap.js'),
    '--outputs', outputPath, '--repo', LAB_REPO, '--environment', LAB_ENV, '--apply'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir, Path: dir }
  });
  const calls = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  return { result, calls, variableSets: calls.filter(call => call[0] === 'variable') };
}

test('bootstrap apply accepts self-review protection on the required_reviewers rule and sets only dispatch variables', t => {
  const environment = protectedEnvironment();
  assert.equal(Object.hasOwn(environment, 'prevent_self_review'), false);
  const { result, calls, variableSets } = runApplyWithStubGhp(t, environment);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Set 4 non-secret dispatch environment variables/);
  assert.deepEqual(calls.slice(0, 2), [
    ['api', `repos/${LAB_REPO}/environments/${LAB_ENV}`],
    ['api', `repos/${LAB_REPO}/environments/${LAB_ENV}/deployment-branch-policies`]
  ]);
  const env = ['--repo', LAB_REPO, '--env', LAB_ENV];
  assert.deepEqual(variableSets, [
    ['variable', 'set', 'SQUAD_SANDBOX_GROUP_NAME', ...env, '--body', 'sbg-squad-aca-sandbox-lab'],
    ['variable', 'set', 'SQUAD_SANDBOX_AZURE_CLIENT_ID', ...env, '--body', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
    ['variable', 'set', 'SQUAD_SANDBOX_AZURE_TENANT_ID', ...env, '--body', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
    ['variable', 'set', 'SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID', ...env, '--body', 'e69b8a95-fe38-42da-b5e6-e3e0a833cf9e']
  ]);
  assert.equal(calls.length, 6);
  assert.doesNotMatch(JSON.stringify(calls), /secret|SQUAD_STORAGE_ACCOUNT|SQUAD_QUEUE_NAME|SQUAD_AZURE_|PUBLISH/i);
});

test('bootstrap apply refuses to set variables without self-review prevention or reviewers', t => {
  const withoutSelfReview = protectedEnvironment();
  delete withoutSelfReview.protection_rules[1].prevent_self_review;
  withoutSelfReview.prevent_self_review = true;
  const selfReviewAllowed = protectedEnvironment();
  selfReviewAllowed.protection_rules[1].prevent_self_review = false;
  const noReviewers = protectedEnvironment();
  noReviewers.protection_rules[1].reviewers = [];
  const noReviewerRule = protectedEnvironment();
  noReviewerRule.protection_rules.splice(1, 1);
  for (const [environment, message] of [
    [withoutSelfReview, /must prevent self-review/],
    [selfReviewAllowed, /must prevent self-review/],
    [noReviewers, /at least one valid reviewer/],
    [noReviewerRule, /exactly one required reviewers rule/]
  ]) {
    const { result, calls, variableSets } = runApplyWithStubGhp(t, environment);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
    assert.equal(variableSets.length, 0);
    assert.equal(calls.length, 2);
  }
});

test('bootstrap environment verification fails closed on malformed or ambiguous protection rules', () => {
  const manual = 'manual';
  assert.doesNotThrow(() => verifyEnvironment(protectedEnvironment(), mainOnlyPolicies(), manual));
  const cases = [
    [env => { delete env.protection_rules; }, /missing or malformed/],
    [env => { env.protection_rules = {}; }, /missing or malformed/],
    [env => { env.protection_rules.push(null); }, /missing or malformed/],
    [env => { env.protection_rules.push({ id: 1 }); }, /missing or malformed/],
    [env => { env.protection_rules.push({ ...env.protection_rules[1] }); }, /exactly one required reviewers rule/],
    [env => { delete env.protection_rules[1].reviewers; }, /at least one valid reviewer/],
    [env => { env.protection_rules[1].reviewers = [{ type: 'User' }]; }, /at least one valid reviewer/],
    [env => { env.protection_rules[1].reviewers.push({ type: 'Bot', reviewer: { id: 1 } }); }, /at least one valid reviewer/],
    [env => { env.protection_rules[1].prevent_self_review = 'true'; }, /must prevent self-review/],
    [env => { env.can_admins_bypass = true; }, /not verified as protected/],
    [env => { delete env.can_admins_bypass; }, /not verified as protected/],
    [env => { env.deployment_branch_policy = null; }, /not verified as protected/],
    [env => { env.deployment_branch_policy = { protected_branches: true, custom_branch_policies: false }; }, /not verified as protected/]
  ];
  for (const [mutate, message] of cases) {
    const environment = protectedEnvironment();
    mutate(environment);
    assert.throws(() => verifyEnvironment(environment, mainOnlyPolicies(), manual), message);
  }
  assert.throws(() => verifyEnvironment(null, mainOnlyPolicies(), manual), /missing or malformed/);
  assert.throws(() => verifyEnvironment(protectedEnvironment(), { total_count: 1, branch_policies: [{ id: 1, name: 'main', type: 'tag' }] }, manual), /only the lab main branch/);
  assert.throws(() => verifyEnvironment(protectedEnvironment(), { total_count: 1, branch_policies: [null] }, manual), /only the lab main branch/);
  assert.throws(() => verifyEnvironment(protectedEnvironment(), null, manual), /only the lab main branch/);
});

test('bootstrap allows self-review only with explicit opt-in and still requires the reviewer rule', () => {
  const selfReview = protectedEnvironment();
  selfReview.protection_rules[1].prevent_self_review = false;
  assert.throws(() => verifyEnvironment(selfReview, mainOnlyPolicies(), 'manual'), /must prevent self-review/);
  assert.doesNotThrow(() => verifyEnvironment(selfReview, mainOnlyPolicies(), 'manual', { allowSelfReview: true }));
  const malformed = protectedEnvironment();
  malformed.protection_rules[1].prevent_self_review = 'false';
  assert.throws(() => verifyEnvironment(malformed, mainOnlyPolicies(), 'manual', { allowSelfReview: true }), /must prevent self-review/);
  const noReviewers = protectedEnvironment();
  noReviewers.protection_rules[1].reviewers = [];
  assert.throws(() => verifyEnvironment(noReviewers, mainOnlyPolicies(), 'manual', { allowSelfReview: true }), /at least one valid reviewer/);
  assert.equal(parseArguments(['--outputs', 'o.json', '--repo', 'AzureViking/squad-on-aca-sandbox-lab', '--environment', 'squad-sandbox-dispatch', '--allow-self-review']).allowSelfReview, true);
});

const policyIntegrityCases = () => {
  const main = () => mainOnlyPolicies().branch_policies[0];
  const dev = { id: 361472, node_id: 'MDE2OkdhdGVCcmFuY2hQb2xpY3kzNjE0NzI=', name: 'dev', type: 'branch' };
  return [
    ['missing total_count', { branch_policies: [main()] }],
    ['null total_count', { total_count: null, branch_policies: [main()] }],
    ['string total_count', { total_count: '1', branch_policies: [main()] }],
    ['fractional total_count', { total_count: 1.5, branch_policies: [main()] }],
    ['negative total_count', { total_count: -1, branch_policies: [main()] }],
    ['zero total_count and empty list', { total_count: 0, branch_policies: [] }],
    ['zero total_count with main', { total_count: 0, branch_policies: [main()] }],
    ['partial response total_count 2', { total_count: 2, branch_policies: [main()] }],
    ['two policies', { total_count: 2, branch_policies: [main(), dev] }],
    ['count 1 with two policies', { total_count: 1, branch_policies: [main(), dev] }],
    ['missing branch_policies', { total_count: 1 }],
    ['non-array branch_policies', { total_count: 1, branch_policies: { 0: main() } }],
    ['missing id', { total_count: 1, branch_policies: [{ ...main(), id: undefined }] }],
    ['string id', { total_count: 1, branch_policies: [{ ...main(), id: '361471' }] }],
    ['zero id', { total_count: 1, branch_policies: [{ ...main(), id: 0 }] }],
    ['non-main name', { total_count: 1, branch_policies: [{ ...main(), name: 'dev' }] }],
    ['wildcard name', { total_count: 1, branch_policies: [{ ...main(), name: '*' }] }],
    ['array response', [main()]]
  ];
};

test('bootstrap policy verification requires strict list response integrity', () => {
  assert.doesNotThrow(() => verifyEnvironment(protectedEnvironment(), mainOnlyPolicies(), 'manual'));
  for (const [label, policies] of policyIntegrityCases()) {
    assert.throws(() => verifyEnvironment(protectedEnvironment(), policies, 'manual'), /only the lab main branch/, label);
  }
});

test('bootstrap apply refuses to set variables on malformed or partial branch policy responses', t => {
  for (const [label, policies] of policyIntegrityCases()) {
    const { result, calls, variableSets } = runApplyWithStubGhp(t, protectedEnvironment(), policies);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, /only the lab main branch/, label);
    assert.equal(variableSets.length, 0, label);
    assert.equal(calls.length, 2, label);
  }
});

test('manual lab workflow gates, image wiring and legacy job isolation', () => {
  const workflow = read('.github/workflows/squad-sandbox-manual.yml');
  const ci = read('.github/workflows/squad-ci.yml');
  assert.match(workflow, /SQUAD_SANDBOX_IMAGE_REF: \$\{\{ vars.SQUAD_SANDBOX_IMAGE_REF \}\}/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /github.repository != 'AzureViking\/squad-on-aca-sandbox-lab'/);
  assert.match(ci, /for root in infra\/terraform\/sandbox-lab-state infra\/terraform\/sandbox-lab/);
  assert.match(read('dispatcher/dispatcher.js'), /image: config.image/);
  assert.match(read('dispatcher/integrate.js'), /image: config.image/);
  assert.match(read('agents/base/providers/dispatch.sh'), /aca-job/);
  assert.match(read('agents/base/entrypoint.sh'), /validate_provider_before_ack/);
});
