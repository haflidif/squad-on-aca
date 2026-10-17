'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { buildLeadPlan, buildMemberPlan, validateRoutingDecision } = require('./issue-plan.cjs');
const { validateDecision } = require('./issue-route.cjs');
const { summarizeStored, renderComment } = require('./issue-report.cjs');
const { memberLabelDefinitions } = require('./member-labels.cjs');
const { postReport, ensureLabel } = require('./issue-triage.cjs');
const { validateContract } = require('../contracts/aca-sandbox/v1/tools/validate');
const { runIntegrationPhase, buildIntegrationDispatch } = require('../dispatcher/integrate');
const { LIFECYCLE_LABELS, prBody, commitMessage, labelPublication, FakeGitHubClient, RealGitHubClient, sanitizeUntrusted, withTaskRoles } = require('../dispatcher/publish');
const member = (id, role) => ({ logical_member_id: id, resolved_persistent_name: `Test ${id}`, role, charter_ref: `.squad/agents/${id}/charter.md`, membership: 'persona', capabilities: ['writing'] });
const roster = { members: [member('test-lead', 'Integration Lead'), member('test-writer', 'Documentation & Examples'), member('test-checker', 'Module Tests'), member('test-builder', 'Infrastructure'), member('test-monitor', 'Work Monitor')] };
roster.lead = roster.members[0];
const options = { repository: 'test-owner/test-repo', issueNumber: 7, runId: '123', attempt: '1', roster };
function decision() {
  return { reason: 'Independently scoped documentation and tests.', members: [
    { member: roster.members[1].logical_member_id, objective: 'Update the project overview.', owned_paths: ['README.md'] },
    { member: roster.members[2].logical_member_id, objective: 'Add regression tests.', owned_paths: ['scripts/example.test.cjs', 'dispatcher/test/**'] }
  ] };
}
function planFor(value = decision()) {
  const plan = buildMemberPlan({ ...options, selections: validateRoutingDecision(value, roster).selections });
  plan.baseline_sha = 'a'.repeat(40);
  for (const task of plan.tasks) task.baseline_sha = plan.baseline_sha;
  return plan;
}
function scratch(run) {
  const dir = path.join(__dirname, '..', `.multi-member-test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir);
  return Promise.resolve().then(() => run(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('valid two-member decision produces distinct persona tasks and a valid contract', () => {
  const plan = planFor();
  const validation = validateContract('coordinator-execution.schema.json', plan);
  assert.equal(validation.valid, true, validation.errors.join('; '));
  assert.equal(plan.tasks.length, 2);
  assert.equal(new Set(plan.tasks.map(task => task.task_id)).size, 2);
  for (const [i, task] of plan.tasks.entries()) {
    assert.equal(task.owner.logical_member_id, roster.members[i + 1].logical_member_id);
    assert.equal(task.owner.resolved_persistent_name, roster.members[i + 1].resolved_persistent_name);
    assert.equal(Object.hasOwn(task.owner, 'role'), false);
    assert.ok(task.objective.includes(task.owner.charter_ref));
    assert.ok(task.objective.includes(decision().members[i].objective));
    assert.deepEqual(task.owned_paths, decision().members[i].owned_paths);
  }
  assert.deepEqual(plan.integration.check_commands.map(check => check.name), ['verify-member-tests']);
});

for (const [name, mutate, code] of [
  ['duplicate', d => { d.members[1].member = d.members[0].member; }, 'DECISION_MEMBER_DUPLICATE'],
  ['more than three', d => { d.members.push(d.members[0], d.members[1]); }, 'DECISION_MEMBER_COUNT_INVALID'],
  ['empty list', d => { d.members = []; }, 'DECISION_MEMBER_COUNT_INVALID'],
  ['out of roster', d => { d.members[1].member = 'test-missing'; }, 'ROUTED_MEMBER_REJECTED'],
  ['Lead chosen', d => { d.members[1].member = roster.lead.logical_member_id; }, 'ROUTED_MEMBER_REJECTED'],
  ['unsupported role', d => { d.members[1].member = roster.members[4].logical_member_id; }, 'MEMBER_NOT_SUPPORTED'],
  ['overlapping files', d => { d.members[1].owned_paths = ['README.md']; }, 'DECISION_SCOPES_OVERLAP'],
  ['parent scope overlap', d => { d.members[0].owned_paths = ['dispatcher/test']; }, 'DECISION_SCOPES_OVERLAP'],
  ['case folded overlap', d => { d.members[1].owned_paths = ['readme.md']; }, 'DECISION_SCOPES_OVERLAP'],
  ['empty scopes', d => { d.members[1].owned_paths = []; }, 'DECISION_SHAPE_INVALID'],
  ['empty objective', d => { d.members[1].objective = ''; }, 'DECISION_SHAPE_INVALID'],
  ['unsafe objective', d => { d.members[1].objective = 'bad\nobjective'; }, 'DECISION_SHAPE_INVALID'],
  ['test scope escape', d => { d.members[1].owned_paths = ['scripts/../issue-plan.cjs']; }, 'DECISION_SCOPE_INVALID'],
  ['production script', d => { d.members[1].owned_paths = ['scripts/issue-plan.cjs']; }, 'DECISION_SCOPE_UNSUPPORTED'],
  ['broad directory', d => { d.members[1].owned_paths = ['scripts']; }, 'DECISION_SCOPE_UNSUPPORTED'],
  ['unsupported docs path', d => { d.members[0].owned_paths = ['REMOTE-AUTH.md']; }, 'DECISION_SCOPE_UNSUPPORTED']
]) test(`decision rejects ${name}`, () => {
  const value = decision(); mutate(value);
  assert.throws(() => validateDecision(JSON.stringify(value), roster), error => error.code === code);
});

test('legacy single documentation output remains accepted', () => {
  assert.equal(validateDecision(JSON.stringify({ member: roster.members[1].logical_member_id, reason: 'Document the workflow.' }), roster).selections.length, 1);
});

test('Lead prompt and executable check agree on multi-member validation', () => scratch(dir => {
  const plan = buildLeadPlan({ ...options, title: 'Update documentation and coverage', body: 'Do bounded work.' });
  assert.match(plan.tasks[0].objective, /Select 1 to 3 unique/);
  assert.match(plan.tasks[0].objective, /owned_paths/);
  fs.mkdirSync(path.join(dir, 'routing'));
  const file = path.join(dir, 'routing', 'decision.json');
  const check = plan.integration.check_commands[0];
  fs.writeFileSync(file, JSON.stringify(decision()));
  assert.equal(spawnSync(process.execPath, check.argv.slice(1), { cwd: dir }).status, 0);
  const invalid = decision(); invalid.members[1].owned_paths = ['README.md'];
  fs.writeFileSync(file, JSON.stringify(invalid));
  assert.equal(spawnSync(process.execPath, check.argv.slice(1), { cwd: dir }).status, 1);
}));

function runOwnedTests(dir, scopes) {
  const value = decision();
  value.members[1].owned_paths = scopes;
  const plan = planFor(value);
  const check = plan.integration.check_commands.find(command => command.name === 'verify-member-tests');
  assert.deepEqual(JSON.parse(check.argv[3]), scopes);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, check.argv.slice(1), { cwd: dir, encoding: 'utf8', env });
}
function writeTestFile(dir, file, content) {
  const target = path.join(dir, ...file.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
const passingTest = name => `require('node:test')(${JSON.stringify(name)}, () => {});`;

test('member check runs only concrete owned script tests without requiring dispatcher tests', () => scratch(dir => {
  writeTestFile(dir, 'scripts/owned.test.cjs', passingTest('owned-script'));
  writeTestFile(dir, 'scripts/unowned.test.cjs', 'throw new Error("unowned test ran");');
  const result = runOwnedTests(dir, ['scripts/owned.test.cjs']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /owned-script/);
  assert.doesNotMatch(result.stdout, /unowned test ran/);
}));

test('member check runs only concrete owned dispatcher tests and not helper files', () => scratch(dir => {
  writeTestFile(dir, 'dispatcher/test/nested/owned.test.js', passingTest('owned-dispatcher'));
  writeTestFile(dir, 'dispatcher/test/helper.js', 'throw new Error("helper ran as test");');
  writeTestFile(dir, 'dispatcher/test/helper.test.cjs', 'throw new Error("wrong extension ran");');
  writeTestFile(dir, 'dispatcher/test/unowned.test.js', 'throw new Error("unowned test ran");');
  const result = runOwnedTests(dir, ['dispatcher/test/nested/owned.test.js']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /owned-dispatcher/);
}));

test('dispatcher wildcard recursively selects only test.js files and deduplicates sorted owned tests', () => scratch(dir => {
  writeTestFile(dir, 'dispatcher/test/z.test.js', passingTest('owned-z'));
  writeTestFile(dir, 'dispatcher/test/nested/a.test.js', passingTest('owned-a'));
  writeTestFile(dir, 'dispatcher/test/helper.js', 'throw new Error("helper ran as test");');
  writeTestFile(dir, 'dispatcher/test/other.test.cjs', 'throw new Error("wrong extension ran");');
  writeTestFile(dir, 'scripts/unowned.test.cjs', 'throw new Error("unowned test ran");');
  const result = runOwnedTests(dir, ['dispatcher/test/z.test.js', 'dispatcher/test/**', 'dispatcher/test/z.test.js']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /\btests 2\b/);
  assert.ok(result.stdout.indexOf('owned-a') < result.stdout.indexOf('owned-z'), result.stdout);
}));

test('member check propagates an owned test failure', () => scratch(dir => {
  writeTestFile(dir, 'scripts/owned.test.cjs', 'throw new Error("owned failure fixture");');
  const result = runOwnedTests(dir, ['scripts/owned.test.cjs']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /owned failure fixture/);
}));

for (const file of ['scripts/missing.test.cjs', 'dispatcher/test/nested/missing.test.js']) {
  test(`member check clearly fails for missing owned test ${file}`, () => scratch(dir => {
    writeTestFile(dir, 'scripts/unowned.test.cjs', passingTest('must-not-run'));
    const result = runOwnedTests(dir, [file]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`Owned test file does not exist after integration: ${file}`), result.stderr);
    assert.doesNotMatch(result.stdout, /must-not-run/);
  }));
}

test('member check fails closed for empty wildcard matches and non-test-only scopes', () => scratch(dir => {
  writeTestFile(dir, 'dispatcher/test/helper.js', 'throw new Error("helper ran as test");');
  for (const scopes of [['dispatcher/test/**']]) {
    const result = runOwnedTests(dir, scopes);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No owned test files matched after integration/);
  }
}));

test('member plan rejects unsafe test paths before constructing command arguments', () => {
  for (const scope of ['scripts/evil.test.cjs;echo', 'scripts/../escape.test.cjs', 'dispatcher/test/../../escape.test.js', 'dispatcher/test/file.test.js\n', 'scripts/*.test.cjs']) {
    const value = decision(); value.members[1].owned_paths = [scope];
    assert.throws(() => buildMemberPlan({ ...options, selections: value.members.map(entry => ({ ...entry, member: roster.members.find(candidate => candidate.logical_member_id === entry.member) })) }), /DECISION_SCOPES?_/);
  }
});

test('one integration dispatch contains both tasks', () => {
  const plan = planFor();
  const infos = plan.tasks.map(task => ({ task, sha256: 'b'.repeat(64), changedPaths: task.owned_paths, result: { status: 'succeeded' } }));
  const dispatch = buildIntegrationDispatch(plan, infos);
  assert.equal(dispatch.tasks.length, 2);
  const validation = validateContract('integration-dispatch.schema.json', dispatch, plan);
  assert.equal(validation.valid, true, validation.errors.join('; '));
  assert.deepEqual(dispatch.tasks.map(task => task.task_id), plan.tasks.map(task => task.task_id).sort());
});

test('any required task failure blocks integration before creating a sandbox', async () => {
  const plan = planFor();
  const summary = await runIntegrationPhase({ plan, taskSummaries: plan.tasks.map((task, index) => ({ task_id: task.task_id, status: index ? 'failed' : 'succeeded' })), client: { create() { throw new Error('must not create'); } } });
  assert.equal(summary.status, 'skipped');
  assert.equal(summary.failed_task_id, plan.tasks[1].task_id);
});

test('publisher lifecycle namespace never collides with squad member labels', () => {
  assert.deepEqual(LIFECYCLE_LABELS, ['sandbox:processing', 'sandbox:queued', 'sandbox:revising', 'sandbox:failed']);
  assert.ok(LIFECYCLE_LABELS.every(label => !/^squad:/.test(label)));
});

test('publisher body and commit attribute every member and preserve co-author', () => {
  const tasks = withTaskRoles(planFor().tasks, roster);
  const body = prBody({ repoFullName: options.repository, issueNumber: 7, executionId: 'test-run', baselineSha: 'a'.repeat(40), sha256: 'b'.repeat(64), tasks });
  assert.match(body, /Persistent name \| Role \|/);
  for (const task of tasks) {
    assert.ok(body.includes(sanitizeUntrusted(task.owner.resolved_persistent_name, "name")));
    assert.ok(body.includes(sanitizeUntrusted(task.owner.role, "role")));
  }
  const message = commitMessage({ tasks: [...tasks, tasks[0]], subject: 'Test publish', issueNumber: 7, issueTitle: 'Test request', executionId: 'test-run', branch: 'test-branch', identity: { name: 'test-publisher[bot]', email: '123+test-publisher[bot]@users.noreply.github.com' } });
  const trailers = message.split('\n').filter(line => line.startsWith('Squad-Contributor:'));
  assert.equal(trailers.length, 2);
  for (const task of tasks) assert.ok(trailers.includes(`Squad-Contributor: ${task.owner.resolved_persistent_name} (${task.owner.role})`));
  assert.ok(message.includes('Co-authored-by: test-publisher[bot] <123+test-publisher[bot]@users.noreply.github.com>'));
});

test('publisher creates missing lifecycle labels without altering member labels', async () => {
  const client = Object.create(RealGitHubClient.prototype);
  const calls = [];
  client.request = async (method, resource, body) => {
    calls.push({ method, resource, body });
    if (method === 'GET') throw Object.assign(new Error('missing'), { statusCode: 404 });
    return {};
  };
  await client.setIssueLabels({ owner: 'test-owner', repo: 'test-repo', issueNumber: 7, add: ['sandbox:queued'], remove: ['sandbox:processing'] });
  assert.ok(calls.some(call => call.body?.name === 'sandbox:queued'));
  assert.ok(calls.some(call => call.body?.labels?.includes('sandbox:queued')));
  assert.ok(!JSON.stringify(calls).includes('squad:'));
  await assert.rejects(() => client.setIssueLabels({ add: ['squad:test-member'] }), /sandbox lifecycle/);
});

test('publisher labels the PR number and source issue separately with all routed member labels', async () => {
  const tasks = withTaskRoles(planFor().tasks, roster);
  const client = new FakeGitHubClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    const labels = await labelPublication(client, { owner: 'test-owner', repo: 'test-repo', issueNumber: 7, prNumber: 12, tasks: [...tasks, tasks[0]], roster });
    assert.deepEqual(labels, { added: ['sandbox:queued'], removed: ['sandbox:processing', 'sandbox:failed'] });
  }
  const definitions = memberLabelDefinitions(roster.members.map(member => ({ name: member.resolved_persistent_name, role: member.role })));
  const prCalls = client.labels.filter(call => call.issueNumber === 12);
  assert.equal(prCalls.length, 4);
  assert.deepEqual(prCalls[0].add, ['sandbox:queued']);
  assert.deepEqual(prCalls[1].add, definitions.slice(1, 3).map(label => label.name));
  assert.deepEqual(prCalls.slice(0, 2), prCalls.slice(2));
  assert.equal(client.labels.filter(call => call.issueNumber === 7).length, 2);
});

test('publisher ensures routed member labels on the PR using the shared palette', async () => {
  const client = Object.create(RealGitHubClient.prototype);
  const calls = [];
  client.request = async (method, resource, body) => {
    calls.push({ method, resource, body });
    if (method === 'GET' || method === 'DELETE') throw Object.assign(new Error('missing'), { statusCode: 404 });
    return {};
  };
  const definitions = memberLabelDefinitions([{ name: 'Test Writer', role: 'Documentation' }, { name: 'Test Checker', role: 'Tests' }]);
  await client.setPullRequestLabels({ owner: 'test-owner', repo: 'test-repo', prNumber: 12, memberLabels: definitions });
  for (const label of definitions) assert.ok(calls.some(call => call.method === 'POST' && call.resource.endsWith('/labels') && JSON.stringify(call.body) === JSON.stringify(label)));
  const additions = calls.filter(call => call.body?.labels);
  assert.ok(additions.every(call => call.resource === '/repos/test-owner/test-repo/issues/12/labels'));
  assert.deepEqual(additions.flatMap(call => call.body.labels), ['sandbox:queued', ...definitions.map(label => label.name)]);
  assert.ok(!calls.some(call => /squad:(queued|processing|failed|revising)/.test(call.resource)));
});

test('publisher does not swallow PR label authorization errors', async () => {
  const client = new FakeGitHubClient();
  client.setPullRequestLabels = async () => { throw Object.assign(new Error('issues write denied'), { statusCode: 403 }); };
  await assert.rejects(() => labelPublication(client, { owner: 'test-owner', repo: 'test-repo', issueNumber: 7, prNumber: 12, tasks: planFor().tasks, roster }), /issues write denied/);
  assert.equal(client.labels.length, 0);
  const realClient = Object.create(RealGitHubClient.prototype);
  realClient.request = async () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }); };
  await assert.rejects(() => realClient.setPullRequestLabels({ owner: 'test-owner', repo: 'test-repo', prNumber: 12, memberLabels: [] }), /forbidden/);
});

test('publisher resolves its bot identity from the authenticated App, not a fixed account', async () => {
  const client = Object.create(RealGitHubClient.prototype);
  client.jwt = () => 'test-app-jwt';
  client.token = 'test-installation-token';
  const calls = [];
  client.request = async (method, resource, body, token) => {
    calls.push({ method, resource, body, token });
    if (resource === '/app') return { slug: 'test-publisher' };
    return { login: 'test-publisher[bot]', id: 98765 };
  };
  assert.deepEqual(await client.getPublisherIdentity(), { name: 'test-publisher[bot]', email: '98765+test-publisher[bot]@users.noreply.github.com' });
  assert.deepEqual(calls.map(call => [call.method, call.resource, call.token]), [
    ['GET', '/app', 'test-app-jwt'], ['GET', '/users/test-publisher%5Bbot%5D', 'test-installation-token']
  ]);
});

for (const [name, app, bot] of [
  ['invalid slug', { slug: 'bad\nslug' }, {}],
  ['wrong bot', { slug: 'test-publisher' }, { login: 'other[bot]', id: 123 }],
  ['missing user id', { slug: 'test-publisher' }, { login: 'test-publisher[bot]' }]
]) test(`publisher rejects ${name} instead of falling back to a fixed identity`, async () => {
  const client = Object.create(RealGitHubClient.prototype);
  client.jwt = () => 'test-jwt';
  client.request = async (method, resource) => resource === '/app' ? app : bot;
  await assert.rejects(() => client.getPublisherIdentity(), /invalid/);
});

test('report preserves multiple objectives and identifies failed integration task', () => {
  const plan = planFor();
  const route = { reason: decision().reason, members: plan.tasks.map((task, index) => ({ ...task.owner, role: roster.members[index + 1].role, objective: decision().members[index].objective, owned_paths: task.owned_paths })) };
  const stored = summarizeStored({ status: 'failed', route, stages: { lead: {}, member: { status: 'failed', failed_task_id: plan.tasks[1].task_id } } });
  const comment = renderComment(stored, { publish: 'skipped' });
  for (const task of plan.tasks) assert.ok(comment.includes(task.owner.resolved_persistent_name));
  for (const selection of decision().members) assert.ok(comment.includes(selection.objective));
  assert.ok(comment.includes(`failed task: \`${plan.tasks[1].task_id}\``));
  assert.match(comment, /publish job: `skipped`/);
});

