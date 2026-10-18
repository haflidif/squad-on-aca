'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseCommand, validateRequest, HINT, assertHeadUnchanged, transitionLabels, conflictHints, requireCurrentMain, validateBaseline } = require('./issue-revise.cjs');
const repository = 'test-owner/test-repo';
const BOT_LOGIN = 'example-app[bot]';
const env = { GITHUB_REPOSITORY: repository, SQUAD_ISSUE_NUMBER: '11', SQUAD_ISSUE_FLOW_ENABLED: 'true', SQUAD_ISSUE_OPT_IN_NUMBER: '11' };
const member = (id, role) => ({ logical_member_id: id, role, resolved_persistent_name: id });
const roster = { members: [member('test-docs', 'Documentation'), member('test-infra', 'Infrastructure'), member('test-tester', 'Testing')] };
function request() {
  return { event: { action: 'created', issue: { number: 12, pull_request: {} }, comment: { id: 123, author_association: 'OWNER', user: { type: 'User', login: 'test-maintainer' }, body: '/squad revise test-infra: Improve the module.' } },
    pr: { number: 12, state: 'open', user: { login: BOT_LOGIN, type: 'Bot' }, head: { ref: 'squad/aca-sandbox/issue-11-test-request', sha: 'a'.repeat(40), repo: { full_name: repository } }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: repository } }, labels: roster.members.map(member => ({ name: `squad:${member.resolved_persistent_name}` })) } };
}
test('manual parser accepts instructions and member targets, preserving shell text as data', () => {
  assert.deepEqual(parseCommand('/squad revise Fix this.'), { target: null, instructions: 'Fix this.' });
  for (const target of ['test-docs', 'test-infra', 'test-tester']) assert.equal(parseCommand(`/squad revise ${target}: $(echo unsafe); \`payload\`\nmore`).target, target);
});
for (const body of ['', '/squad revise', '/squad revise docs:', 'junk /squad revise fix', '/squad reviser fix', '/squad revise fix\0', '/squad revise fix /squad revise twice', '/squad revise ' + 'a'.repeat(8001)]) test(`reject junk command ${JSON.stringify(body.slice(0, 50))}`, () => assert.throws(() => parseCommand(body), /REVISE_COMMAND_INVALID/));
test('syntactically valid but unassigned member targets are rejected', () => {
  const { event, pr } = request(); event.comment.body = '/squad revise unknown: Improve this.';
  assert.throws(() => validateRequest(event, pr, env, roster), /TARGET_NOT_ASSIGNED/);
});
test('all three trusted associations accepted, target maps only an assigned supported member', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const { event, pr } = request(); event.comment.author_association = association;
    assert.deepEqual(validateRequest(event, pr, env, roster).allowed_members, ['test-infra']);
  }
});
for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', null]) test(`untrusted association ${association} rejected`, () => {
  const { event, pr } = request(); event.comment.author_association = association;
  assert.throws(() => validateRequest(event, pr, env, roster), /NOT_TRUSTED/);
});
for (const [name, mutate] of [
  ['non-bot author', pr => { pr.user.type = 'User'; }],
  ['fork', pr => { pr.head.repo.full_name = 'test-fork/test-repo'; }], ['wrong branch', pr => { pr.head.ref = 'squad/other/issue-11'; }],
  ['branch traversal', pr => { pr.head.ref += '/../../main'; }], ['wrong issue', pr => { pr.head.ref = 'squad/aca-sandbox/issue-13-test'; }],
  ['closed', pr => { pr.state = 'closed'; }], ['wrong base', pr => { pr.base.ref = 'dev'; }]
]) test(`guard rejects ${name}`, () => { const { event, pr } = request(); mutate(pr); assert.throws(() => validateRequest(event, pr, env, roster)); });
test('unassigned target rejected and retired per-issue gates ignored', () => {
  const { event, pr } = request(); pr.labels = [];
  assert.throws(() => validateRequest(event, pr, env, roster), /TARGET_NOT_ASSIGNED/);
  const valid = request();
  assert.doesNotThrow(() => validateRequest(valid.event, valid.pr, { ...env, SQUAD_ISSUE_OPT_IN_NUMBER: '12' }, roster));
  assert.doesNotThrow(() => validateRequest(valid.event, valid.pr, { ...env, SQUAD_ISSUE_FLOW_ENABLED: 'false' }, roster));
});
test('head moved refuses publish while exact commit replay is idempotent', () => {
  assert.equal(assertHeadUnchanged('original', 'original', 'published'), 'push');
  assert.equal(assertHeadUnchanged('published', 'original', 'published'), 'existing');
  assert.throws(() => assertHeadUnchanged('unexpected', 'original', 'published'), /BRANCH_HEAD_MOVED/);
  assert.throws(() => assertHeadUnchanged(null, 'original', 'published'), /BRANCH_HEAD_MOVED/);
});
function api() {
  const calls = [];
  const labels = new Set();
  const github = { rest: { issues: {
    getLabel: async ({ name }) => { if (!labels.has(name)) throw Object.assign(new Error(), { status: 404 }); },
    createLabel: async ({ name }) => { labels.add(name); }, addLabels: async value => calls.push(['add', value]),
    removeLabel: async value => { calls.push(['remove', value]); throw Object.assign(new Error(), { status: 404 }); },
    createComment: async value => calls.push(['comment', value]), listComments: 'comments'
  }, pulls: { list: 'pulls' } } };
  return { github, calls, labels };
}
for (const success of [true, false]) test(`terminal labels clean both issue and PR on ${success ? 'success' : 'failure'}`, async () => {
  const { github, calls, labels } = api();
  await transitionLabels(github, { owner: 'test-owner', repo: 'test-repo' }, [11, 12], success);
  assert.ok(labels.has(success ? 'sandbox:ready' : 'sandbox:failed'));
  for (const number of [11, 12]) {
    assert.ok(calls.some(([type, value]) => type === 'add' && value.issue_number === number && value.labels[0] === (success ? 'sandbox:ready' : 'sandbox:failed')));
    for (const label of ['sandbox:queued', 'sandbox:revising', success ? 'sandbox:failed' : 'sandbox:ready']) assert.ok(calls.some(([type, value]) => type === 'remove' && value.issue_number === number && value.name === label));
  }
});
test('revising label is self-healing and clears stale terminal states', async () => {
  const { github, calls, labels } = api();
  await transitionLabels(github, {}, [11, 12], false, true);
  await transitionLabels(github, {}, [11, 12], false, true);
  assert.ok(labels.has('sandbox:revising'));
  assert.ok(calls.some(([type, value]) => type === 'remove' && value.name === 'sandbox:ready'));
});
test('conflict hints dedupe bot comments, ignore spoofed markers and unknown mergeability', async () => {
  const { github, calls } = api(), { pr } = request();
  let comments = [], mergeable = false;
  github.rest.pulls.get = async () => ({ data: { ...pr, mergeable } });
  github.paginate = async resource => resource === 'pulls' ? [pr, { ...pr, user: { type: 'User', login: 'test-human' } }] : comments;
  const options = { github, sleep: async () => {}, context: { repo: { owner: 'test-owner', repo: 'test-repo' } } };
  await conflictHints(options);
  assert.equal(calls.length, 1); assert.match(calls[0][1].body, /\/squad revise/);
  comments = [{ body: HINT, user: { type: 'Bot' } }];
  await conflictHints(options); assert.equal(calls.length, 1);
  comments = [{ body: HINT, user: { type: 'User' } }];
  await conflictHints(options); assert.equal(calls.length, 2);
  mergeable = null; comments = [];
  await conflictHints(options); assert.equal(calls.length, 2);
});

