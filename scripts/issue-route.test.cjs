'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { loadRoster, supportedKind } = require('./issue-plan.cjs');
const { addedDecisionContent, route, validateDecision } = require('./issue-route.cjs');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'haflidif/squad-on-aca';
const ENV = { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '1' };
const ROSTER = loadRoster(ROOT);
const IMPLEMENTER = ROSTER.members.find(member => supportedKind(member) === 'implementation');
const TESTER = ROSTER.members.find(member => supportedKind(member) === 'testing');

function scratch(run) {
  const dir = path.join(ROOT, `.issue-route-test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir);
  try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function event() {
  return {
    action: 'labeled', label: { name: 'sandbox-run' }, repository: { full_name: REPO },
    sender: { login: 'haflidif', type: 'User' },
    issue: { number: 42, state: 'open', author_association: 'OWNER', title: 'Issue title', body: 'Issue body' }
  };
}

function decisionPatch(member, reason = 'Implement the requested product change.') {
  let decision;
  if (typeof member === 'object') decision = member;
  else {
    const selected = ROSTER.members.find(candidate => candidate.logical_member_id === member);
    const kind = supportedKind(selected);
    const scope = kind === 'testing' ? 'dispatcher/test/**' : kind === 'infrastructure' ? 'infra/terraform/**' : 'agents/sandbox/**';
    decision = { reason, members: [{ member, objective: 'Complete the bounded issue objective.', owned_paths: [scope] }] };
  }
  const content = JSON.stringify(decision, null, 2).split('\n');
  return [
    'diff --git a/routing/decision.json b/routing/decision.json',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/routing/decision.json',
    `@@ -0,0 +1,${content.length} @@`,
    ...content.map(line => `+${line}`),
    ''
  ].join('\n');
}
function makeFixture(dir, patch, patchPath = 'integration/patches/merged.patch') {
  const out = path.join(dir, 'out');
  fs.mkdirSync(path.join(out, 'integration', 'patches'), { recursive: true });
  fs.writeFileSync(path.join(out, 'integration', 'patches', 'merged.patch'), patch);
  const summary = path.join(out, 'dispatcher-summary.json');
  const sha256 = crypto.createHash('sha256').update(patch).digest('hex');
  fs.writeFileSync(summary, JSON.stringify({ status: 'succeeded', integration: { status: 'succeeded', integrated_patch_path: patchPath, sha256 } }));
  const eventFile = path.join(dir, 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify(event()));
  const routeOut = path.join(dir, 'route-out');
  return { summary, summaryFile: summary, eventFile, out: routeOut, outDir: routeOut };
}

function routeFixture(dir, member, reasonText) {
  return makeFixture(dir, decisionPatch(member, reasonText));
}

test('added decision content is extracted only from the new expected file', () => {
  const content = addedDecisionContent(decisionPatch(IMPLEMENTER.logical_member_id));
  assert.deepEqual(JSON.parse(content), { reason: 'Implement the requested product change.', members: [{ member: IMPLEMENTER.logical_member_id, objective: 'Complete the bounded issue objective.', owned_paths: ['agents/sandbox/**'] }] });
});

test('route builds a member plan from the lead integration patch', () => scratch(dir => {
  const files = routeFixture(dir, IMPLEMENTER.logical_member_id);
  const result = route({ ...files, env: ENV, repoRoot: ROOT });
  assert.equal(result.member, IMPLEMENTER.logical_member_id);
  const routeResult = JSON.parse(fs.readFileSync(path.join(files.out, 'route-result.json'), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(files.out, 'member-plan.json'), 'utf8'));
  assert.equal(routeResult.member.logical_member_id, IMPLEMENTER.logical_member_id);
  assert.equal(routeResult.reason, 'Implement the requested product change.');
  assert.equal(plan.tasks[0].owner.logical_member_id, IMPLEMENTER.logical_member_id);
  assert.equal(plan.tasks[0].owner.resolved_persistent_name, IMPLEMENTER.resolved_persistent_name);
  assert.deepEqual(plan.tasks[0].owned_paths, ['agents/sandbox/**']);
}));

test('route rejects lead and non-roster selections', () => {
  for (const member of [ROSTER.lead.logical_member_id, 'unknown-member']) {
    assert.throws(() => validateDecision(JSON.stringify({ member, reason: 'Not an implementer.' }), ROSTER), error => error.code === 'ROUTED_MEMBER_REJECTED');
  }
});

test('route fails closed for active non-implementation roles', () => {
  const unsupported = ROSTER.members.find(member => member !== ROSTER.lead && !supportedKind(member));
  if (!unsupported) return;
  scratch(dir => {
    const files = routeFixture(dir, unsupported.logical_member_id);
    assert.throws(() => route({ ...files, env: ENV, repoRoot: ROOT }), error => error.code === 'MEMBER_NOT_SUPPORTED');
  });
});

for (const [name, patch] of [
  ['multiple changed files', decisionPatch(IMPLEMENTER.logical_member_id) + decisionPatch(IMPLEMENTER.logical_member_id).replaceAll('routing/decision.json', 'README.md')],
  ['modified rather than added target', decisionPatch(IMPLEMENTER.logical_member_id).replace('--- /dev/null', '--- a/routing/decision.json')],
  ['wrong destination', decisionPatch(IMPLEMENTER.logical_member_id).replaceAll('routing/decision.json', '../outside.json')],
  ['context diff line', decisionPatch(IMPLEMENTER.logical_member_id).replace(/^\+/m, ' ', 1)]
]) {
  test(`patch parser rejects ${name}`, () => {
    assert.throws(() => addedDecisionContent(patch));
  });
}

test('route rejects unsafe reason values and extra JSON properties', () => {
  assert.throws(() => validateDecision(JSON.stringify({ member: IMPLEMENTER.logical_member_id, reason: 'bad\nreason' }), ROSTER), error => error.code === 'DECISION_SHAPE_INVALID');
  assert.throws(() => validateDecision(JSON.stringify({ reason: 'short', extra: true, members: [{ member: IMPLEMENTER.logical_member_id, objective: 'Update code.', owned_paths: ['agents/sandbox/**'] }] }), ROSTER), error => error.code === 'DECISION_SHAPE_INVALID');
});

test('summary patch path containment rejects traversal', () => scratch(dir => {
  const files = routeFixture(dir, IMPLEMENTER.logical_member_id);
  const summary = JSON.parse(fs.readFileSync(files.summary, 'utf8'));
  summary.integration.integrated_patch_path = '../event.json';
  fs.writeFileSync(files.summary, JSON.stringify(summary));
  assert.throws(() => route({ ...files, env: ENV, repoRoot: ROOT }), error => error.code === 'PATCH_PATH_INVALID');
}));

test('lead stage failure prevents routing', () => scratch(dir => {
  const files = routeFixture(dir, IMPLEMENTER.logical_member_id);
  const summary = JSON.parse(fs.readFileSync(files.summary, 'utf8'));
  summary.status = 'failed';
  fs.writeFileSync(files.summary, JSON.stringify(summary));
  assert.throws(() => route({ ...files, env: ENV, repoRoot: ROOT }), error => error.code === 'LEAD_STAGE_NOT_SUCCEEDED');
}));

test('route emits one two-task member plan and preserves both routed objectives', () => scratch(dir => {
  const tester = ROSTER.members.find(member => member !== ROSTER.lead && supportedKind(member) === 'testing');
  assert.ok(tester);
  const decision = { reason: 'Independent implementation and regression coverage.', members: [
    { member: IMPLEMENTER.logical_member_id, objective: 'Update the container runner.', owned_paths: ['agents/sandbox/**'] },
    { member: tester.logical_member_id, objective: 'Add focused regression coverage.', owned_paths: ['scripts/example.test.cjs'] }
  ] };
  const files = makeFixture(dir, decisionPatch(decision));
  const result = route({ ...files, env: ENV, repoRoot: ROOT });
  assert.deepEqual(result.members, decision.members.map(member => member.member));
  const routed = JSON.parse(fs.readFileSync(path.join(files.outDir, 'route-result.json'), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(files.outDir, 'member-plan.json'), 'utf8'));
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(routed.members.map(member => member.objective), decision.members.map(member => member.objective));
  assert.deepEqual(plan.tasks.map(task => task.owned_paths), decision.members.map(member => member.owned_paths));
}));
