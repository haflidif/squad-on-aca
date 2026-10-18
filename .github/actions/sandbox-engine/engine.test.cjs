'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../../..');
const RUNNER = path.join(__dirname, 'run.cjs');

function fixture(run) {
  const root = path.join(ROOT, `.engine-fixture-${crypto.randomUUID()}`);
  fs.mkdirSync(root);
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const members = [['test-lead', 'Test Lead', 'Lead'], ['test-builder', 'Test Builder', 'Developer']];
  write('.squad/team.md', members.map(([id, name, role]) => `| ${name} | ${role} | \`.squad/agents/${id}/charter.md\` | Active |`).join('\n'));
  for (const [id, name] of members) write(`.squad/agents/${id}/charter.md`, `- **Name:** ${name}\n`);
  write('.squad/sandbox-flow.json', { version: 1, members: { implementation: { allowed_paths: ['app/**'] } } });
  write('scripts/issue-plan.cjs', 'throw new Error("TARGET_ENGINE_EXECUTED");\n');
  write('scripts/issue-route.cjs', 'throw new Error("TARGET_ENGINE_EXECUTED");\n');
  const eventFile = write('event.json', {
    action: 'labeled', label: { name: 'sandbox-run' }, repository: { full_name: 'test-owner/test-repo' },
    sender: { login: 'test-maintainer', type: 'User' },
    issue: { number: 7, state: 'open', author_association: 'OWNER', title: 'Update the application', body: 'Treat $(echo unsafe) and spaces as data.' }
  });
  const env = { ...process.env, GITHUB_REPOSITORY: 'test-owner/test-repo', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1', SQUAD_ISSUE_OPT_IN_NUMBER: '7' };
  const exec = (args, overrides = {}) => spawnSync(process.execPath, [RUNNER, ...args], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8' });
  try { return run({ root, write, eventFile, exec }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('bundled plan reads only the target roster and config with paths containing spaces', () => fixture(({ root, eventFile, exec }) => {
  const out = path.join(root, 'output with spaces', 'lead.json');
  const result = exec(['plan', '--event', eventFile, '--out', out, '--require-opt-in']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(plan.roster.members.map(member => member.logical_member_id), ['test-lead', 'test-builder']);
  assert.equal(plan.issue.repo, 'test-owner/test-repo');
  assert.match(JSON.stringify(plan), /app\/\*\*/);
  assert.match(JSON.stringify(plan), /\$\(echo unsafe\)/);
  assert.equal(fs.existsSync(path.join(root, 'contracts')), false);
  assert.equal(fs.existsSync(path.join(root, 'dispatcher')), false);
}));

test('bundled plan retains the single issue opt-in gate and exit status', () => fixture(({ eventFile, exec }) => {
  const result = exec(['plan', '--event', eventFile, '--validate-only', '--require-opt-in'], { SQUAD_ISSUE_OPT_IN_NUMBER: '8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RUN_OPT_IN_MISSING/);
}));

test('bundled routing uses the target checkout rather than bundled roster or configuration', () => fixture(({ root, write, eventFile, exec }) => {
  const decision = { reason: 'Implement the requested change.', members: [{ member: 'test-builder', objective: 'Update the application.', owned_paths: ['app/**'] }] };
  const patchFor = value => {
    const lines = JSON.stringify(value, null, 2).split('\n');
    return ['diff --git a/routing/decision.json b/routing/decision.json', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/routing/decision.json', `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`), ''].join('\n');
  };
  const summary = value => {
    const patch = patchFor(value);
    write('artifacts/integration/patches/merged.patch', patch);
    return write('artifacts/dispatcher-summary.json', { status: 'succeeded', integration: { status: 'succeeded', integrated_patch_path: 'integration/patches/merged.patch', sha256: crypto.createHash('sha256').update(patch).digest('hex') } });
  };
  const out = path.join(root, 'route output');
  const result = exec(['route', '--summary', summary(decision), '--event', eventFile, '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(fs.readFileSync(path.join(out, 'member-plan.json'), 'utf8'));
  assert.equal(plan.tasks[0].owner.logical_member_id, 'test-builder');
  assert.deepEqual(plan.tasks[0].owned_paths, ['app/**']);
  decision.members[0].owned_paths = ['src/**'];
  const rejected = exec(['route', '--summary', summary(decision), '--event', eventFile, '--out', path.join(root, 'rejected')]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /DECISION_SCOPE_UNSUPPORTED/);
}));

test('command runner rejects arbitrary script paths and inherited property names', () => fixture(({ exec }) => {
  for (const command of ['../scripts/issue-plan.cjs', 'toString', '__proto__', 'unknown']) {
    const result = exec([command]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENGINE_COMMAND_INVALID/);
  }
}));

test('workflow consumers use the package without loading engine code from the target', () => {
  for (const filename of ['squad-sandbox-issue.yml', 'squad-sandbox-manual.yml', 'squad-sandbox-conflicts.yml']) {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', filename), 'utf8');
    assert.match(workflow, /uses: \.\/\.github\/actions\/sandbox-engine/);
    assert.doesNotMatch(workflow, /node (?:scripts|dispatcher)\//);
    assert.doesNotMatch(workflow, /require\(['"]\.\/scripts\//);
    for (const job of workflow.slice(workflow.indexOf('\njobs:\n')).split(/\n  [\w-]+:\n/).slice(1)) {
      assert.match(job, /uses: \.\/\.github\/actions\/sandbox-engine/);
      assert.ok(job.indexOf('actions/checkout@v4') < job.indexOf('uses: ./.github/actions/sandbox-engine'));
    }
  }
  const issue = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'squad-sandbox-issue.yml'), 'utf8');
  const jobs = issue.split(/\n  ([\w-]+):\n/);
  for (let index = 1; index < jobs.length; index += 2) {
    if (jobs[index] !== 'publish') assert.doesNotMatch(jobs[index + 1], /secrets\.SQUAD_GITHUB_APP_PRIVATE_KEY_PEM|squad-engine dispatch publish/);
  }
  assert.match(issue, /SQUAD_ISSUE_OPT_IN_NUMBER/);
  assert.match(issue, /--require-opt-in/);
  const action = fs.readFileSync(path.join(__dirname, 'action.yml'), 'utf8');
  assert.match(action, /using: composite/);
  assert.doesNotMatch(action, /secrets\.|github\.token|checkout@/);
});