for (const [name, states, expectedReads, expectedComments] of [
  ['mergeable after update-branch', [{ mergeable: true, mergeable_state: 'clean' }], 1, 0],
  ['unknown remains unresolved', [{ mergeable: null, mergeable_state: 'unknown' }], 3, 0],
  ['UNKNOWN state without a boolean', [{ mergeable_state: 'UNKNOWN' }], 1, 0],
  ['dirty state without a boolean', [{ mergeable_state: 'dirty' }], 1, 0],
  ['unknown becomes mergeable', [{ mergeable: null }, { mergeable: true, mergeable_state: 'clean' }], 2, 0],
  ['unknown becomes conflicted', [{ mergeable: null }, { mergeable: false, mergeable_state: 'dirty' }], 2, 1],
  ['explicit conflict', [{ mergeable: false, mergeable_state: 'dirty' }], 1, 1]
]) test(`conflict hint requires explicit false: ${name}`, async () => {
  const { github, calls } = api(), { pr } = request();
  let reads = 0, sleeps = 0, commentReads = 0;
  github.rest.pulls.get = async () => ({ data: { ...pr, ...states[Math.min(reads++, states.length - 1)] } });
  github.paginate = async resource => {
    if (resource === 'pulls') return [pr];
    commentReads++;
    return [];
  };
  await conflictHints({ github, context: { repo: { owner: 'test-owner', repo: 'test-repo' } }, sleep: async ms => {
    assert.equal(ms, 1000); sleeps++;
  } });
  assert.equal(reads, expectedReads);
  assert.equal(sleeps, expectedReads - 1);
  assert.equal(commentReads, expectedComments);
  assert.equal(calls.length, expectedComments);
  if (expectedComments) assert.equal(calls[0][1].issue_number, pr.number);
});

