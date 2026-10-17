'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { buildLeadPlan, buildMemberPlan, supportedKind, validateRoutingDecision } = require('./issue-plan.cjs');
const { loadConfig, isDeniedPath } = require('./sandbox-flow-config.cjs');
const { validateConfig } = require('./issue-postprocess.cjs');

const member = (id, role) => ({ logical_member_id: id, resolved_persistent_name: `Test ${id}`, role, charter_ref: `.squad/agents/${id}/charter.md`, membership: 'persona', capabilities: ['writing'] });
const roster = { members: [member('test-lead', 'Lead'), member('test-builder', 'Build engineer'), member('test-checker', 'Test engineer'), member('test-writer', 'Technical writer')] };
roster.lead = roster.members[0];
const options = { repository: 'test-owner/test-repo', issueNumber: 8, runId: '123', attempt: '1', roster };
const basicConfig = { version: 1, members: { implementation: { allowed_paths: ['src/**'] }, testing: { allowed_paths: ['tests/**'] }, documentation: { allowed_paths: ['docs/**', 'README.md'] } } };
const selection = scopes => ({ member: 'test-builder', objective: 'Implement the bounded product change.', owned_paths: scopes });
const decision = scopes => ({ reason: 'Independently owned product code.', members: [selection(scopes)] });
function planFor(value, config = null) {
  return buildMemberPlan({ ...options, config, selections: validateRoutingDecision(value, roster, config).selections });
}
function scratch(run) {
  const dir = path.join(__dirname, '..', `.generic-flow-test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir);
  return Promise.resolve().then(() => run(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
function write(dir, file, content) {
  const target = path.join(dir, ...file.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function command(plan) { return plan.integration.check_commands.find(item => item.name === 'verify-generic-changes'); }
function initRepo(dir) {
  const git = args => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '--quiet']); git(['config', 'user.name', 'Generic Test']); git(['config', 'user.email', 'generic@example.invalid']);
  git(['commit', '--quiet', '--allow-empty', '-m', 'baseline']);
}
function check(dir, plan, files) {
  return spawnSync(process.execPath, [...command(plan).argv.slice(1), JSON.stringify(files)], { cwd: dir, encoding: 'utf8' });
}

test('member kinds are generic hints and default scopes are repository-wide', () => {
  assert.equal(supportedKind({ role: 'Build engineer' }), 'implementation');
  assert.equal(supportedKind({ role: 'Quality engineer' }), 'implementation');
  assert.equal(supportedKind({ role: 'Documentation specialist' }), 'documentation');
  assert.equal(supportedKind({ role: 'Infrastructure specialist' }), 'infrastructure');
  const plan = planFor(decision(['src/**']));
  assert.deepEqual(plan.tasks[0].owned_paths, ['src/**']);
  assert.match(plan.tasks[0].objective, /requested implementation work/);
  assert.doesNotMatch(plan.tasks[0].objective, /Terraform|examples\/terraform/);
  assert.deepEqual(plan.integration.check_commands.map(item => item.name), ['verify-generic-changes']);
  const anyPath = { ...decision(['vendor/generated/**']), members: [{ ...selection(['vendor/generated/**']), member: 'test-builder' }] };
  assert.doesNotThrow(() => validateRoutingDecision(anyPath, roster));
});

test('trusted configuration scopes member kinds and exact roles', () => {
  const roleConfig = { version: 1, members: { ...basicConfig.members, 'role:Build engineer': { allowed_paths: ['build/**'] } } };
  assert.doesNotThrow(() => validateRoutingDecision(decision(['build/output/**']), roster, roleConfig));
  assert.throws(() => validateRoutingDecision(decision(['src/**']), roster, roleConfig), /DECISION_SCOPE_UNSUPPORTED/);
  const testerDecision = { reason: 'Add tests.', members: [{ member: 'test-checker', objective: 'Test the feature.', owned_paths: ['tests/**'] }] };
  assert.doesNotThrow(() => validateRoutingDecision(testerDecision, roster, basicConfig));
  assert.throws(() => validateRoutingDecision({ ...testerDecision, members: [{ ...testerDecision.members[0], owned_paths: ['src/**'] }] }, roster, basicConfig), /DECISION_SCOPE_UNSUPPORTED/);
  assert.throws(() => validateRoutingDecision(decision(['.github/workflows/ci.yml']), roster), /DECISION_SCOPE_DENIED/);
  assert.throws(() => validateRoutingDecision(decision(['.squad/team.md']), roster), /DECISION_SCOPE_DENIED/);
  assert.throws(() => validateRoutingDecision(decision(['.git/config']), roster), /DECISION_SCOPE_DENIED/);
  assert.throws(() => validateRoutingDecision(decision(['scripts/issue-plan.cjs']), roster, null, path.resolve(__dirname, '..')), /DECISION_SCOPE_DENIED/);
});

for (const scope of ['../outside/file', 'src/../../secret', '/absolute/path', 'C:\\repo\\file', 'src//file']) {
  test(`rejects unsafe member scope ${scope}`, () => assert.throws(() => validateRoutingDecision(decision([scope]), roster), /DECISION_SCOPE_INVALID/));
}

test('Lead routing prompt injects configured paths without stack-specific instructions', () => {
  const lead = buildLeadPlan({ ...options, title: 'Implement a feature', body: 'Update the application.', config: basicConfig });
  assert.match(lead.tasks[0].objective, /src\/\*/);
  assert.match(lead.tasks[0].objective, /tests\/\*/);
  assert.doesNotMatch(lead.tasks[0].objective, /Terraform|examples\/terraform|brace/);
});

test('disjoint path scopes remain enforced across members', () => {
  const value = decision(['src/**']);
  value.members.push({ member: 'test-checker', objective: 'Test the feature.', owned_paths: ['src/module/**'] });
  assert.throws(() => validateRoutingDecision(value, roster), /DECISION_SCOPES_OVERLAP/);
  const separate = decision(['src/**']);
  separate.members.push({ member: 'test-checker', objective: 'Test the feature.', owned_paths: ['tests/**'] });
  assert.doesNotThrow(() => validateRoutingDecision(separate, roster));
});

test('generic integration check allows ordinary code and documentation paths', () => scratch(dir => {
  const plan = planFor(decision(['src/**']));
  initRepo(dir);
  write(dir, 'src/main.js', 'module.exports = true;\n');
  write(dir, 'docs/guide.md', '# Guide\n');
  const result = check(dir, plan, ['src/main.js', 'docs/guide.md']);
  assert.equal(result.status, 0, result.stderr);
}));

test('generic integration check denies protected engine paths and escaping symlinks', t => scratch(dir => {
  const plan = planFor(decision(['**']));
  initRepo(dir);
  write(dir, '.github/workflows/ci.yml', 'name: unsafe\n');
  let result = check(dir, plan, ['.github/workflows/ci.yml']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DENIED_PATH:.github/);
  fs.rmSync(path.join(dir, '.github'), { recursive: true, force: true });
  const outside = path.join(path.dirname(dir), `.generic-flow-outside-${crypto.randomUUID()}`);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not in repo\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  try { fs.symlinkSync(outside, path.join(dir, 'src', 'linked'), 'junction'); }
  catch (error) { fs.rmSync(outside, { recursive: true, force: true }); if (error.code === 'EPERM') { t.skip('Directory symlinks require Windows privileges'); return; } throw error; }
  result = check(dir, plan, ['src/linked/secret.txt']);
  fs.rmSync(outside, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SYMLINK_ESCAPE:src/);
}));

test('generic integration check catches likely secret material without echoing it', () => scratch(dir => {
  const plan = planFor(decision(['**']));
  initRepo(dir);
  write(dir, 'src/config.js', 'const client_secret = "synthetic-not-a-secret";\n');
  const result = check(dir, plan, ['src/config.js']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INTEGRATION_CHECK_FAILED/);
  assert.match(result.stderr, /SECRET_PATTERN:src/);
  assert.doesNotMatch(result.stderr, /synthetic-not-a-secret/);
}));

test('Terraform documentation example loads through the generic version 1 schema', () => {
  const docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'sandbox-issue-flow.md'), 'utf8');
  const section = docs.split('This Terraform example uses a pinned official Linux archive.')[1];
  const source = section?.match(/```json\s*([\s\S]*?)\s*```/);
  assert.ok(source, 'Terraform config example exists');
  const value = validateConfig(JSON.parse(source[1]));
  assert.equal(value.tools.terraform.version, '1.9.8');
  assert.deepEqual(value.steps[0].paths, ['infra/**/*.tf']);
  assert.equal(value.steps[0].run[0], 'terraform');
});

test('default config remains passthrough and validates engine deny semantics', () => {
  const config = loadConfig(path.join(__dirname, '..'));
  assert.deepEqual(config.postprocess, { tools: {}, steps: [] });
  assert.equal(isDeniedPath('.github/workflows/ci.yml', path.join(__dirname, '..')), true);
  assert.equal(isDeniedPath('.squad/team.md', path.join(__dirname, '..')), true);
  assert.equal(isDeniedPath('src/index.js', path.join(__dirname, '..')), false);
});
