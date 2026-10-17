'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateRoutingDecision, buildMemberPlan, buildLeadPlan } = require('./issue-plan.cjs');
const { groupStages, runStages } = require('./issue-stages.cjs');
const { renderComment, summarizeStored, summarizeStage } = require('./issue-report.cjs');
const { validateContract } = require('../contracts/aca-sandbox/v1/tools/validate');
const { assertPublishableSummary } = require('../dispatcher/workflow-preflight');
const { commitMessage, validateIntegrationArtifacts } = require('../dispatcher/publish');
const member = (id, role) => ({ logical_member_id: id, resolved_persistent_name: `Test ${id}`, role, charter_ref: `.squad/agents/${id}/charter.md`, membership: 'persona', capabilities: ['writing'] });
const roster = { members: [member('test-lead', 'Lead'), member('test-builder', 'Infrastructure'), member('test-checker', 'Testing'), member('test-writer', 'Documentation')] };
roster.lead = roster.members[0];
const options = { repository: 'test-owner/test-repo', issueNumber: 7, runId: '123', attempt: '1', roster };
function decision() {
  return { reason: 'Tests depend on the implementation.', members: [
    { member: 'test-checker', objective: 'Test actual infrastructure.', owned_paths: ['scripts/fixture.test.cjs'], depends_on: ['test-builder'] },
    { member: 'test-writer', objective: 'Document the example.', owned_paths: ['README.md'] },
    { member: 'test-builder', objective: 'Implement infrastructure.', owned_paths: ['infra/config.json'] }
  ] };
}
function planFor(value = decision()) {
  return buildMemberPlan({ ...options, selections: validateRoutingDecision(value, roster).selections });
}
function scratch(run) {
  const directory = path.join(__dirname, '..', `.stage-test-${crypto.randomUUID()}`);
  fs.mkdirSync(directory);
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); }
}
function exec(binary, args, cwd, input) {
  const result = spawnSync(binary, args, { cwd, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const git = (cwd, args, input) => exec('git', ['-c', 'core.autocrlf=false', ...args], cwd, input);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function json(file, value) { write(file, JSON.stringify(value)); }
function fixture(directory) {
  const repo = path.join(directory, 'source');
  fs.mkdirSync(repo);
  git(repo, ['init', '--quiet']);
  const tree = git(repo, ['write-tree']).trim();
  const baseline = git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit-tree', tree], 'Fixture baseline\n').trim();
  git(repo, ['update-ref', 'HEAD', baseline]);
  const plan = planFor();
  plan.baseline_sha = baseline;
  plan.tasks.forEach(task => { task.baseline_sha = baseline; });
  const planPath = path.join(directory, 'plan.json');
  json(planPath, plan);
  return { repoPath: repo, planPath, outDir: path.join(directory, 'out'), maxAiCredits: 30, totalAiCredits: 90, plan };
}
function mockDispatch(calls, { failStage = 0, cleanupStage = 0, missingStage = 0, corruptStage = 0 } = {}) {
  return invocation => {
    const plan = JSON.parse(fs.readFileSync(invocation.planPath));
    const number = calls.length + 1;
    calls.push({ ...invocation, plan });
    if (missingStage === number) return 1;
    const workspace = path.join(invocation.outDir, 'workspace');
    fs.mkdirSync(invocation.outDir, { recursive: true });
    git(invocation.repoPath, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', invocation.repoPath, workspace]);
    git(workspace, ['checkout', '--quiet', '--detach', plan.baseline_sha]);
    if (number === 2) assert.equal(fs.readFileSync(path.join(workspace, 'infra', 'config.json'), 'utf8'), '{\"enabled\":true}\n');
    const contents = {
      'infra/config.json': '{\"enabled\":true}\n',
      'README.md': '# Example documentation\n',
      'scripts/fixture.test.cjs': 'const fs=require("node:fs");require("node:assert/strict").equal(fs.readFileSync("infra/config.json","utf8"),\'{\\"enabled\\":true}\\n\');\n'
    };
    const taskSummaries = [];
    for (const task of plan.tasks) {
      git(workspace, ['reset', '--hard', '--quiet', plan.baseline_sha]);
      const owned = task.owned_paths[0];
      write(path.join(workspace, owned), contents[owned]);
      git(workspace, ['add', '--', owned]);
      const bytes = git(workspace, ['diff', '--cached', '--binary', '--full-index']);
      const taskDir = path.join(invocation.outDir, 'tasks', task.task_id);
      write(path.join(taskDir, 'change.patch'), bytes);
      json(path.join(taskDir, 'artifact-manifest.json'), { artifacts: [{ kind: 'patch', path: 'change.patch', sha256: hash(bytes) }] });
      write(path.join(taskDir, 'sensitive.log'), 'DO_NOT_UPLOAD');
      taskSummaries.push({ task_id: task.task_id, logical_member_id: task.owner.logical_member_id, status: 'succeeded', reason: '', started_at: 'now', ended_at: 'now', sandbox_id: `fixture-${number}`, artifact_paths: [], deletion_error: '' });
    }
    git(workspace, ['reset', '--hard', '--quiet', plan.baseline_sha]);
    for (const task of plan.tasks) git(workspace, ['apply', '--index', path.join(invocation.outDir, 'tasks', task.task_id, 'change.patch')]);
    const checks = [];
    for (const check of plan.integration.check_commands) {
      exec(check.argv[0], check.argv.slice(1), workspace);
      checks.push({ name: check.name, status: 'passed' });
    }
    const bytes = git(workspace, ['diff', '--cached', '--binary', '--full-index']);
    write(path.join(invocation.outDir, 'integration', 'patches', 'combined.patch'), bytes);
    json(path.join(invocation.outDir, 'integration', 'artifact-manifest.json'), {
      schema_version: plan.schema_version, run_id: plan.run_id, task_id: 'integration', baseline_sha: plan.baseline_sha, roster: plan.roster, provider: plan.provider,
      artifacts: [{ artifact_id: 'patch', kind: 'patch', path: 'patches/combined.patch', sha256: hash(bytes) }]
    });
    if (corruptStage === number) write(path.join(invocation.outDir, 'tasks', plan.tasks[0].task_id, 'change.patch'), 'tampered');
    const failed = failStage === number || cleanupStage === number;
    json(path.join(invocation.outDir, 'dispatcher-summary.json'), {
      schema_version: plan.schema_version, message_type: 'dispatcher.summary', run_id: plan.run_id, status: failed ? 'failed' : 'succeeded', started_at: 'now', ended_at: 'now', tasks: taskSummaries,
      disk_image_deletion_error: cleanupStage === number ? 'cleanup failed' : '',
      integration: { status: failStage === number ? 'failed' : 'succeeded', reason: failed ? 'check failed' : 'integrated', sandbox_id: `integration-${number}`, integrated_patch_path: failStage === number ? '' : 'integration/patches/combined.patch', sha256: hash(bytes), failed_task_id: '', check_results: checks, deletion_error: '' }
    });
    return failed ? 1 : 0;
  };
}

test('dependency decision is accepted and reversed roster order groups into two stages', () => {
  const plan = planFor();
  plan.baseline_sha = 'a'.repeat(40); plan.tasks.forEach(task => { task.baseline_sha = plan.baseline_sha; });
  assert.equal(validateContract('coordinator-execution.schema.json', plan).valid, true);
  assert.deepEqual(groupStages(plan.tasks).map(stage => stage.map(task => task.owner.logical_member_id)), [['test-writer', 'test-builder'], ['test-checker']]);
});
for (const [name, mutate] of [
  ['self', d => { d.members[0].depends_on = ['test-checker']; }],
  ['unknown', d => { d.members[0].depends_on = ['test-missing']; }],
  ['cycle', d => { d.members[2].depends_on = ['test-checker']; }],
  ['three stages', d => { d.members[2].depends_on = ['test-writer']; }],
  ['duplicate dependencies', d => { d.members[0].depends_on.push('test-builder'); }],
  ['non-array dependencies', d => { d.members[0].depends_on = 'test-builder'; }],
  ['non-string dependencies', d => { d.members[0].depends_on = [null]; }]
]) test(`dependency validation rejects ${name}`, () => {
  const value = decision(); mutate(value);
  assert.throws(() => validateRoutingDecision(value, roster), { code: 'DECISION_DEPENDENCY_INVALID' });
});
test('legacy routes and empty dependency arrays remain single-stage', () => {
  for (const value of [
    { member: 'test-writer', reason: 'Document the example.' },
    { reason: 'Document the example.', members: [decision().members[1]] },
    { reason: 'Document the example.', members: [{ ...decision().members[1], depends_on: [] }] }
  ]) assert.equal(groupStages(planFor(value).tasks).length, 1);
});
test('multiple independent dependencies are allowed', () => {
  const value = decision(); value.members[0].depends_on.push('test-writer');
  assert.equal(groupStages(planFor(value).tasks).length, 2);
});
test('dependency metadata does not relax disjoint ownership', () => {
  const value = decision(); value.members[0].owned_paths = value.members[2].owned_paths;
  assert.throws(() => validateRoutingDecision(value, roster), { code: 'DECISION_SCOPES_OVERLAP' });
});
test('Lead executable validation includes generic dependency rules', () => scratch(directory => {
  const plan = buildLeadPlan({ ...options, title: 'Fixture', body: 'Fixture' });
  assert.match(plan.tasks[0].objective, /depends_on/);
  json(path.join(directory, 'routing', 'decision.json'), decision());
  const check = plan.integration.check_commands[0].argv;
  exec(check[0], check.slice(1), directory);
  const invalid = decision(); invalid.members[0].depends_on = ['test-checker'];
  json(path.join(directory, 'routing', 'decision.json'), invalid);
  assert.equal(spawnSync(check[0], check.slice(1), { cwd: directory }).status, 1);
}));

test('stages run once, stage 2 sees stage 1, final checks run once, final patch applies to original baseline', () => scratch(directory => {
  const config = fixture(directory), calls = [];
  const result = runStages(config, mockDispatch(calls));
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].plan.integration.check_commands.length, 0);
  assert.deepEqual(calls[1].plan.integration.check_commands.map(check => check.name), config.plan.integration.check_commands.map(check => check.name));
  assert.equal(calls[1].plan.tasks.length, 1);
  assert.notEqual(calls[1].plan.baseline_sha, config.plan.baseline_sha);
  assert.deepEqual(calls[1].plan.tasks[0].dependencies, []);
  assert.equal(result.tasks.length, 3);
  assert.equal(assertPublishableSummary(result, config.plan), result);
  assert.equal(validateContract('artifact-manifest.schema.json', JSON.parse(fs.readFileSync(path.join(config.outDir, 'integration', 'artifact-manifest.json'))), config.plan).valid, true);
  const patch = path.join(config.outDir, result.integration.integrated_patch_path);
  assert.equal(hash(fs.readFileSync(patch)), result.integration.sha256);
  assert.equal(validateIntegrationArtifacts(path.join(config.outDir, 'dispatcher-summary.json'), result).baselineSha, config.plan.baseline_sha);
  git(config.repoPath, ['apply', '--index', patch]);
  for (const check of config.plan.integration.check_commands) exec(check.argv[0], check.argv.slice(1), config.repoPath);
  assert.equal(git(config.repoPath, ['rev-parse', 'HEAD']).trim(), config.plan.baseline_sha);
  assert.equal(fs.existsSync(path.join(config.outDir, '.stage-work')), false);
  const credits = JSON.parse(fs.readFileSync(path.join(config.outDir, 'stage-results.json')));
  assert.equal(credits.reserved_ai_credits, 90);
  const message = commitMessage({ issueNumber: 7, executionId: config.plan.run_id, tasks: config.plan.tasks.map(task => ({ ...task, role: 'Fixture' })), identity: { login: 'test-bot[bot]', email: '1+test-bot[bot]@users.noreply.github.com' } });
  for (const task of config.plan.tasks) assert.ok(message.includes(`Squad-Contributor: ${task.owner.resolved_persistent_name}`));
}));
for (const failure of [{ failStage: 1 }, { cleanupStage: 1 }, { missingStage: 1 }, { corruptStage: 1 }]) test(`stage-1 failure stops dependent members: ${JSON.stringify(failure)}`, () => scratch(directory => {
  const config = fixture(directory), calls = [];
  const result = runStages(config, mockDispatch(calls, failure));
  assert.equal(result.status, 'failed');
  assert.equal(calls.length, 1);
  assert.equal(result.integration.integrated_patch_path, '');
  const stage = JSON.parse(fs.readFileSync(path.join(config.outDir, 'stage-results.json'))).stages[0];
  assert.equal(stage.status, 'failed');
  assert.equal(stage.stage, 1);
}));
test('stage-2 integration failure retains all member patches and the diagnostic combined patch without publishing', () => scratch(directory => {
  const config = fixture(directory), calls = [];
  const result = runStages(config, mockDispatch(calls, { failStage: 2 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.integration.integrated_patch_path, '');
  const combined = path.join(config.outDir, 'diagnostic-patches', 'combined.patch');
  git(config.repoPath, ['apply', '--check', combined]);
  assert.match(fs.readFileSync(combined, 'utf8'), /fixture.test.cjs/);
  for (const [index, call] of calls.entries()) for (const task of call.plan.tasks) assert.ok(fs.existsSync(path.join(config.outDir, 'diagnostic-patches', `stage-${index + 1}`, `${task.task_id}.patch`)));
}));
test('aggregate credit budget is checked before dispatch, not reset per stage', () => scratch(directory => {
  const config = fixture(directory);
  assert.throws(() => runStages({ ...config, totalAiCredits: 60 }, () => assert.fail('No dispatch allowed')), /STAGE_CREDIT_BUDGET_INSUFFICIENT/);
}));
test('single-stage execution keeps original run identity and checks', () => scratch(directory => {
  const config = fixture(directory), value = decision();
  delete value.members[0].depends_on;
  const plan = planFor(value); plan.baseline_sha = config.plan.baseline_sha; plan.tasks.forEach(task => { task.baseline_sha = plan.baseline_sha; });
  json(config.planPath, plan);
  const calls = [];
  assert.equal(runStages(config, mockDispatch(calls)).status, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plan.run_id, plan.run_id);
  assert.equal(calls[0].plan.integration.check_commands.length, 1);
}));
test('report preserves stage numbers and identifies the failed member stage', () => scratch(directory => {
  const route = { reason: 'Fixture routing.', members: decision().members.map(entry => ({ logical_member_id: entry.member, resolved_persistent_name: 'Test Member', role: 'Fixture', objective: entry.objective, owned_paths: entry.owned_paths, stage: entry.depends_on ? 2 : 1 })) };
  const clean = summarizeStored({ schema: 2, status: 'failed', route, stages: {} });
  const text = renderComment(clean);
  assert.match(text, /test-checker` \(Test Member\), stage 2/);
  assert.match(text, /test-builder` \(Test Member\), stage 1/);
  json(path.join(directory, 'dispatcher-summary.json'), {});
  json(path.join(directory, 'stage-results.json'), { stages: [{ stage: 1, status: 'failed' }] });
  const summary = summarizeStage(path.join(directory, 'dispatcher-summary.json'), directory);
  assert.equal(summary.stage, 'member-stage-1');
}));
test('member artifact uploads patch-only diagnostics on failed integration', () => scratch(directory => {
  const config = fixture(directory), calls = [];
  runStages(config, mockDispatch(calls, { failStage: 2 }));
  const artifact = path.join(directory, 'artifact');
  exec(process.execPath, [path.join(__dirname, 'issue-report.cjs'), 'stage-artifact', '--summary', path.join(config.outDir, 'dispatcher-summary.json'), '--diagnostics', path.join(directory, 'no-diagnostics'), '--out', artifact, '--include-patch'], directory);
  assert.ok(fs.existsSync(path.join(artifact, 'diagnostic-patches', 'combined.patch')));
  assert.ok(fs.existsSync(path.join(artifact, 'stage-results.json')));
  function collect(root) { return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? collect(path.join(root, entry.name)) : [entry.name]); }
  assert.ok(collect(artifact).every(name => !name.endsWith('.log')));
}));
test('successful stage artifact remains publishable and includes member patches from both stages', () => scratch(directory => {
  const config = fixture(directory), calls = [];
  const summary = runStages(config, mockDispatch(calls));
  const artifact = path.join(directory, 'artifact');
  exec(process.execPath, [path.join(__dirname, 'issue-report.cjs'), 'stage-artifact', '--summary', path.join(config.outDir, 'dispatcher-summary.json'), '--diagnostics', path.join(directory, 'no-diagnostics'), '--out', artifact, '--include-patch'], directory);
  assert.equal(validateIntegrationArtifacts(path.join(artifact, 'dispatcher-summary.json'), summary).baselineSha, config.plan.baseline_sha);
  for (const [index, call] of calls.entries()) for (const task of call.plan.tasks) assert.ok(fs.existsSync(path.join(artifact, 'diagnostic-patches', `stage-${index + 1}`, `${task.task_id}.patch`)));
}));

test('stage grouping rejects unknown, self, cycle and three-stage task graphs', () => {
  for (const dependencies of [
    [[{ task_id: 'missing' }], [], []],
    [[{ task_id: 'a' }], [], []],
    [[{ task_id: 'b' }], [{ task_id: 'a' }], []],
    [[{ task_id: 'b' }], [{ task_id: 'c' }], []]
  ]) assert.throws(() => groupStages(['a', 'b', 'c'].map((task_id, index) => ({ task_id, dependencies: dependencies[index] }))), /DECISION_DEPENDENCY_INVALID/);
});