test('workflow tokens grant PR and issue writes only to trusted metadata jobs', () => {
  const trusted = { contents: 'read', issues: 'write', 'pull-requests': 'write' };
  const dispatch = { contents: 'read', 'id-token': 'write', 'copilot-requests': 'write' };
  const expected = {
    'squad-sandbox-issue.yml': {
      gate: trusted, 'dispatch-lead': dispatch, 'dispatch-member': dispatch,
      postprocess: { contents: 'read' }, publish: { contents: 'read' }, report: trusted
    },
    'squad-sandbox-conflicts.yml': { hint: trusted }
  };
  for (const [filename, jobs] of Object.entries(expected)) {
    const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', filename), 'utf8').replace(/\r\n/g, '\n');
    assert.match(workflow, /^permissions: \{\}$/m, `${filename} denies workflow-wide permissions`);
    const actual = {};
    for (const [, job, body] of workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)) {
      const blocks = [...body.matchAll(/^    permissions:\n((?:^      [\w-]+: (?:read|write)\n)+)/gm)];
      assert.equal(blocks.length, 1, `${filename}/${job} has explicit job permissions`);
      actual[job] = Object.fromEntries([...blocks[0][1].matchAll(/^      ([\w-]+): (read|write)$/gm)].map(([, scope, access]) => [scope, access]));
    }
    assert.deepEqual(actual, jobs, filename);
  }
});

