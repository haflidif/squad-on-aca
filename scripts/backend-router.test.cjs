'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { admit, assertRoute, selectBackend, routeReceipt, eligibleLabel, MARKER, CLAIM } = require('./backend-router.cjs');
const ROOT = path.resolve(__dirname, '..');
const fixture = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'backend', 'v1', 'fixtures', `route-${name}.json`), 'utf8'));
function descriptor(backend) {
  const platform = fixture('jobs').platform_id;
  const id = type => `${platform}/providers/${type}/example`;
  const client = '00000000-0000-0000-0000-000000000000';
  const image = `example.azurecr.io/worker@sha256:${'a'.repeat(64)}`;
  return { schema_version: 'backend/v1', release_version: 'v1.0.0', platform_id: platform, backend, location: 'example', tenant_id: client,
    registry_id: id('Microsoft.ContainerRegistry/registries'), monitoring_id: id('Microsoft.OperationalInsights/workspaces'),
    limits: { max_concurrency: 2, timeout_seconds: 1800 }, oidc: [{ client_id: client, subject: 'repo:test-owner/test-repo:environment:squad-sandbox-issue', audience: 'api://AzureADTokenExchange' }],
    protected_environments: ['squad-sandbox-issue', 'squad-publish'],
    ...(backend === 'jobs' ? { jobs: { managed_environment_id: id('Microsoft.App/managedEnvironments'), job_id: id('Microsoft.App/jobs'), storage_account_id: id('Microsoft.Storage/storageAccounts'), queue_name: 'example-work', identity_client_id: client, image_ref: image, key_vault_id: id('Microsoft.KeyVault/vaults') } }
      : { sandbox: { group_id: id('Microsoft.App/sandboxGroups'), dispatcher_client_id: client, image_pull_client_id: client, image_ref: image } }) };
}
for (const [name, backend] of [['jobs', 'jobs'], ['sandbox', 'sandbox'], ['default', 'jobs']]) test(`contract fixture routes ${name} to exactly ${backend}`, () => {
  const selected = selectBackend(fixture(name), descriptor(backend));
  assert.equal(selected.backend, backend);
  assert.equal(selected.provider, backend === 'jobs' ? 'aca-job' : 'aca-sandbox');
});
test('invalid selectors fail closed without a fallback', () => {
  assert.throws(() => selectBackend(fixture('invalid'), descriptor('sandbox')), /BACKEND_INVALID/);
  for (const backend of ['', 'both', 'sandboxes', null, 'JOBS', false, 0, '__proto__']) assert.throws(() => selectBackend({ ...fixture('jobs'), backend }, descriptor('jobs')), /BACKEND_INVALID/);
});
test('disabled, unbound, mixed, mutable and unknown configuration rejected', () => {
  for (const enabled of [false, undefined]) assert.throws(() => selectBackend({ ...fixture('jobs'), enabled }, descriptor('jobs')));
  assert.throws(() => selectBackend({ ...fixture('jobs'), platform_id: 'bad' }, descriptor('jobs')));
  assert.throws(() => selectBackend(fixture('jobs'), descriptor('sandbox')), /BINDING/);
  assert.throws(() => selectBackend(fixture('jobs'), { ...descriptor('jobs'), platform_id: fixture('jobs').platform_id + '-other' }), /BINDING/);
  assert.throws(() => selectBackend(fixture('jobs'), { ...descriptor('jobs'), sandbox: descriptor('sandbox').sandbox }));
  const mutable = descriptor('sandbox'); mutable.sandbox.image_ref = 'example:latest';
  assert.throws(() => selectBackend(fixture('sandbox'), mutable));
  assert.throws(() => selectBackend({ ...fixture('jobs'), token: 'not-a-secret' }, descriptor('jobs')));
});
function bot(body) { return { body, user: { login: 'github-actions[bot]', type: 'Bot', id: 41898282 } }; }
async function harness(run, backend = 'sandbox') {
  const root = path.join(ROOT, `.router-fixture-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(root, '.squad'), { recursive: true });
  const write = selected => {
    fs.writeFileSync(path.join(root, '.squad', 'execution.json'), JSON.stringify(fixture(selected)));
    fs.writeFileSync(path.join(root, '.squad', 'platform.json'), JSON.stringify(descriptor(selected === 'default' ? 'jobs' : selected)));
  };
  write(backend);
  const comments = [], calls = [];
  const context = { repo: { owner: 'test-owner', repo: 'test-repo' }, eventName: 'issues', runId: 100,
    payload: { action: 'labeled', repository: { full_name: 'test-owner/test-repo', default_branch: 'main' }, label: { name: 'squad:test-builder' }, sender: { type: 'User', login: 'test-maintainer' }, issue: { number: 11, state: 'open' } } };
  const env = { GITHUB_REPOSITORY: 'test-owner/test-repo', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1' };
  const github = { rest: { repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'write' } }) }, issues: {
    listComments: 'comments', createComment: async value => { calls.push(value); comments.push(bot(value.body)); }
  }, pulls: { get: async () => ({ data: { state: 'open', user: { type: 'Bot' }, head: { ref: 'squad/aca-sandbox/issue-11-test-request', repo: { full_name: env.GITHUB_REPOSITORY } }, base: { ref: 'main', repo: { full_name: env.GITHUB_REPOSITORY } } } }) } }, paginate: async () => comments };
  const revise = () => {
    context.eventName = 'issue_comment'; context.payload.action = 'created'; context.payload.issue = { number: 12, pull_request: {} };
    context.payload.comment = { id: 555, body: '/squad revise Improve it.', user: { type: 'User', login: 'test-maintainer' } };
    context.runId = 101; env.GITHUB_RUN_ID = '101';
  };
  const options = { github, context, root, env };
  try { await run({ options, comments, calls, write, revise, root }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
for (const backend of ['jobs', 'sandbox']) test(`receipt precedes ${backend} dispatch and rejects the other backend`, async () => harness(async ({ options, calls }) => {
  const receipt = await admit(options);
  assert.equal(receipt.backend, backend);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.startsWith(MARKER)); assert.ok(calls[1].body.startsWith(CLAIM));
  await assertRoute({ ...options, backend, runId: '100' });
  await assert.rejects(assertRoute({ ...options, backend: backend === 'jobs' ? 'sandbox' : 'jobs', runId: '100' }), /BACKEND_RECEIPT_REQUIRED/);
}, backend));
test('legacy missing configuration stays Jobs without activating Sandbox', async () => harness(async ({ options, root }) => {
  fs.unlinkSync(path.join(root, '.squad', 'execution.json'));
  const receipt = await admit(options); assert.equal(receipt.backend, 'jobs'); assert.equal(receipt.platform_id, 'legacy-jobs');
}));
test('revise retains original backend and run receipt across a selector change', async () => harness(async ({ options, write, revise, comments }) => {
  await admit(options); write('jobs'); revise();
  const receipt = await admit(options);
  assert.equal(receipt.backend, 'sandbox'); assert.equal(receipt.run_id, '100');
  assert.equal(comments.filter(comment => comment.body.startsWith(MARKER)).length, 1);
  await assertRoute({ ...options, backend: 'sandbox', runId: '101' });
  await assert.rejects(assertRoute({ ...options, backend: 'jobs', runId: '101' }), /BACKEND_RECEIPT_REQUIRED/);
}));
test('ambiguous retries, duplicate revise comments and relabels never redispatch', async () => harness(async ({ options, write, revise, calls }) => {
  await admit(options); write('jobs');
  await assert.rejects(admit(options), /RECONCILE_REQUIRED/); assert.equal(calls.length, 2);
  options.env.GITHUB_RUN_ATTEMPT = '2'; await assert.rejects(admit(options), /RECONCILE_REQUIRED/);
  options.env.GITHUB_RUN_ATTEMPT = '1'; revise(); await admit(options);
  await assert.rejects(admit(options), /RECONCILE_REQUIRED/); assert.equal(calls.length, 3);
}));
test('missing revise receipt, malformed trusted receipts and conflicting receipts fail closed', async () => harness(async ({ options, revise, comments }) => {
  revise(); await assert.rejects(admit(options), /REVISE_RECEIPT_REQUIRED/);
  comments.push(bot(MARKER + '\nnot-json')); await assert.rejects(admit(options), /MALFORMED/);
  comments.length = 0;
  comments.push(bot(MARKER + '\n{}'), bot(MARKER + '\n{}')); await assert.rejects(admit(options), /AMBIGUOUS/);
}));
test('spoofed human and other bot receipt markers are ignored', () => {
  for (const user of [{ login: 'test-human', type: 'User' }, { login: 'other[bot]', type: 'Bot', id: 123 }, { login: 'github-actions[bot]', type: 'Bot', id: 123 }]) {
    assert.equal(routeReceipt([{ body: MARKER + '\nnot-json', user }], 'test-owner/test-repo', 11), undefined);
  }
});
test('permission, event, lifecycle, default branch and repository negatives write no receipt', async () => {
  for (const mutate of [
    o => { o.context.payload.label.name = 'sandbox-run'; }, o => { o.context.payload.label.name = 'squad:processing'; },
    o => { o.context.payload.issue.state = 'closed'; }, o => { o.context.payload.issue.pull_request = {}; },
    o => { o.context.payload.sender.type = 'Bot'; }, o => { o.context.payload.repository.full_name = 'other/repo'; },
    o => { o.env.GITHUB_REF = 'refs/heads/other'; }, o => { o.context.payload.action = 'opened'; },
    o => { o.github.rest.repos.getCollaboratorPermissionLevel = async () => ({ data: { permission: 'read' } }); }
  ]) await harness(async ({ options, calls }) => { mutate(options); await assert.rejects(admit(options), /ROUTE_REJECTED/); assert.equal(calls.length, 0); });
});
test('failed receipt persistence never admits dispatch', async () => harness(async ({ options }) => {
  options.github.rest.issues.createComment = async () => { throw new Error('network unavailable'); };
  await assert.rejects(admit(options), /network unavailable/);
  await assert.rejects(assertRoute({ ...options, backend: 'sandbox', runId: '100' }), /BACKEND_RECEIPT_REQUIRED/);
}));
test('a present invalid or disabled installation never enters the legacy adapter', async () => {
  for (const content of ['not-json', JSON.stringify({ ...fixture('sandbox'), backend: '' }), JSON.stringify({ ...fixture('sandbox'), enabled: false }), JSON.stringify({ ...fixture('sandbox'), enabled: undefined })]) {
    await harness(async ({ options, root, calls }) => {
      fs.writeFileSync(path.join(root, '.squad', 'execution.json'), content);
      await assert.rejects(admit(options)); assert.equal(calls.length, 0);
    });
  }
  await harness(async ({ options, root, calls }) => {
    fs.unlinkSync(path.join(root, '.squad', 'platform.json'));
    await assert.rejects(admit(options)); assert.equal(calls.length, 0);
  });
});
test('a failed request claim leaves a receipt that blocks redispatch', async () => harness(async ({ options, comments }) => {
  const create = options.github.rest.issues.createComment;
  options.github.rest.issues.createComment = async value => { if (value.body.startsWith(CLAIM)) throw new Error('claim unavailable'); return create(value); };
  await assert.rejects(admit(options), /claim unavailable/);
  assert.equal(comments.length, 1);
  await assert.rejects(assertRoute({ ...options, backend: 'sandbox', runId: '100' }), /BACKEND_RECEIPT_REQUIRED/);
  await assert.rejects(admit(options), /RECONCILE_REQUIRED/);
}));
test('a receipt or claim from a different issue cannot authorize a consumer', async () => harness(async ({ options, comments }) => {
  await admit(options);
  const claim = JSON.parse(comments[1].body.slice(CLAIM.length));
  claim.issue_number = 99; comments[1].body = CLAIM + '\n' + JSON.stringify(claim);
  await assert.rejects(assertRoute({ ...options, backend: 'sandbox', runId: '100' }), /BACKEND_RECEIPT_REQUIRED/);
  const receipt = JSON.parse(comments[0].body.slice(MARKER.length));
  receipt.repository = 'other/repo'; comments[0].body = MARKER + '\n' + JSON.stringify(receipt);
  await assert.rejects(admit(options), /RECEIPT_INVALID/);
}));
test('rerunning only failed backend jobs still refuses an existing claim', async () => harness(async ({ options }) => {
  await admit(options);
  options.env.GITHUB_RUN_ATTEMPT = '2';
  await assert.rejects(assertRoute({ ...options, backend: 'sandbox', runId: '100' }), /RECONCILE_REQUIRED/);
}));
test('lifecycle and retired provider labels cannot request a backend', () => {
  for (const label of ['sandbox-run', 'sandbox:ready', 'squad:processing', 'squad:queued', '', undefined]) assert.equal(eligibleLabel(label), false);
  for (const label of ['squad', 'squad:test-builder']) assert.equal(eligibleLabel(label), true);
});
test('only the router has issue triggers and both backend workflows verify receipts', () => {
  const read = name => fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
  const router = read('squad-router.yml');
  assert.match(router, /group: squad-router-\$\{\{ github.repository \}\}/);
  for (const [file, backend] of [['squad-queue.yml', 'jobs'], ['squad-sandbox-issue.yml', 'sandbox']]) {
    const workflow = read(file);
    assert.match(workflow, /on:\n  workflow_call:/);
    assert.doesNotMatch(workflow.split('permissions:')[0], /^  (issues|issue_comment):/m);
    assert.ok(workflow.includes(`inputs.backend == '${backend}'`));
    assert.ok(router.includes(`needs.route.outputs.backend == '${backend}'`));
    assert.ok(workflow.includes(`backend: '${backend}'`));
    assert.match(workflow, /backend-router\.cjs.*assertRoute/);
    assert.match(workflow, /if: github.run_attempt == 1 && inputs.backend/);
    assert.doesNotMatch(workflow, /SQUAD_ISSUE_OPT_IN_NUMBER|SQUAD_ISSUE_FLOW_ENABLED|sandbox-run/);
  }
  assert.equal(read('squad-queue.yml'), fs.readFileSync(path.join(ROOT, 'agents', 'workflows', 'squad-queue.yml'), 'utf8'));
});
