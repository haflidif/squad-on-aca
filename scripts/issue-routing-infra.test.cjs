'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { buildLeadPlan, buildMemberPlan, supportedKind, validateRoutingDecision } = require('./issue-plan.cjs');
const { validateDecision } = require('./issue-route.cjs');
const { renderComment, summarizeStored } = require('./issue-report.cjs');
const { memberLabelDefinitions } = require('./member-labels.cjs');
const { validateChangedPaths } = require('../contracts/aca-sandbox/v1/tools/path-scope');
const { validateContract } = require('../contracts/aca-sandbox/v1/tools/validate');
const { buildIntegrationDispatch } = require('../dispatcher/integrate');
const { parsePatchChangedPaths } = require('../dispatcher/dispatcher');
const { FakeGitHubClient, labelPublication, withTaskRoles } = require('../dispatcher/publish');

const member = (id, role) => ({ logical_member_id: id, resolved_persistent_name: `Test ${id}`, role, charter_ref: `.squad/agents/${id}/charter.md`, membership: 'persona', capabilities: ['writing'] });
const roster = { members: [member('test-lead', 'Lead'), member('test-builder', 'Terraform & Azure Infrastructure'), member('test-checker', 'Terraform Validation & Module Tests'), member('test-writer', 'Module Documentation & Examples')] };
roster.lead = roster.members[0];
const options = { repository: 'test-owner/test-repo', issueNumber: 8, runId: '123', attempt: '1', roster };
const selection = scopes => ({ member: 'test-builder', objective: 'Implement a Terraform example.', owned_paths: scopes });
const decision = scopes => ({ reason: 'Independently owned example code.', members: [selection(scopes)] });
function planFor(value) {
  return buildMemberPlan({ ...options, selections: validateDecision(JSON.stringify(value), roster).selections });
}
function scratch(run) {
  const dir = path.join(__dirname, '..', `.infra-member-test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir);
  return Promise.resolve().then(() => run(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
function write(dir, file, content) {
  const target = path.join(dir, ...file.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function check(dir, scopes, uncheckedScopes) {
  const command = planFor(decision(scopes)).integration.check_commands.find(command => command.name === 'verify-infra-files');
  assert.ok(command);
  assert.equal(command.argv[0], 'node');
  assert.deepEqual(JSON.parse(command.argv[3]), scopes);
  const argv = command.argv.slice(1);
  if (uncheckedScopes !== undefined) argv[2] = JSON.stringify(uncheckedScopes);
  return spawnSync(process.execPath, argv, { cwd: dir, encoding: 'utf8' });
}

for (const [role, kind] of [
  ['Terraform & Azure Infrastructure', 'infrastructure'],
  ['Terraform Validation & Module Tests', 'testing'],
  ['Module Documentation & Examples', 'documentation'],
  ['Infra', 'infrastructure'], ['Terraform', 'infrastructure'], ['INFRASTRUCTURE', 'infrastructure']
]) test(`role maps ${role} to ${kind}`, () => assert.equal(supportedKind({ role }), kind));

for (const scope of ['examples/terraform/**', 'examples/terraform/main.tf', 'examples/terraform/README.md', 'examples/terraform/test-module/main.tf', 'examples/terraform/test-module/nested/file.name.md']) {
  test(`infrastructure allows ${scope}`, () => {
    const plan = planFor(decision([scope]));
    assert.deepEqual(plan.tasks[0].owned_paths, [scope]);
    assert.match(plan.tasks[0].objective, /Implement the requested Terraform example code/);
    assert.doesNotMatch(plan.tasks[0].objective, /Implement focused regression tests/);
  });
}
for (const scope of ['infra/auth-trust.bicep', 'infra/main.tf', '.github/workflows/test.md', '.github/test.md', 'dispatcher/main.md', 'dispatcher/test/example.test.js', 'scripts/example.test.cjs', '.squad/team.md', 'README.md', 'examples/terraform', 'examples/terraform/*.tf', 'examples/terraform/main.tfvars', 'examples/terraform/main.tfvars.example', 'examples/terraform/main.bicep', 'examples/terraform-extra/main.tf']) {
  test(`infrastructure rejects unsupported scope ${scope}`, () => assert.throws(() => planFor(decision([scope])), /DECISION_SCOPE_UNSUPPORTED/));
}
for (const scope of ['../infra/auth-trust.bicep', 'examples/terraform/../main.tf', 'examples/terraform/sub/../../main.tf', '/examples/terraform/main.tf', 'examples\\terraform\\main.tf', 'examples/terraform//main.tf']) {
  test(`infrastructure rejects invalid scope ${scope}`, () => assert.throws(() => planFor(decision([scope])), /DECISION_SCOPE_INVALID/));
}

test('three-member routing reaches Lead validation, integration, reporting and publication labels', () => scratch(async dir => {
  const value = decision(['examples/terraform/main.tf']);
  value.members.push(
    { member: 'test-checker', objective: 'Test the example.', owned_paths: ['scripts/example.test.cjs'] },
    { member: 'test-writer', objective: 'Document the example.', owned_paths: ['README.md'] }
  );
  const plan = planFor(value);
  plan.baseline_sha = 'a'.repeat(40);
  for (const task of plan.tasks) task.baseline_sha = plan.baseline_sha;
  const contract = validateContract('coordinator-execution.schema.json', plan);
  assert.equal(contract.valid, true, contract.errors.join('; '));
  assert.equal(plan.tasks.length, 3);
  assert.deepEqual(plan.integration.check_commands.map(command => command.name), ['verify-member-tests', 'verify-infra-files']);
  const dispatch = buildIntegrationDispatch(plan, plan.tasks.map(task => ({ task, sha256: 'b'.repeat(64), changedPaths: task.owned_paths, result: { status: 'succeeded' } })));
  assert.equal(dispatch.tasks.length, 3);
  const integrated = validateContract('integration-dispatch.schema.json', dispatch, plan);
  assert.equal(integrated.valid, true, integrated.errors.join('; '));
  const lead = buildLeadPlan({ ...options, title: 'Implement an example', body: 'Code, tests and docs.' });
  assert.match(lead.tasks[0].objective, /Infrastructure owns only examples\/terraform/);
  write(dir, 'routing/decision.json', JSON.stringify(value));
  assert.equal(spawnSync(process.execPath, lead.integration.check_commands[0].argv.slice(1), { cwd: dir }).status, 0);
  const routed = { reason: value.reason, members: value.members.map(entry => ({ ...roster.members.find(member => member.logical_member_id === entry.member), objective: entry.objective, owned_paths: entry.owned_paths })) };
  const comment = renderComment(summarizeStored({ status: 'succeeded', route: routed, stages: {} }), {});
  for (const entry of routed.members) assert.ok(comment.includes(entry.objective));
  const client = new FakeGitHubClient();
  await labelPublication(client, { owner: 'test-owner', repo: 'test-repo', issueNumber: 8, prNumber: 10, tasks: withTaskRoles(plan.tasks, roster), roster });
  const labels = memberLabelDefinitions(roster.members.map(member => ({ name: member.resolved_persistent_name, role: member.role })));
  const added = client.labels.filter(call => call.issueNumber === 10).flatMap(call => call.add);
  for (const label of labels.slice(1)) assert.ok(added.includes(label.name));
}));

for (const scopes of [['examples/terraform/main.tf'], ['examples/terraform/**']]) {
  test(`infra scope rejects out-of-scope member patch paths for ${scopes[0]}`, () => {
    const task = planFor(decision(scopes)).tasks[0];
    const patch = file => `diff --git a/${file} b/${file}\n`;
    assert.deepEqual(validateChangedPaths(parsePatchChangedPaths(patch('examples/terraform/main.tf')), task.owned_paths).violations, []);
    for (const file of ['infra/auth-trust.bicep', '.github/workflows/test.yml', '.squad/team.md', 'dispatcher/dispatcher.js', 'scripts/issue-plan.cjs', 'examples/other/main.tf']) {
      assert.deepEqual(validateChangedPaths(parsePatchChangedPaths(patch(file)), task.owned_paths).violations, [file]);
    }
  });
}

test('infrastructure parent and case-folded scopes still reject overlap', () => {
  for (const scope of ['examples/terraform/main.tf', 'EXAMPLES/TERRAFORM/main.tf', 'examples/terraform/**']) {
    const value = decision(['examples/terraform/main.tf']);
    value.members.push({ member: 'test-checker', objective: 'Test example.', owned_paths: [scope] });
    assert.throws(() => validateRoutingDecision(value, roster), /DECISION_SCOPES_OVERLAP/);
  }
});

test('infrastructure check verifies every concrete file and ignores unowned files', () => scratch(dir => {
  write(dir, 'examples/terraform/main.tf', 'resource "test" "example" {\n nested { value = "}" } # { ignored\n}\n');
  write(dir, 'examples/terraform/README.md', '# Example\n');
  write(dir, 'examples/terraform/unowned.tf', '{');
  const result = check(dir, ['examples/terraform/main.tf', 'examples/terraform/README.md']);
  assert.equal(result.status, 0, result.stderr);
}));

test('wildcard infrastructure check recursively verifies .tf and .md files', () => scratch(dir => {
  write(dir, 'examples/terraform/main.tf', 'terraform { }\n');
  write(dir, 'examples/terraform/module/README.md', '# Module\n');
  let result = check(dir, ['examples/terraform/**']);
  assert.equal(result.status, 0, result.stderr);
  write(dir, 'examples/terraform/module/broken.tf', 'resource "test" "bad" {\n');
  result = check(dir, ['examples/terraform/**']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unbalanced Terraform braces/);
}));

for (const [name, content, message] of [
  ['empty file', '', /file is empty/], ['whitespace only', ' \r\n\t', /file is empty/],
  ['unclosed brace', 'terraform {', /Unbalanced Terraform braces/],
  ['extra closing brace', 'terraform {} }', /Unbalanced Terraform braces/],
  ['reversed braces', '}{', /Unbalanced Terraform braces/],
  ...['client_secret', 'PASSWORD', 'access_key'].map(key => [key, `${key} = "synthetic-not-a-secret"\n`, /Possible secret assignment/])
]) test(`infrastructure check rejects ${name}`, () => scratch(dir => {
  write(dir, 'examples/terraform/main.tf', content);
  const result = check(dir, ['examples/terraform/main.tf']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stderr, /synthetic-not-a-secret/);
}));

test('infrastructure check rejects missing owned file even when another exists', () => scratch(dir => {
  write(dir, 'examples/terraform/main.tf', 'terraform {}');
  const result = check(dir, ['examples/terraform/main.tf', 'examples/terraform/missing.md']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verify-infra-files:.*ENOENT/);
}));

test('infrastructure check rejects directories, empty selections and empty wildcard matches', () => scratch(dir => {
  fs.mkdirSync(path.join(dir, 'examples', 'terraform', 'directory.tf'), { recursive: true });
  let result = check(dir, ['examples/terraform/directory.tf']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a regular file/);
  result = check(dir, ['examples/terraform/main.tf'], []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No owned infrastructure files selected/);
  result = check(dir, ['examples/terraform/**']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No owned infrastructure files matched/);
}));

test('infrastructure check rejects symlinked parent directories and wildcard descendants', () => scratch(dir => {
  write(dir, 'target/main.tf', 'terraform {}');
  fs.mkdirSync(path.join(dir, 'examples', 'terraform'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'examples', 'terraform', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const scopes of [['examples/terraform/linked/main.tf'], ['examples/terraform/**']]) {
    const result = check(dir, scopes);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink/);
  }
}));

test('infrastructure check rejects symlinked concrete files', t => scratch(dir => {
  write(dir, 'target.tf', 'terraform {}');
  fs.mkdirSync(path.join(dir, 'examples', 'terraform'), { recursive: true });
  try { fs.symlinkSync(path.join(dir, 'target.tf'), path.join(dir, 'examples', 'terraform', 'main.tf'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('File symlinks require Windows privileges'); return; } throw error; }
  const result = check(dir, ['examples/terraform/main.tf']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symlink/);
}));


test('infrastructure Markdown files must also be non-empty and secret-free', () => scratch(dir => {
  for (const content of ['', 'password = "synthetic-not-a-secret"']) {
    write(dir, 'examples/terraform/README.md', content);
    const result = check(dir, ['examples/terraform/README.md']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /file is empty|Possible secret assignment/);
  }
}));