test('baseline object verification rejects behind main, symlinks and protected-code edits without checking out the PR', () => {
  const directory = path.join(__dirname, '..', `.revise-fixture-${crypto.randomUUID()}`); fs.mkdirSync(directory);
  const git = args => { const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', ...args], { cwd: directory, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  try {
    git(['init', '--quiet']);
    const squad = path.join(directory, '.squad'); fs.mkdirSync(path.join(squad, 'agents', 'test-infra'), { recursive: true });
    fs.writeFileSync(path.join(squad, 'team.md'), '| Name | Role | Charter | Status |\n| Fixture Lead | Lead | `.squad/agents/test-lead/charter.md` | Active |\n| Test Infra | Infrastructure | `.squad/agents/test-infra/charter.md` | Active |\n');
    fs.mkdirSync(path.join(squad, 'agents', 'test-lead'), { recursive: true });
    fs.writeFileSync(path.join(squad, 'agents', 'test-lead', 'charter.md'), '- **Name:** Fixture Lead\n');
    fs.writeFileSync(path.join(squad, 'agents', 'test-infra', 'charter.md'), '- **Name:** Test Infra\n');
    fs.writeFileSync(path.join(squad, 'sandbox-flow.json'), JSON.stringify({ version: 1, members: { infrastructure: { allowed_paths: ['README.md'] } } }));
    fs.writeFileSync(path.join(directory, 'README.md'), 'main\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'main']); const main = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(directory, 'README.md'), 'PR\n'); git(['add', '.']); const tree = git(['write-tree']); const head = git(['commit-tree', tree, '-p', main, '-m', 'PR']);
    const ctx = { main_sha: main, head_sha: head, allowed_members: ['test-infra'] };
    assert.doesNotThrow(() => validateBaseline(directory, ctx));
    assert.equal(git(['rev-parse', 'HEAD']), main);
    assert.throws(() => requireCurrentMain(directory, head, main), /Merge current main/);
    fs.mkdirSync(path.join(directory, 'scripts')); fs.writeFileSync(path.join(directory, 'scripts', 'production.cjs'), 'unsafe'); git(['add', '.']); const badTree = git(['write-tree']); const badHead = git(['commit-tree', badTree, '-p', main, '-m', 'unsafe']);
    assert.throws(() => validateBaseline(directory, { ...ctx, head_sha: badHead }), /SCOPE_REJECTED/);
    git(['reset', '--mixed', main]);
    git(['update-index', '--add', '--cacheinfo', `120000,${git(['hash-object', 'README.md'])},README.md`]); const linkTree = git(['write-tree']); const linkHead = git(['commit-tree', linkTree, '-p', main, '-m', 'symlink']);
    assert.throws(() => validateBaseline(directory, { ...ctx, head_sha: linkHead }), /SCOPE_REJECTED/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Lead routing cannot expand original membership or bypass a member target', () => {
  const { validateSelections } = require('./issue-revise.cjs');
  const select = id => ({ member: { logical_member_id: id } });
  assert.doesNotThrow(() => validateSelections({ allowed_members: ['test-infra'], target: 'test-infra' }, [select('test-infra')]));
  assert.throws(() => validateSelections({ allowed_members: ['test-infra'], target: 'test-infra' }, [select('test-docs')]), /ROUTE_REJECTED/);
  assert.throws(() => validateSelections({ allowed_members: ['test-infra', 'test-tester'], target: 'test-infra' }, [select('test-infra'), select('test-tester')]), /ROUTE_REJECTED/);
  assert.throws(() => validateSelections({ allowed_members: ['test-infra'], target: null }, [select('test-tester')]), /ROUTE_REJECTED/);
});

test('gate captures one baseline, rejects recapture on rerun, and skips already-published runs', async () => {
  const directory = path.join(__dirname, '..', `.revise-gate-${crypto.randomUUID()}`); fs.mkdirSync(directory);
  try {
    const members = [member('test-lead', 'Lead'), ...roster.members];
    const team = path.join(directory, '.squad'); fs.mkdirSync(team);
    fs.writeFileSync(path.join(team, 'team.md'), members.map(member => `| ${member.resolved_persistent_name} | ${member.role} | \`.squad/agents/${member.logical_member_id}/charter.md\` | Active |`).join('\n'));
    for (const member of members) { const folder = path.join(team, 'agents', member.logical_member_id); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'charter.md'), `- **Name:** ${member.resolved_persistent_name}\n`); }
    const { github, calls } = api(), { event, pr } = request();
    let comments = [];
    github.paginate = async () => comments;
    github.rest.pulls.get = async args => ({ data: args.mediaType ? 'diff --git a/README.md b/README.md\n' : pr });
    github.rest.repos = { getCommit: async () => ({ data: { sha: pr.base.sha } }) };
    github.rest.issues.get = async () => ({ data: { number: 11, state: 'open', author_association: 'OWNER', title: 'Test issue', body: 'Test work' } });
    const context = { eventName: 'issue_comment', payload: event, repo: { owner: 'test-owner', repo: 'test-repo' } };
    const environment = { ...env, GITHUB_SHA: pr.base.sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: path.join(directory, 'outputs') };
    const { prepare } = require('./issue-revise.cjs');
    await prepare({ github, context, root: directory, env: environment });
    const capture = path.join(directory, '.squad-issue', 'revise.json');
    assert.equal(JSON.parse(fs.readFileSync(capture)).head_sha, pr.head.sha);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)).request_pull, pr);
    const originalEvent = path.join(directory, 'original-event.json');
    fs.writeFileSync(originalEvent, JSON.stringify(event));
    assert.equal(require('./issue-revise.cjs').validateActionsRevise({ ...environment,
      GITHUB_WORKSPACE: directory, GITHUB_EVENT_NAME: 'issue_comment', GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_PATH: originalEvent, SQUAD_ISSUE_NUMBER: '11', SQUAD_REVISE_VALIDATED: 'true',
      SQUAD_ISSUE_FLOW_OPT_IN: '1'
    }).head_sha, pr.head.sha, 'gate artifact is directly consumable by the Actions guard');
    pr.head.sha = 'c'.repeat(40); environment.GITHUB_RUN_ATTEMPT = '2';
    await assert.rejects(() => prepare({ github, context, root: directory, env: environment }), /BRANCH_HEAD_MOVED/);
    fs.rmSync(capture);
    await assert.rejects(() => prepare({ github, context, root: directory, env: environment }), /CAPTURE_MISSING/);
    comments = [{ user: { login: BOT_LOGIN, type: 'Bot' }, body: '<!-- squad-revise:123 -->' }];
    await prepare({ github, context, root: directory, env: environment });
    assert.match(fs.readFileSync(environment.GITHUB_OUTPUT, 'utf8'), /already_published=true/);
    for (const number of [11, 12]) assert.ok(calls.some(([kind, value]) => kind === 'add' && value.issue_number === number && value.labels[0] === 'sandbox:ready'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('no-change revise report comments on PR and returns issue and PR to ready', async () => {
  const root = path.join(__dirname, '..', `.no-change-report-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(root, '.squad-issue'), { recursive: true });
  try {
    const { event, pr } = request();
    fs.writeFileSync(path.join(root, '.squad-issue', 'revise.json'), JSON.stringify(validateRequest(event, pr, env, roster)));
    const emptyHash = crypto.createHash('sha256').update('').digest('hex');
    fs.writeFileSync(path.join(root, 'issue-result.json'), JSON.stringify({ schema: 2, status: 'succeeded',
      stages: { lead: { status: 'succeeded' }, member: { status: 'succeeded', integration_status: 'succeeded', no_changes: true, hashes: { integration_patch_sha256: emptyHash } } },
      route: { member: { logical_member_id: 'test-infra', resolved_persistent_name: 'Test Infra' }, reason: 'Fixture.' }
    }));
    const { github, calls } = api();
    github.paginate = async () => [pr];
    await require('./issue-triage.cjs').postReport({ github, context: { repo: { owner: 'test-owner', repo: 'test-repo' }, issue: { number: 11 } }, root, reportDir: root,
      jobs: { lead: 'success', member: 'success', postprocess: 'skipped', publish: 'skipped' } });
    for (const number of [11, 12]) {
      assert.ok(calls.some(([type, value]) => type === 'add' && value.issue_number === number && value.labels.includes('sandbox:ready')));
      assert.ok(calls.some(([type, value]) => type === 'remove' && value.issue_number === number && value.name === 'sandbox:revising'));
    }
    assert.ok(!calls.some(([type, value]) => type === 'add' && value.labels.includes('sandbox:failed')));
    const comments = calls.filter(([type]) => type === 'comment');
    assert.equal(comments.length, 1);
    assert.equal(comments[0][1].issue_number, 12);
    assert.match(comments[0][1].body, /revise made no changes.*test-infra/s);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test('workflow skips postprocess and publish only on the member no-change output', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'squad-sandbox-issue.yml'), 'utf8');
  assert.match(workflow, /no_changes: \$\{\{ steps\.members\.outputs\.no_changes \}\}/);
  for (const job of ['postprocess', 'publish']) {
    const section = workflow.replace(/\r\n/g, '\n').split(`\n  ${job}:\n`)[1].split('\n    runs-on:')[0];
    assert.match(section, /needs\.dispatch-member\.outputs\.no_changes != 'true'/);
  }
});
