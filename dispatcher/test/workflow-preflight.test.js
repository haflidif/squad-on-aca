const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { runDispatcher } = require('../dispatcher');
const { findBash } = require('../lib/util');
const {
  assertPublishableSummary,
  resolvePlanFile,
  stagePublishInputs,
  validateLiveSandboxConfig,
  validateInputs,
  writeMaterializedPlan
} = require('../workflow-preflight');
const { stagePem } = require('../stage-pem');
const { checkCommittedWhitespace } = require('../check-committed-whitespace');

const repoRoot = path.resolve(__dirname, '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const planFixture = path.join(repoRoot, 'contracts', 'aca-sandbox', 'v1', 'fixtures', 'dynamic-multi-agent-execution.example.json');
const manualPlanFixture = path.join(repoRoot, 'dispatcher', 'fixtures', 'workflow-manual-plan.example.json');

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function setupRepo(t, sourcePlan = planFixture) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-preflight-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  runGit(['init'], temp);
  runGit(['config', 'user.name', 'Workflow Test'], temp);
  runGit(['config', 'user.email', 'workflow-test@example.invalid'], temp);
  const plan = JSON.parse(fs.readFileSync(sourcePlan, 'utf8'));
  plan.baseline_sha = '$CHECKED_OUT_SHA';
  for (const task of plan.tasks) task.baseline_sha = '$CHECKED_OUT_SHA';
  fs.mkdirSync(path.join(temp, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'plans', 'execution.json'), JSON.stringify(plan, null, 2));
  runGit(['add', '.'], temp);
  runGit(['commit', '-m', 'baseline'], temp);
  const head = runGit(['rev-parse', 'HEAD'], temp);
  return { temp, head, plan };
}

function validEnv(repo, overrides = {}) {
  return {
    GITHUB_SHA: repo.head,
    GITHUB_REPOSITORY: 'owner/repository',
    SQUAD_REPOSITORY: 'owner/repository',
    SQUAD_ISSUE_NUMBER: '42',
    SQUAD_PLAN_PATH: 'plans/execution.json',
    SQUAD_EXECUTION_MODE: 'fake',
    SQUAD_ENABLE_SANDBOX_LIVE: 'false',
    SQUAD_ENABLE_PUBLISH_LIVE: 'false',
    ...overrides
  };
}

function runScripts(workflow) {
  const lines = workflow.split(/\r?\n/);
  const scripts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    if (match[2] === '|' || match[2] === '>' || match[2] === '|-' || match[2] === '>-') {
      const content = [];
      for (index += 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() && (/^\s*/.exec(line)[0].length <= indent)) break;
        content.push(line);
      }
      scripts.push(content.join('\n'));
      index -= 1;
    } else {
      scripts.push(match[2]);
    }
  }
  return scripts;
}