test('shared member color generation rejects ambiguous slugs and is stable', () => {
  const members = [{ name: 'Test Writer', role: 'Documentation' }, { name: 'Test Checker', role: 'Tests' }];
  const labels = memberLabelDefinitions(members);
  assert.deepEqual(labels, memberLabelDefinitions(members));
  assert.equal(labels[0].name, 'squad:test-writer');
  assert.match(labels[0].color, /^[A-F0-9]{6}$/);
  assert.throws(() => memberLabelDefinitions([...members, { name: 'Test-Writer', role: 'Other' }]), /Ambiguous/);
});

test('ensureLabel handles concurrent creation but propagates authorization errors', async () => {
  let reads = 0;
  const github = { rest: { issues: {
    getLabel: async () => { if (!reads++) throw Object.assign(new Error('missing'), { status: 404 }); },
    createLabel: async () => { throw Object.assign(new Error('exists'), { status: 422 }); }
  } } };
  await ensureLabel(github, {}, { name: 'squad:test-member' });
  assert.equal(reads, 2);
  github.rest.issues.getLabel = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
  await assert.rejects(() => ensureLabel(github, {}, { name: 'squad:test-member' }), /forbidden/);
});

test('report creates member labels and adds failed state on publication failure', () => scratch(async dir => {
  const team = path.join(dir, '.squad'); fs.mkdirSync(team);
  const root = path.resolve(__dirname, '..');
  const { loadRoster, supportedKind } = require('./issue-plan.cjs');
  const actual = loadRoster(root);
  const selected = actual.members.filter(member => member !== actual.lead && supportedKind(member)).map(member => ({ ...member, objective: 'Execute bounded work.', owned_paths: supportedKind(member) === 'documentation' ? ['README.md'] : supportedKind(member) === 'testing' ? ['dispatcher/test/**'] : supportedKind(member) === 'infrastructure' ? ['examples/terraform/**'] : ['agents/sandbox/**'] }));
  const result = { status: 'succeeded', route: { reason: 'Execute bounded work.', members: selected }, stages: { lead: { status: 'succeeded' }, member: { status: 'succeeded' } } };
  fs.writeFileSync(path.join(dir, 'issue-result.json'), JSON.stringify(result));
  const calls = [];
  const github = { rest: { issues: {
    getLabel: async () => { throw Object.assign(new Error('missing'), { status: 404 }); },
    createLabel: async request => calls.push(['create', request]),
    addLabels: async request => calls.push(['add', request]),
    createComment: async request => calls.push(['comment', request])
  } } };
  await postReport({ github, context: { repo: { owner: 'test-owner', repo: 'test-repo' }, issue: { number: 7 } }, root, reportDir: dir, jobs: { lead: 'success', member: 'success', publish: 'failure' } });
  assert.ok(calls.some(([kind, request]) => kind === 'add' && request.labels.includes('sandbox:failed')));
  const memberAdd = calls.find(([kind, request]) => kind === 'add' && request.labels.every(label => label.startsWith('squad:')));
  assert.equal(memberAdd[1].labels.length, selected.length);
  const comment = calls.find(([kind]) => kind === 'comment')[1].body;
  assert.match(comment, /publish job: `failure`/);
  assert.match(comment, /Status: `failed`/);
  for (const selection of selected) assert.ok(comment.includes(selection.objective));
}));

