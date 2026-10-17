const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { buildMemberPlan } = require('../../scripts/issue-plan.cjs');
const { runIntegrationPhase } = require('../integrate');
const { validateContract } = require('../../contracts/aca-sandbox/v1/tools/validate');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const member = id => ({ logical_member_id: id, resolved_persistent_name: `Test ${id}`, role: 'Documentation', charter_ref: `.squad/agents/${id}/charter.md`, membership: 'persona', capabilities: ['writing'] });

async function fixture(patches, run) {
  const outDir = path.join(__dirname, '..', '..', `.empty-integration-test-${crypto.randomUUID()}`);
  fs.mkdirSync(outDir);
  try {
    const members = patches.map((_, index) => member(`test-member-${index}`));
    const plan = buildMemberPlan({ repository: 'test-owner/test-repo', issueNumber: 7, runId: '123', attempt: '1', roster: { members, lead: { ...member('test-lead'), role: 'Lead' } },
      member: members[0] });
    plan.tasks = members.map((owner, index) => ({ ...plan.tasks[0], task_id: `test-task-${index}`, owner: plan.roster.members[index], owned_paths: [`docs/member-${index}.md`] }));
    plan.baseline_sha = 'a'.repeat(40);
    plan.tasks.forEach((task, index) => {
      task.baseline_sha = plan.baseline_sha;
      const root = path.join(outDir, 'tasks', task.task_id);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'change.patch'), patches[index]);
      fs.writeFileSync(path.join(root, 'persona-result.json'), '{}');
      fs.writeFileSync(path.join(root, 'artifact-manifest.json'), JSON.stringify({ artifacts: [{ kind: 'patch', path: 'change.patch', sha256: hash(patches[index]) }] }));
    });
    const bundlePath = path.join(outDir, 'baseline.bundle');
    fs.writeFileSync(bundlePath, 'test bundle');
    const invocation = { plan, outDir, bundlePath, config: { clientKind: 'aca', image: 'pinned-test-image' }, token: '', log() {}, projectRoot: path.resolve(__dirname, '..', '..'),
      taskSummaries: plan.tasks.map(task => ({ task_id: task.task_id, status: 'succeeded' })) };
    await run(invocation);
  } finally { fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3 }); }
}

for (const count of [1, 2]) test(`all ${count} empty patches synthesize a contract-valid stage result without sandbox calls or checks`, () => fixture(Array(count).fill(''), async invocation => {
  invocation.plan.integration.check_commands = [{ name: 'must-not-run', argv: ['never-run'] }];
  invocation.client = new Proxy({}, { get() { assert.fail('No integration client operation allowed'); } });
  const result = await runIntegrationPhase(invocation);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.reason, 'NO_CHANGES');
  assert.equal(result.sandbox_id, '');
  assert.deepEqual(result.check_results, []);
  const bytes = fs.readFileSync(path.join(invocation.outDir, result.integrated_patch_path));
  assert.equal(bytes.length, 0);
  assert.equal(result.sha256, hash(bytes));
  const manifest = JSON.parse(fs.readFileSync(path.join(invocation.outDir, 'integration', 'artifact-manifest.json')));
  assert.equal(validateContract('artifact-manifest.schema.json', manifest, invocation.plan).valid, true);
}));

const nonEmptyPatch = index => `diff --git a/docs/member-${index}.md b/docs/member-${index}.md\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/member-${index}.md\n@@ -0,0 +1 @@\n+member ${index}\n`;
for (const patches of [
  ['', nonEmptyPatch(1)],
  [nonEmptyPatch(0), '']
]) test(`only zero-byte patches are omitted: ${JSON.stringify(patches.map(patch => patch.length))}`, () => fixture(patches, async invocation => {
  invocation.plan.tasks[1].dependencies = [{ task_id: invocation.plan.tasks[0].task_id, condition: 'succeeded' }];
  const uploads = new Map();
  let created = 0, deleted = 0;
  invocation.client = {
    async create() { created++; return { id: 'test-integration' }; },
    async putFile(handle, name, bytes) { uploads.set(name, bytes); },
    async execWithEnvironment() { throw new Error('TEST_INVALID_PATCH_REJECTED'); },
    async delete() { deleted++; }
  };
  const result = await runIntegrationPhase(invocation);
  assert.equal(created, 1);
  assert.equal(deleted, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'TEST_INVALID_PATCH_REJECTED');
  const envelope = JSON.parse(uploads.get('/workspace/integration/integration-dispatch.json'));
  const kept = patches.findIndex(bytes => bytes.length > 0);
  assert.deepEqual(envelope.tasks.map(task => task.task_id), [invocation.plan.tasks[kept].task_id]);
  assert.deepEqual(envelope.tasks[0].dependencies, []);
  assert.equal(validateContract('integration-dispatch.schema.json', envelope, invocation.plan).valid, true);
  assert.deepEqual(envelope.check_commands, invocation.plan.integration.check_commands);
  const sentPatches = [...uploads].filter(([name]) => name.endsWith('.patch'));
  assert.equal(sentPatches.length, 1);
  assert.equal(sentPatches[0][1].toString(), patches[kept]);
  assert.ok(sentPatches.every(([, bytes]) => bytes.length > 0));
}));

test('empty patches are hash-verified before the no-sandbox shortcut', () => fixture(['', ''], async invocation => {
  const manifestFile = path.join(invocation.outDir, 'tasks', invocation.plan.tasks[1].task_id, 'artifact-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.artifacts[0].sha256 = 'b'.repeat(64);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  invocation.client = new Proxy({}, { get() { assert.fail('No sandbox allowed for tampered artifacts'); } });
  const result = await runIntegrationPhase(invocation);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /sha256 mismatch/);
}));