test('CI replaces the placeholder with main-only checks and required Linux evidence gates', () => {
  const ci = fs.readFileSync(path.join(workflowsDir, 'squad-ci.yml'), 'utf8');
  assert.match(ci, /pull_request:\s*\n\s+branches:\s*\[main\]/);
  assert.match(ci, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(ci, /cancel-in-progress:\s*true/);
  assert.match(ci, /SQUAD_REQUIRE_PROC_ARGV_TEST:\s*'1'/);
  assert.match(ci, /SQUAD_REQUIRE_PROCESS_TREE_KILL_TEST:\s*'1'/);
  assert.match(ci, /contracts\/aca-sandbox\/v1\/test\/\*\.test\.js/);
  assert.match(ci, /dispatcher\/test\/\*\.test\.js/);
  assert.match(ci, /agents\/sandbox\/test\/\*\.test\.js/);
  assert.match(ci, /terraform fmt -check -recursive/);
  assert.match(ci, /terraform init -backend=false/);
  assert.match(ci, /terraform validate/);
  assert.match(ci, /docker build --pull[\s\S]*BUILD_BASE_IMAGE=docker\.io\/library\/golang:1\.23\.4-bookworm[\s\S]*RUNTIME_BASE_IMAGE=docker\.io\/library\/debian:bookworm-20240701-slim[\s\S]*--file agents\/sandbox\/Dockerfile[\s\S]* \./);
  const dockerfile = fs.readFileSync(path.join(repoRoot, 'agents', 'sandbox', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /ARG BUILD_BASE_IMAGE=\$\{BASE_ACR_HOST\}base\/golang:/);
  assert.match(dockerfile, /ARG RUNTIME_BASE_IMAGE=\$\{BASE_ACR_HOST\}base\/debian:/);
  assert.doesNotMatch(ci, /TODO|No build commands configured|branches:\s*\[(?:dev|insider|preview)/i);
  assert.match(ci, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(ci, /fetch-depth:\s*0/);
  assert.match(ci, /SQUAD_CI_PR_BASE_SHA:\s*\$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(ci, /SQUAD_CI_PUSH_BEFORE:\s*\$\{\{ github\.event\.before \}\}/);
  assert.doesNotMatch(ci, /SQUAD_CI_PUSH_BASE_REF/);
  assert.match(ci, /SQUAD_CI_PUSH_CREATED:\s*\$\{\{ github\.event\.created \}\}/);
  assert.match(ci, /run:\s*node dispatcher\/check-committed-whitespace\.js/);
  assert.doesNotMatch(ci, /run:\s*git diff --check/);
});

test('CI whitespace check examines committed PR and push ranges', t => {
  const repo = setupRepo(t);
  const base = repo.head;
  fs.writeFileSync(path.join(repo.temp, 'bad.txt'), 'trailing spaces   \n');
  runGit(['add', 'bad.txt'], repo.temp);
  runGit(['commit', '-m', 'whitespace error'], repo.temp);
  const head = runGit(['rev-parse', 'HEAD'], repo.temp);
  for (const event of [
    { GITHUB_EVENT_NAME: 'pull_request', SQUAD_CI_PR_BASE_SHA: base },
    { GITHUB_EVENT_NAME: 'push', SQUAD_CI_PUSH_BEFORE: base },
    { GITHUB_EVENT_NAME: 'push', SQUAD_CI_PUSH_BEFORE: '0'.repeat(40), SQUAD_CI_PUSH_CREATED: 'true' }
  ]) {
    assert.throws(() => checkCommittedWhitespace({ GITHUB_SHA: head, ...event }, repo.temp), /trailing whitespace/);
  }
  assert.throws(() => checkCommittedWhitespace({
    GITHUB_SHA: head, GITHUB_EVENT_NAME: 'pull_request', SQUAD_CI_PR_BASE_SHA: 'f'.repeat(40)
  }, repo.temp), /failed/);
  assert.throws(() => checkCommittedWhitespace({
    GITHUB_SHA: head, GITHUB_EVENT_NAME: 'push', SQUAD_CI_PUSH_BEFORE: 'f'.repeat(40)
  }, repo.temp), /failed/);
  assert.throws(() => checkCommittedWhitespace({
    GITHUB_SHA: head, GITHUB_EVENT_NAME: 'push', SQUAD_CI_PUSH_BEFORE: '0'.repeat(40)
  }, repo.temp), /requires a created event or validated push base SHA/);
});

test('created push checks from the empty tree when a supplied base ref already points to HEAD', t => {
  const repo = setupRepo(t);
  fs.writeFileSync(path.join(repo.temp, 'bad.txt'), 'trailing spaces   \n');
  runGit(['add', 'bad.txt'], repo.temp);
  runGit(['commit', '-m', 'first whitespace commit'], repo.temp);
  fs.writeFileSync(path.join(repo.temp, 'clean.txt'), 'clean\n');
  runGit(['add', 'clean.txt'], repo.temp);
  runGit(['commit', '-m', 'second clean commit'], repo.temp);
  const head = runGit(['rev-parse', 'HEAD'], repo.temp);

  assert.doesNotThrow(() => runGit(['diff', '--check', 'HEAD^', head], repo.temp));
  assert.throws(() => checkCommittedWhitespace({
    GITHUB_SHA: head,
    GITHUB_EVENT_NAME: 'push',
    SQUAD_CI_PUSH_BEFORE: '0'.repeat(40),
    SQUAD_CI_PUSH_CREATED: 'true',
    SQUAD_CI_PUSH_BASE_REF: head
  }, repo.temp), /trailing whitespace/);
});

test('non-created zero-SHA push accepts only an explicit commit base', t => {
  const repo = setupRepo(t);
  const base = repo.head;
  fs.writeFileSync(path.join(repo.temp, 'clean.txt'), 'clean\n');
  runGit(['add', 'clean.txt'], repo.temp);
  runGit(['commit', '-m', 'clean commit'], repo.temp);
  const head = runGit(['rev-parse', 'HEAD'], repo.temp);
  assert.doesNotThrow(() => checkCommittedWhitespace({
    GITHUB_SHA: head,
    GITHUB_EVENT_NAME: 'push',
    SQUAD_CI_PUSH_BEFORE: '0'.repeat(40),
    SQUAD_CI_PUSH_BASE_SHA: base
  }, repo.temp));
  assert.throws(() => checkCommittedWhitespace({
    GITHUB_SHA: head,
    GITHUB_EVENT_NAME: 'push',
    SQUAD_CI_PUSH_BEFORE: '0'.repeat(40),
    SQUAD_CI_PUSH_BASE_REF: base
  }, repo.temp), /requires a created event or validated push base SHA/);
});

test('manual workflow is manual-only, defaults to fake, and separates live gates and approvals', () => {
  const workflow = fs.readFileSync(path.join(workflowsDir, 'squad-sandbox-manual.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(?:issues|pull_request|push):/m);
  assert.match(workflow, /default:\s*fake/);
  assert.match(workflow, /default:\s*dispatcher\/fixtures\/workflow-manual-plan\.example\.json/);
  assert.match(workflow, /enable_sandbox_live:[\s\S]*?default:\s*false/);
  assert.match(workflow, /enable_publish_live:[\s\S]*?default:\s*false/);
  assert.match(workflow, /environment:\s*squad-sandbox-dispatch/);
  assert.match(workflow, /environment:\s*squad-publish/);
  assert.match(workflow, /needs:\s*\[preflight,\s*dispatch-live\]/);
  assert.match(workflow, /needs\.dispatch-live\.result == 'success'/);
  assert.match(workflow, /SQUAD_ENABLE_ACA_SANDBOX:\s*'1'/);
  assert.match(workflow, /SQUAD_ENABLE_PUBLISH:\s*'1'/);
  assert.match(workflow, /--client aca/);
  assert.match(workflow, /--client fake/);
  assert.match(workflow, /--live/);
  assert.match(workflow, /SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT/);
  assert.match(workflow, /SQUAD_SANDBOX_RESOURCE_GROUP_NAME: \$\{\{ vars\.SQUAD_SANDBOX_RESOURCE_GROUP_NAME \}\}/);
  assert.match(workflow, /SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID: \$\{\{ vars\.SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID \}\}/);
  assert.ok(runScripts(workflow).every(script => !/\$\{\{\s*secrets\./.test(script)), 'secrets must be passed only through environment fields');
  const liveJob = workflow.slice(workflow.indexOf('dispatch-live:'), workflow.indexOf('publish-live:'));
  assert.match(liveJob, /if: \$\{\{ inputs\.execution_mode == 'live' && inputs\.enable_sandbox_live \}\}/);
  assert.ok(liveJob.indexOf('node dispatcher/workflow-preflight.js check') < liveJob.indexOf('uses: azure/login@v2'));
  assert.ok(liveJob.indexOf("SQUAD_ENABLE_ACA_SANDBOX: '1'") < liveJob.indexOf('--client aca'));
  const publishJob = workflow.slice(workflow.indexOf('publish-live:'));
  assert.match(publishJob, /needs\.dispatch-live\.result == 'success'/);
  assert.ok(publishJob.indexOf('node dispatcher/workflow-preflight.js verify-summary') < publishJob.indexOf('node dispatcher/stage-pem.js'));
  assert.ok(publishJob.indexOf('node dispatcher/stage-pem.js') < publishJob.indexOf('node dispatcher/cli.js publish'));
  assert.match(workflow, /runs-on:\s*\[self-hosted,\s*linux,\s*squad-aca-cli\]/);
  assert.doesNotMatch(workflow, /\b(?:Wedge|Chewie|Lando|Cassian|Bodhi|Rai|Ralph|Scribe)\b/);
});

test('workflow has a deterministic offline Copilot stub without real credentials', () => {
  const stub = fs.readFileSync(path.join(repoRoot, 'dispatcher', 'fixtures', 'offline-copilot.sh'), 'utf8');
  assert.match(stub, /Owned paths JSON/);
  assert.match(fs.readFileSync(path.join(repoRoot, 'agents', 'sandbox', 'runner', 'persona-run.sh'), 'utf8'), /Owned paths JSON:/);
  assert.match(stub, /GITHUB_TOKEN must be present/);
  assert.doesNotMatch(stub, /curl|wget|git push|gh pr|aca sandbox/);
  assert.match(fs.readFileSync(path.join(workflowsDir, 'squad-sandbox-manual.yml'), 'utf8'), /offline-fake-token-not-a-credential/);
});

test('checked-in manual plan fixture binds its baseline to the selected checkout', t => {
  const repo = setupRepo(t, manualPlanFixture);
  const result = validateInputs(validEnv(repo), { repoRoot: repo.temp });
  assert.equal(result.plan.run_id, 'run-offline-smoke-template');
  assert.equal(result.plan.baseline_sha, repo.head);
  assert.equal(result.plan.tasks[0].baseline_sha, repo.head);
  assert.throws(() => validateInputs(validEnv(repo, {
    SQUAD_EXECUTION_MODE: 'live',
    SQUAD_ENABLE_SANDBOX_LIVE: 'true'
  }), { repoRoot: repo.temp }), /requires a plan issue binding/);
});

test('workflow binds live plan to the selected repository and issue before credentials', t => {
  const repo = setupRepo(t);
  const file = path.join(repo.temp, 'plans', 'execution.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const live = validEnv(repo, { SQUAD_EXECUTION_MODE: 'live', SQUAD_ENABLE_SANDBOX_LIVE: 'true' });
  assert.throws(() => validateInputs(live, { repoRoot: repo.temp }), /requires a plan issue binding/);
  for (const [binding, error] of [
    [{ repo: 'other/repository', issue_number: 42 }, /does not match/],
    [{ repo: 'owner/repository', issue_number: 43 }, /does not match/],
    [{ repo: '../repository', issue_number: 42 }, /Execution plan is invalid/],
    [{ repo: 'owner/repository', issue_number: '42' }, /Execution plan is invalid/],
    [{ repo: 'owner/repository', issue_number: 42, unexpected: true }, /Execution plan is invalid/]
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, issue: binding }));
    assert.throws(() => validateInputs(live, { repoRoot: repo.temp }), error);
  }
  fs.writeFileSync(file, JSON.stringify({ ...original, issue: { repo: 'owner/repository', issue_number: 42 } }));
  assert.equal(validateInputs(live, { repoRoot: repo.temp, requireLiveSandboxConfig: false }).issueNumber, 42);
  assert.throws(() => validateInputs(validEnv(repo, { SQUAD_ISSUE_NUMBER: '4e1' }), { repoRoot: repo.temp }), /decimal integer/);
});

test('offline stub runs fake dispatch and integration end to end', async t => {
  if (!findBash()) {
    t.skip('Bash is unavailable for the offline runner smoke test');
    return;
  }
  const repo = setupRepo(t);
  const plan = validateInputs(validEnv(repo), { repoRoot: repo.temp }).plan;
  const planPath = path.join(repo.temp, 'validated-squad-plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan));
  const outputDir = path.join(repo.temp, 'dispatcher-output');
  const stub = path.join(repoRoot, 'dispatcher', 'fixtures', 'offline-copilot.sh');
  fs.chmodSync(stub, 0o700);
  const previousCopilot = process.env.SQUAD_COPILOT_BIN;
  const previousToken = process.env.SQUAD_COPILOT_TOKEN;
  process.env.SQUAD_COPILOT_BIN = stub;
  try {
    const result = await runDispatcher({
      planPath,
      repoPath: repo.temp,
      outDir: outputDir,
      clientKind: 'fake',
      copilotToken: 'github_pat_offline_test'
    });
    assert.equal(result.summary.status, 'succeeded', JSON.stringify(result.summary, null, 2));
    assert.equal(result.summary.integration.status, 'succeeded', JSON.stringify(result.summary.integration, null, 2));
    assert.ok(fs.existsSync(path.join(outputDir, 'integration', 'patches', 'integrated.patch')));
  } finally {
    if (previousCopilot === undefined) delete process.env.SQUAD_COPILOT_BIN;
    else process.env.SQUAD_COPILOT_BIN = previousCopilot;
    if (previousToken === undefined) delete process.env.SQUAD_COPILOT_TOKEN;
    else process.env.SQUAD_COPILOT_TOKEN = previousToken;
  }
});

test('plan preflight validates a repository-relative regular path and the exact checked-out SHA', t => {
  const repo = setupRepo(t);
  const env = validEnv(repo);
  const result = validateInputs(env, { repoRoot: repo.temp });
  assert.equal(result.head, repo.head);
  assert.equal(result.plan.baseline_sha, repo.head);
  assert.equal(path.basename(result.planPath), 'execution.json');
});

test('validated materialization replaces the baseline sentinel with a full private checkout SHA', t => {
  const repo = setupRepo(t);
  const plan = validateInputs(validEnv(repo), { repoRoot: repo.temp }).plan;
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-plan-copy-'));
  t.after(() => fs.rmSync(runnerTemp, { recursive: true, force: true }));
  const target = writeMaterializedPlan(path.join(runnerTemp, 'validated-squad-plan.json'), runnerTemp, plan);
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(written.baseline_sha, repo.head);
  assert.ok(written.tasks.every(task => task.baseline_sha === repo.head));
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('plan preflight rejects malformed and absolute paths', t => {
  const repo = setupRepo(t);
  for (const planPath of ['../outside.json', '/tmp/outside.json', 'C:\\outside.json', 'plans//execution.json', 'plans/./execution.json']) {
    assert.throws(() => resolvePlanFile(repo.temp, planPath), /relative POSIX|empty, dot, or parent/);
  }
});

test('plan preflight rejects a symlink in any path segment', t => {
  const repo = setupRepo(t);
  const link = path.join(repo.temp, 'linked-plans');
  try {
    fs.symlinkSync(path.join(repo.temp, 'plans'), link, 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => resolvePlanFile(repo.temp, 'linked-plans/execution.json'), /symlinks/);
});

test('plan preflight rejects a baseline mismatch before any live credentials are required', t => {
  const repo = setupRepo(t);
  const planPath = path.join(repo.temp, 'plans', 'execution.json');
  const changed = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  changed.baseline_sha = 'f'.repeat(40);
  for (const task of changed.tasks) task.baseline_sha = changed.baseline_sha;
  fs.writeFileSync(planPath, JSON.stringify(changed));
  assert.throws(() => validateInputs(validEnv(repo, { SQUAD_EXECUTION_MODE: 'live', SQUAD_ENABLE_SANDBOX_LIVE: 'true' }), { repoRoot: repo.temp }), /baseline_sha .* does not match/);
});

test('live preflight rejects missing credentials and unverified ACA configuration', t => {
  const repo = setupRepo(t);
  const planPath = path.join(repo.temp, 'plans', 'execution.json');
  fs.writeFileSync(planPath, JSON.stringify({
    ...repo.plan, issue: { repo: 'owner/repository', issue_number: 42 }
  }));
  const liveEnv = validEnv(repo, {
    SQUAD_EXECUTION_MODE: 'live',
    SQUAD_ENABLE_SANDBOX_LIVE: 'true'
  });
  assert.throws(() => validateInputs(liveEnv, { repoRoot: repo.temp }), /Live sandbox configuration is incomplete/);
  const config = {
    SQUAD_SANDBOX_GROUP_NAME: 'group',
    SQUAD_SANDBOX_RESOURCE_GROUP_NAME: 'resource-group',
    SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
    SQUAD_SANDBOX_AZURE_CLIENT_ID: 'client-id',
    SQUAD_SANDBOX_AZURE_TENANT_ID: 'tenant-id',
    SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID: 'subscription-id',
    SQUAD_ACA_BIN: process.execPath,
    SQUAD_SANDBOX_IMAGE_REF: `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`,
    SQUAD_COPILOT_TOKEN: 'github_pat_test'
  };
  assert.throws(() => validateLiveSandboxConfig(config), /SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT=1/);
  assert.throws(() => validateLiveSandboxConfig({ ...config, SQUAD_SANDBOX_IMAGE_REF: 'repo:latest' }), /immutable sha256 digest/);
  assert.throws(() => validateLiveSandboxConfig({ ...config, SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID: 'not-a-uuid' }), /managed identity client ID/);
  assert.throws(() => validateLiveSandboxConfig({
    ...config,
    SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT: '1',
    SQUAD_COPILOT_TOKEN: 'ghp_classic'
  }), /fine-grained github_pat_/);
});

test('a failed dispatcher or integration summary cannot pass the publisher preflight', t => {
  const repo = setupRepo(t);
  const timestamp = '2026-09-26T00:00:00.000Z';
  const summary = {
    schema_version: 'aca-sandbox/v1',
    message_type: 'dispatcher.summary',
    run_id: repo.plan.run_id,
    status: 'failed',
    started_at: timestamp,
    ended_at: timestamp,
    integration: {
      status: 'failed',
      reason: 'test failure',
      sandbox_id: '',
      integrated_patch_path: 'integration/patches/integrated.patch',
      sha256: '0'.repeat(64),
      failed_task_id: '',
      check_results: [],
      deletion_error: ''
    },
    tasks: repo.plan.tasks.map(task => ({
      task_id: task.task_id,
      logical_member_id: task.owner.logical_member_id,
      status: 'succeeded',
      reason: '',
      started_at: timestamp,
      ended_at: timestamp,
      sandbox_id: 'sandbox-test',
      artifact_paths: [],
      deletion_error: ''
    }))
  };
  assert.throws(() => assertPublishableSummary(summary, repo.plan), /status must be succeeded/);
  summary.status = 'succeeded';
  summary.integration.status = 'failed';
  assert.throws(() => assertPublishableSummary(summary, repo.plan), /Integration must have succeeded/);
  const workflow = fs.readFileSync(path.join(workflowsDir, 'squad-sandbox-manual.yml'), 'utf8');
  assert.match(workflow, /publish-live:[\s\S]*?needs:\s*\[preflight,\s*dispatch-live\][\s\S]*?needs\.dispatch-live\.result == 'success'/);
});

test('publish input staging copies only required integration files and rejects unsafe artifact paths', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-publish-stage-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = setupRepo(t);
  const outDir = path.join(temp, 'out');
  fs.mkdirSync(path.join(outDir, 'integration', 'patches'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'dispatcher.log'), 'not copied\n');
  fs.writeFileSync(path.join(outDir, 'integration', 'artifact-manifest.json'), '{}\n');
  fs.writeFileSync(path.join(outDir, 'integration', 'patches', 'integrated.patch'), '');
  const summary = {
    schema_version: 'aca-sandbox/v1',
    message_type: 'dispatcher.summary',
    run_id: repo.plan.run_id,
    status: 'succeeded',
    started_at: '2026-09-26T00:00:00.000Z',
    ended_at: '2026-09-26T00:01:00.000Z',
    integration: {
      status: 'succeeded',
      reason: '',
      sandbox_id: 'sandbox-test',
      integrated_patch_path: 'integration/patches/integrated.patch',
      sha256: '0'.repeat(64),
      failed_task_id: '',
      check_results: [],
      deletion_error: ''
    },
    tasks: repo.plan.tasks.map(task => ({
      task_id: task.task_id,
      logical_member_id: task.owner.logical_member_id,
      status: 'succeeded',
      reason: '',
      started_at: '2026-09-26T00:00:00.000Z',
      ended_at: '2026-09-26T00:01:00.000Z',
      sandbox_id: 'sandbox-test',
      artifact_paths: [],
      deletion_error: ''
    }))
  };
  fs.writeFileSync(path.join(outDir, 'dispatcher-summary.json'), JSON.stringify(summary));
  const staged = stagePublishInputs(path.join(outDir, 'dispatcher-summary.json'), path.join(temp, 'publish-input'), repo.plan);
  assert.equal(fs.existsSync(path.join(staged, 'dispatcher.log')), false);
  assert.equal(fs.existsSync(path.join(staged, 'dispatcher-summary.json')), true);
  assert.equal(fs.existsSync(path.join(staged, 'integration', 'artifact-manifest.json')), true);
  assert.equal(fs.existsSync(path.join(staged, 'integration', 'patches', 'integrated.patch')), true);

  summary.integration.integrated_patch_path = '../../outside.patch';
  fs.writeFileSync(path.join(outDir, 'dispatcher-summary.json'), JSON.stringify(summary));
  assert.throws(() => stagePublishInputs(path.join(outDir, 'dispatcher-summary.json'), path.join(temp, 'publish-unsafe'), repo.plan), /unsafe path segment/);
});

test('fake mode cannot turn on either live gate and publish requires live dispatch', t => {
  const repo = setupRepo(t);
  assert.throws(() => validateInputs(validEnv(repo, { SQUAD_ENABLE_SANDBOX_LIVE: 'true' }), { repoRoot: repo.temp }), /Fake mode cannot enable/);
  assert.throws(() => validateInputs(validEnv(repo, { SQUAD_ENABLE_PUBLISH_LIVE: 'true' }), { repoRoot: repo.temp }), /Fake mode cannot enable/);
  assert.throws(() => validateInputs(validEnv(repo, { SQUAD_EXECUTION_MODE: 'live', SQUAD_ENABLE_SANDBOX_LIVE: 'false', SQUAD_ENABLE_PUBLISH_LIVE: 'true' }), { repoRoot: repo.temp }), /requires the separate sandbox/);
});

test('PEM staging validates the key, removes the secret from the process environment, and uses mode 600', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-pem-'));
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const env = { RUNNER_TEMP: dir, SQUAD_GITHUB_APP_PRIVATE_KEY_PEM: pem };
    const file = stagePem(env);
    assert.equal(env.SQUAD_GITHUB_APP_PRIVATE_KEY_PEM, undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), pem);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => stagePem({ RUNNER_TEMP: dir, SQUAD_GITHUB_APP_PRIVATE_KEY_PEM: 'not-a-key' }), /not a valid private key/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