test('publication resolves roles without changing execution envelopes', () => {
  const plan = planFor();
  const tasks = withTaskRoles(plan.tasks, roster);
  assert.equal(tasks[0].owner.role, roster.members[1].role);
  assert.equal(Object.hasOwn(plan.tasks[0].owner, 'role'), false);
  const invalid = structuredClone(plan.tasks);
  invalid[0].owner.resolved_persistent_name = 'Test Impostor';
  assert.throws(() => withTaskRoles(invalid, roster), /identity/);
});

test('integration conflict preserves its explicit failed task and emits no publishable patch', () => scratch(async dir => {
  const plan = planFor();
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  for (const task of plan.tasks) {
    const taskDir = path.join(dir, 'tasks', task.task_id); fs.mkdirSync(taskDir, { recursive: true });
    const file = task.owned_paths[0];
    const patch = `diff --git a/${file} b/${file}\n`;
    fs.writeFileSync(path.join(taskDir, 'patch.patch'), patch);
    fs.writeFileSync(path.join(taskDir, 'artifact-manifest.json'), JSON.stringify({ artifacts: [{ kind: 'patch', path: 'patch.patch', sha256: hash(patch) }] }));
    fs.writeFileSync(path.join(taskDir, 'persona-result.json'), JSON.stringify({ status: 'succeeded' }));
  }
  const failedId = plan.tasks[1].task_id;
  const metadata = { schema_version: plan.schema_version, run_id: plan.run_id, provider: plan.provider, baseline_sha: plan.baseline_sha, roster: plan.roster };
  const result = { ...metadata, message_type: 'integration.result', status: 'failed', tasks: plan.tasks.map(task => ({ task_id: task.task_id, owner: task.owner, status: task.task_id === failedId ? 'failed' : 'succeeded' })), artifacts: [], failed_task_id: failedId, error: { code: 'PATCH_CONFLICT', message: 'Patch conflict for README.md' } };
  const bytes = Buffer.from(JSON.stringify(result));
  const manifest = { ...metadata, task_id: 'integration', artifacts: [{ artifact_id: 'result', kind: 'report', path: 'integration-result.json', sha256: hash(bytes) }] };
  const bundlePath = path.join(dir, 'baseline.bundle'); fs.writeFileSync(bundlePath, 'offline fixture');
  let deleted = false;
  const client = {
    create: async () => ({ id: 'test-integration' }), putFile: async () => {},
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    readFile: async (_handle, name) => name.endsWith('/integration-result.json') ? bytes : Buffer.from(JSON.stringify(manifest)),
    delete: async () => { deleted = true; }
  };
  const summary = await runIntegrationPhase({ plan, taskSummaries: plan.tasks.map(task => ({ task_id: task.task_id, status: 'succeeded' })), outDir: dir, client, bundlePath, config: { clientKind: 'fixture' }, token: 'offline-fake-token-not-a-credential', log: () => {}, projectRoot: dir });
  assert.equal(summary.status, 'failed');
  assert.equal(summary.failed_task_id, failedId);
  assert.equal(summary.integrated_patch_path, '');
  assert.equal(deleted, true);
}));

test('testing-only and reversed two-member decisions keep their individual scopes', () => {
  const single = decision(); single.members = [single.members[1]];
  const plan = planFor(single);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].owner.logical_member_id, roster.members[2].logical_member_id);
  assert.deepEqual(plan.integration.check_commands.map(check => check.name), ['verify-member-tests']);
  const reversed = decision(); reversed.members.reverse();
  assert.equal(planFor(reversed).tasks.length, 2);
});
