const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { runPublish, FakeGitHubClient, RealGitHubClient, sanitizeUntrusted, readPemFromEnv } = require('../publish');

const workRoot = path.join(__dirname, '.publish-work');
function resetDir(dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return String(result.stdout || '').trim();
}
function git(args, cwd, options = {}) { return run('git', args, { cwd, ...options }); }
function member(id, name = `Test ${id}`) {
  return { logical_member_id: id, resolved_persistent_name: name, charter_ref: `.squad/agents/${id}/charter.md`, membership: 'persona', capabilities: ['container'] };
}
function planFor(baseline, tasks) {
  const members = [...new Map(tasks.map(task => [task.owner.logical_member_id, task.owner])).values()];
  return {
    schema_version: 'aca-sandbox/v1',
    run_id: 'exec-12345',
    provider: { id: 'test-provider', kind: 'aca-sandbox', contract_version: 'aca-sandbox-provider/v1' },
    baseline_sha: baseline,
    roster: { revision: 'test-roster', hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', members },
    tasks: tasks.map(task => ({ task_id: task.task_id, owner: task.owner, objective: 'test objective', required_capabilities: ['container'], dependencies: [], baseline_sha: baseline, provider: { id: 'test-provider', kind: 'aca-sandbox', contract_version: 'aca-sandbox-provider/v1' }, schema_version: 'aca-sandbox/v1', owned_paths: task.owned_paths, ...(task.allow_executable_bits ? { allow_executable_bits: task.allow_executable_bits } : {}) }))
  };
}
function createRepoCase(name, options = {}) {
  const root = path.join(workRoot, name);
  resetDir(root);
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remotes', 'example', 'repo.git');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  git(['init', '--bare', remote], root);
  git(['init'], repo);
  git(['config', 'user.name', 'Test User'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  fs.mkdirSync(path.join(repo, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'alpha', 'base.txt'), 'base\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'baseline'], repo);
  git(['branch', '-M', 'main'], repo);
  git(['remote', 'add', 'origin', remote], repo);
  git(['push', 'origin', 'main'], repo);
  const baseline = git(['rev-parse', 'HEAD'], repo);
  const patch = 'diff --git a/alpha/result.txt b/alpha/result.txt\nnew file mode 100644\nindex 0000000..4329095\n--- /dev/null\n+++ b/alpha/result.txt\n@@ -0,0 +1 @@\n+published\n';
  const out = path.join(root, 'out');
  fs.mkdirSync(path.join(out, 'integration', 'patches'), { recursive: true });
  const patchPath = path.join(out, 'integration', 'patches', 'integrated.patch');
  fs.writeFileSync(patchPath, patch);
  const patchSha = require('node:crypto').createHash('sha256').update(patch).digest('hex');
  const owner = options.owner || member('test-agent-1', options.ownerName);
  const plan = planFor(baseline, [{ task_id: 'task-alpha', owner, owned_paths: options.ownedPaths || ['alpha'], allow_executable_bits: options.allow_executable_bits }]);
  const summary = { schema_version: 'aca-sandbox/v1', message_type: 'dispatcher.summary', run_id: plan.run_id, status: options.summaryStatus || 'succeeded', started_at: '2026-09-26T00:00:00Z', ended_at: '2026-09-26T00:00:01Z', integration: { status: options.integrationStatus || 'succeeded', reason: 'integration succeeded', sandbox_id: 'integration', integrated_patch_path: 'integration/patches/integrated.patch', sha256: options.patchSha || patchSha, failed_task_id: '', check_results: [{ name: options.checkName || 'unit @team #99', status: 'succeeded', exit_code: 0, stdout: '', stderr: '' }], deletion_error: '' }, tasks: [{ task_id: 'task-alpha', logical_member_id: owner.logical_member_id, status: 'succeeded', reason: '', started_at: '', ended_at: '', sandbox_id: 'sandbox', artifact_paths: [], deletion_error: '' }] };
  const manifest = { schema_version: 'aca-sandbox/v1', run_id: plan.run_id, task_id: 'integration', baseline_sha: baseline, roster: plan.roster, provider: plan.provider, artifacts: [{ artifact_id: 'integrated-patch', kind: 'patch', path: 'patches/integrated.patch', sha256: options.manifestSha || patchSha, size_bytes: patch.length }] };
  const summaryPath = path.join(out, 'dispatcher-summary.json');
  const manifestPath = path.join(out, 'integration', 'artifact-manifest.json');
  const planPath = path.join(root, 'plan.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { root, repo, remote, out, summaryPath, planPath, baseline, patchSha, plan };
}
function rewriteOptions(c) {
  return { gitRewriteBaseUrl: pathToFileURL(`${path.join(c.root, 'remotes')}${path.sep}`).toString() };
}
function expectedPublishMessage({ issueNumber = 42, executionId = 'exec-12345', issueTitle = 'Fix', branch = 'squad/aca-sandbox/issue-42-exec-12345-fix', personas = ['test-agent-1 (Test test-agent-1)'] } = {}) {
  return [
    `squad: publish issue #${issueNumber} from ${executionId}`,
    '',
    `Issue: #${issueNumber} ${issueTitle}`,
    `Execution: ${executionId}`,
    `Branch: ${branch}`,
    '',
    'Contributing personas:',
    ...personas.map(item => `- ${item}`),
    '',
    `Squad-Execution-Id: ${executionId}`,
    'Co-authored-by: squad-aca-bot[bot] <3362344+squad-aca-bot[bot]@users.noreply.github.com>',
    ''
  ].join('\n');
}
async function publishCase(name, options = {}) {
  const c = createRepoCase(name, options);
  const client = options.client || new FakeGitHubClient();
  const spawns = [];
  const result = await runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: options.issueTitle || 'Fix @team #123 <b>', githubClient: client, onGitSpawn: s => spawns.push(s), outPath: path.join(c.out, 'publish-result.json'), ...rewriteOptions(c), ...(options.publishOptions || {}) });
  return { ...c, ...result, client, spawns };
}

test.beforeEach(() => resetDir(workRoot));

test('happy path creates one branch commit draft PR labels and expected tree', async () => {
  const { result, client, repo, baseline, plan, spawns } = await publishCase('happy');
  assert.equal(result.idempotency, 'created');
  assert.equal(client.prs.length, 1);
  assert.equal(client.prs[0].draft, true);
  assert.match(client.prs[0].body, /Execution ID/);
  assert.match(client.prs[0].body, /Integrated patch SHA-256/);
  assert.match(client.prs[0].body, /\| Task ID \| Logical member/);
  assert.doesNotMatch(client.prs[0].body, /@team/);
  assert.doesNotMatch(client.prs[0].body, /#123/);
  assert.deepEqual(client.labels[0], { add: ['squad:queued'], remove: ['squad:processing'] });
  assert.equal(client.comments.length, 1);
  assert.match(client.comments[0].body, /<!-- squad-aca-publish:exec-12345 -->/);
  const branchSha = git(['ls-remote', 'origin', `refs/heads/${result.branch}`], repo).split(/\s+/)[0];
  assert.equal(branchSha, result.commit_sha);
  const indexFile = path.join(path.dirname(repo), 'expected.index');
  fs.rmSync(indexFile, { force: true });
  git(['read-tree', `${baseline}^{tree}`], repo, { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  git(['apply', '--cached', path.join(path.dirname(repo), 'out', 'integration', 'patches', 'integrated.patch')], repo, { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  const expectedTree = git(['write-tree'], repo, { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  const commitTree = git(['show', '-s', '--format=%T', result.commit_sha], repo);
  assert.equal(commitTree, expectedTree);
  const push = spawns.filter(s => s.args.includes('push'));
  assert.equal(push.length, 1);
});

test('publisher ignores checkout origin and uses explicit validated repo URL with negative control', async () => {
  const c = createRepoCase('pinned-url');
  const attacker = path.join(c.root, 'attacker.git');
  git(['init', '--bare', attacker], c.root);
  git(['remote', 'set-url', 'origin', attacker], c.repo);
  git(['push', 'origin', 'main'], c.repo);
  assert.match(git(['ls-remote', '--get-url', 'origin'], c.repo), /attacker\.git/);
  const spawns = [];
  const result = await runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Pinned URL', githubClient: new FakeGitHubClient(), onGitSpawn: s => spawns.push(s), outPath: path.join(c.out, 'publish-result.json'), ...rewriteOptions(c) });
  assert.equal(git(['ls-remote', attacker, `refs/heads/${result.result.branch}`], c.repo), '');
  assert.notEqual(git(['ls-remote', c.remote, `refs/heads/${result.result.branch}`], c.repo), '');
  const remoteCommands = spawns.filter(s => s.args.includes('fetch') || s.args.includes('ls-remote') || s.args.includes('push'));
  assert(remoteCommands.every(s => s.args.includes('https://github.com/example/repo.git')));
  assert(remoteCommands.every(s => !s.args.includes('origin')));
});

test('invalid repo full names are rejected before remote git with negative control', async () => {
  const c = createRepoCase('repo-validation');
  const spawns = [];
  await assert.rejects(runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo.git', issueNumber: 42, issueTitle: 'Repo validation', githubClient: new FakeGitHubClient(), onGitSpawn: s => spawns.push(s), outPath: path.join(c.out, 'publish-result.json'), ...rewriteOptions(c) }), /must match owner\/repo/);
  assert.equal(spawns.length, 0);
  await publishCase('repo-validation-good', { issueTitle: 'Repo validation' });
});

test('publisher checks plan binding and freshness before requesting any installation token', async () => {
  const c = createRepoCase('binding-preflight');
  let tokenRequests = 0;
  const client = new FakeGitHubClient();
  client.createInstallationToken = async () => { tokenRequests += 1; throw new Error('token request reached'); };
  const publish = (overrides = {}) => runPublish({
    summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath,
    repoFullName: 'example/repo', issueNumber: 42, githubClient: client,
    outPath: path.join(c.out, 'publish-result.json'), ...rewriteOptions(c),
    live: true, ...overrides
  });
  await assert.rejects(publish(), /requires a plan issue binding/);
  const original = JSON.parse(fs.readFileSync(c.planPath, 'utf8'));
  for (const [issue, message] of [
    [{ repo: 'other/repo', issue_number: 42 }, /does not match/],
    [{ repo: 'example/repo', issue_number: 43 }, /does not match/],
    [{ repo: 'example/../repo', issue_number: 42 }, /Execution plan is invalid/],
    [{ repo: 'example/repo', issue_number: 0 }, /Execution plan is invalid/]
  ]) {
    fs.writeFileSync(c.planPath, JSON.stringify({ ...original, issue }));
    await assert.rejects(publish(), message);
  }
  const bound = { ...original, issue: { repo: 'example/repo', issue_number: 42 } };
  fs.writeFileSync(c.planPath, JSON.stringify(bound));
  await assert.rejects(publish({ repoFullName: 'different/repo' }), /does not match/);
  await assert.rejects(publish({ issueNumber: 43 }), /does not match/);
  await assert.rejects(publish({ issueNumber: '4e1' }), /decimal integer/);
  const oldRepository = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = 'other/repo';
  try {
    await assert.rejects(publish(), /does not match the workflow repository/);
  } finally {
    if (oldRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = oldRepository;
  }
  fs.writeFileSync(c.planPath, JSON.stringify({ ...bound, run_id: 'stale-run' }));
  await assert.rejects(publish(), /run_id or baseline_sha does not match/);
  fs.writeFileSync(c.planPath, JSON.stringify({
    ...bound, baseline_sha: 'f'.repeat(40),
    tasks: bound.tasks.map(task => ({ ...task, baseline_sha: 'f'.repeat(40) }))
  }));
  await assert.rejects(publish(), /run_id or baseline_sha does not match/);
  await assert.rejects(publish({ planPath: undefined }), /requires a validated execution plan/);
  assert.equal(tokenRequests, 0);
});

test('publisher validates integration manifest identity before any GitHub client call', async () => {
  for (const [name, mutate, expected] of [
    ['manifest-run-id', manifest => { manifest.run_id = 'other-run'; }, /manifest run_id does not match dispatcher summary/],
    ['manifest-baseline', manifest => { manifest.baseline_sha = 'f'.repeat(40); }, /run_id or baseline_sha does not match/],
    ['misleading-baseline-override', undefined, /--baseline-sha does not match/]
  ]) {
    const c = createRepoCase(name);
    const client = new FakeGitHubClient();
    let calls = 0;
    const originalTokenRequest = client.createInstallationToken.bind(client);
    client.createInstallationToken = async options => {
      calls += 1;
      return originalTokenRequest(options);
    };
    if (mutate) {
      const manifestPath = path.join(c.out, 'integration', 'artifact-manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      mutate(manifest);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    await assert.rejects(runPublish({
      summaryPath: c.summaryPath,
      repoPath: c.repo,
      planPath: c.planPath,
      repoFullName: 'example/repo',
      issueNumber: 42,
      githubClient: client,
      baselineSha: name === 'misleading-baseline-override' ? 'f'.repeat(40) : undefined,
      outPath: path.join(c.out, 'publish-result.json'),
      ...rewriteOptions(c)
    }), expected);
    assert.equal(calls, 0, `${name} must fail before requesting an installation token`);
  }
});

test('rerun with same execution is idempotent and does not push or create a second PR', async () => {
  const first = await publishCase('idempotent');
  const spawns = [];
  const second = await runPublish({ summaryPath: first.summaryPath, repoPath: first.repo, planPath: first.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix @team #123 <b>', githubClient: first.client, onGitSpawn: s => spawns.push(s), outPath: path.join(first.out, 'second.json'), ...rewriteOptions(first) });
  assert.equal(second.result.idempotency, 'existing');
  assert.equal(first.client.prs.length, 1);
  assert.equal(spawns.some(s => s.args.includes('push')), false);
  assert.equal(first.client.comments.length, 1, 'existing PR reuse must not duplicate marker comments');
  assert.deepEqual(first.client.labels[1], { add: ['squad:queued'], remove: ['squad:processing'] });
});

test('existing PR reuse repairs lifecycle labels and missing marker comment', async () => {
  const first = await publishCase('existing-pr-repair');
  first.client.labels = [];
  first.client.comments = [{ id: 1, body: 'unrelated comment' }];
  const second = await runPublish({ summaryPath: first.summaryPath, repoPath: first.repo, planPath: first.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix @team #123 <b>', githubClient: first.client, outPath: path.join(first.out, 'second.json'), ...rewriteOptions(first) });
  assert.equal(second.result.idempotency, 'existing');
  assert.deepEqual(first.client.labels[0], { add: ['squad:queued'], remove: ['squad:processing'] });
  assert.equal(first.client.comments.length, 2);
  assert.match(first.client.comments[1].body, /<!-- squad-aca-publish:exec-12345 -->/);
});

test('existing marker on the second comment page prevents a duplicate comment', async () => {
  const first = await publishCase('marker-page-two');
  first.client.comments = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `unrelated ${index}` }));
  first.client.comments.push({ id: 101, body: '<!-- squad-aca-publish:exec-12345 -->' });
  first.client.commentListPages.length = 0;

  const second = await runPublish({ summaryPath: first.summaryPath, repoPath: first.repo, planPath: first.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix @team #123 <b>', githubClient: first.client, outPath: path.join(first.out, 'second.json'), ...rewriteOptions(first) });

  assert.equal(second.result.idempotency, 'existing');
  assert.deepEqual(first.client.commentListPages, [1, 2]);
  assert.equal(first.client.comments.length, 101);
});

test('marker absent across comment pages creates exactly one marker comment', async () => {
  const first = await publishCase('marker-absent-pages');
  first.client.comments = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, body: `unrelated ${index}` }));
  first.client.commentListPages.length = 0;

  const second = await runPublish({ summaryPath: first.summaryPath, repoPath: first.repo, planPath: first.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix @team #123 <b>', githubClient: first.client, outPath: path.join(first.out, 'second.json'), ...rewriteOptions(first) });

  assert.equal(second.result.idempotency, 'existing');
  assert.deepEqual(first.client.commentListPages, [1, 2]);
  assert.equal(first.client.comments.length, 102);
  assert.match(first.client.comments[101].body, /<!-- squad-aca-publish:exec-12345 -->/);
});

test('comment pagination fails closed at its page bound', async () => {
  const first = await publishCase('marker-page-bound');
  const pages = [];
  first.client.listIssueComments = async ({ page }) => {
    pages.push(page);
    return Array.from({ length: 100 }, (_, index) => ({ body: `unrelated ${page}-${index}` }));
  };

  await assert.rejects(runPublish({ summaryPath: first.summaryPath, repoPath: first.repo, planPath: first.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: first.client, outPath: path.join(first.out, 'second.json'), ...rewriteOptions(first) }), /exceeded 100 pages/);
  assert.equal(pages.length, 100);
  assert.equal(pages[0], 1);
  assert.equal(pages.at(-1), 100);
  assert.equal(first.client.comments.length, 1);
});

test('malformed comment page fails closed without creating a duplicate', async () => {
  const first = await publishCase('marker-malformed-page');
  first.client.listIssueComments = async () => ({ next: 'page-2' });

  await assert.rejects(runPublish({ summaryPath: first.summaryPath, repoPath: first.repo, planPath: first.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: first.client, outPath: path.join(first.out, 'second.json'), ...rewriteOptions(first) }), /response must be an array/);
  assert.equal(first.client.comments.length, 1);
});

test('existing matching branch without PR creates PR without re-pushing with negative control', async () => {
  const first = await publishCase('branch-matching');
  first.client.prs = [];
  const spawns = [];
  const second = await runPublish({ summaryPath: first.summaryPath, repoPath: first.repo, planPath: first.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix @team #123 <b>', githubClient: first.client, onGitSpawn: s => spawns.push(s), outPath: path.join(first.out, 'second.json'), ...rewriteOptions(first) });
  assert.equal(second.result.idempotency, 'created');
  assert.equal(first.client.prs.length, 1);
  assert.equal(spawns.some(s => s.args.includes('push')), false);
  assert.notEqual(git(['ls-remote', first.remote, `refs/heads/${second.result.branch}`], first.repo), '');
});

test('closed or merged PR for deterministic branch fails without push with negative control', async () => {
  const c = createRepoCase('closed-pr');
  const client = new FakeGitHubClient();
  client.prs.push({ number: 99, html_url: 'https://github.example/pr/99', head: 'squad/aca-sandbox/issue-42-exec-12345-fix', state: 'closed', merged_at: '2026-09-26T00:00:00Z' });
  const spawns = [];
  await assert.rejects(runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: client, onGitSpawn: s => spawns.push(s), outPath: path.join(c.out, 'publish-result.json'), ...rewriteOptions(c) }), /merged pull request/);
  assert.equal(spawns.some(s => s.args.includes('push')), false);
  const ok = await publishCase('closed-pr-open-control', { issueTitle: 'Fix' });
  const reused = await runPublish({ summaryPath: ok.summaryPath, repoPath: ok.repo, planPath: ok.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: ok.client, outPath: path.join(ok.out, 'open.json'), ...rewriteOptions(ok) });
  assert.equal(reused.result.idempotency, 'existing');
});

test('failed summary is refused before any client call', async () => {
  const c = createRepoCase('failed-summary', { summaryStatus: 'failed' });
  const client = new FakeGitHubClient();
  await assert.rejects(runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, githubClient: client, ...rewriteOptions(c) }), /status must be succeeded/);
  assert.equal(client.tokenRequests.length, 0);
});

test('sha256 mismatch is refused', async () => {
  const c = createRepoCase('sha-mismatch', { patchSha: '0'.repeat(64) });
  await assert.rejects(runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, githubClient: new FakeGitHubClient(), ...rewriteOptions(c) }), /sha256/);
});

test('delta policy violation is refused after tampering patch', async () => {
  const c = createRepoCase('delta-policy');
  fs.writeFileSync(path.join(c.out, 'integration', 'patches', 'integrated.patch'), 'diff --git a/.squad/evil.txt b/.squad/evil.txt\nnew file mode 100644\nindex 0000000..257cc56\n--- /dev/null\n+++ b/.squad/evil.txt\n@@ -0,0 +1 @@\n+evil\n');
  const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(c.out, 'integration', 'patches', 'integrated.patch'))).digest('hex');
  const summary = JSON.parse(fs.readFileSync(c.summaryPath, 'utf8'));
  summary.integration.sha256 = sha;
  fs.writeFileSync(c.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  const manifest = JSON.parse(fs.readFileSync(path.join(c.out, 'integration', 'artifact-manifest.json'), 'utf8'));
  manifest.artifacts[0].sha256 = sha;
  fs.writeFileSync(path.join(c.out, 'integration', 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, githubClient: new FakeGitHubClient(), ...rewriteOptions(c) }), /delta policy|protected/);
});

test('remote branch existing with different commit is refused without force push', async () => {
  const c = createRepoCase('branch-different');
  const branch = 'squad/aca-sandbox/issue-42-exec-12345-fix';
  fs.writeFileSync(path.join(c.repo, 'other.txt'), 'other\n');
  git(['add', 'other.txt'], c.repo);
  git(['commit', '-m', 'other'], c.repo);
  git(['push', 'origin', `HEAD:refs/heads/${branch}`], c.repo);
  const spawns = [];
  await assert.rejects(runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: new FakeGitHubClient(), onGitSpawn: s => spawns.push(s), ...rewriteOptions(c) }), /does not match verified publish content/);
  const pushCommands = spawns.filter(s => s.args.includes('push'));
  assert.equal(pushCommands.length, 0);
});

test('existing open PR is reused only when branch head tree and parent match verified patch', async () => {
  const c = createRepoCase('existing-pr-content-check');
  const branch = 'squad/aca-sandbox/issue-42-exec-12345-fix';
  fs.writeFileSync(path.join(c.repo, 'other.txt'), 'other\n');
  git(['add', 'other.txt'], c.repo);
  git(['commit', '-m', 'other'], c.repo);
  const badSha = git(['rev-parse', 'HEAD'], c.repo);
  git(['push', 'origin', `HEAD:refs/heads/${branch}`], c.repo);
  const client = new FakeGitHubClient();
  client.prs.push({ number: 7, html_url: 'https://github.example/pr/7', head: { ref: branch, sha: badSha }, state: 'open' });
  const spawns = [];
  await assert.rejects(runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: client, onGitSpawn: s => spawns.push(s), outPath: path.join(c.out, 'publish-result.json'), ...rewriteOptions(c) }), /does not match verified publish content/);
  assert.equal(spawns.some(s => s.args.includes('push')), false);

  const ok = await publishCase('existing-pr-content-control', { issueTitle: 'Fix' });
  const reused = await runPublish({ summaryPath: ok.summaryPath, repoPath: ok.repo, planPath: ok.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: ok.client, outPath: path.join(ok.out, 'second.json'), ...rewriteOptions(ok) });
  assert.equal(reused.result.idempotency, 'existing');
});

test('existing matching branch without PR may differ only by author and committer timestamps', async () => {
  const c = createRepoCase('branch-metadata-only');
  const branch = 'squad/aca-sandbox/issue-42-exec-12345-fix';
  const indexFile = path.join(c.root, 'metadata.index');
  fs.rmSync(indexFile, { force: true });
  git(['read-tree', `${c.baseline}^{tree}`], c.repo, { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  git(['apply', '--cached', path.join(c.out, 'integration', 'patches', 'integrated.patch')], c.repo, { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  const tree = git(['write-tree'], c.repo, { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  const metadataOnlyCommit = git(['commit-tree', tree, '-p', c.baseline], c.repo, {
    input: expectedPublishMessage(),
    env: {
      ...process.env,
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: 'squad-aca-bot[bot]',
      GIT_AUTHOR_EMAIL: '3362344+squad-aca-bot[bot]@users.noreply.github.com',
      GIT_AUTHOR_DATE: '2026-09-26T00:00:02Z',
      GIT_COMMITTER_NAME: 'squad-aca-bot[bot]',
      GIT_COMMITTER_EMAIL: '3362344+squad-aca-bot[bot]@users.noreply.github.com',
      GIT_COMMITTER_DATE: '2026-09-26T00:00:02Z'
    }
  });
  git(['push', 'origin', `${metadataOnlyCommit}:refs/heads/${branch}`], c.repo);
  const client = new FakeGitHubClient();
  const spawns = [];
  const result = await runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: client, onGitSpawn: s => spawns.push(s), outPath: path.join(c.out, 'publish-result.json'), ...rewriteOptions(c) });
  assert.equal(result.result.commit_sha, metadataOnlyCommit);
  assert.equal(client.prs.length, 1);
  assert.equal(spawns.some(s => s.args.includes('push')), false);
});

test('existing matching branch without PR rejects planted message and foreign author', async () => {
  const makeCommit = (name, message, authorName = 'squad-aca-bot[bot]', authorEmail = '3362344+squad-aca-bot[bot]@users.noreply.github.com') => {
    const c = createRepoCase(name);
    const branch = 'squad/aca-sandbox/issue-42-exec-12345-fix';
    const indexFile = path.join(c.root, `${name}.index`);
    fs.rmSync(indexFile, { force: true });
    git(['read-tree', `${c.baseline}^{tree}`], c.repo, { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
    git(['apply', '--cached', path.join(c.out, 'integration', 'patches', 'integrated.patch')], c.repo, { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
    const tree = git(['write-tree'], c.repo, { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
    const commit = git(['commit-tree', tree, '-p', c.baseline], c.repo, {
      input: message,
      env: {
        ...process.env,
        GIT_INDEX_FILE: indexFile,
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_AUTHOR_DATE: '2026-09-26T00:00:02Z',
        GIT_COMMITTER_NAME: authorName,
        GIT_COMMITTER_EMAIL: authorEmail,
        GIT_COMMITTER_DATE: '2026-09-26T00:00:02Z'
      }
    });
    git(['push', 'origin', `${commit}:refs/heads/${branch}`], c.repo);
    return c;
  };
  const planted = makeCommit('branch-planted-message', `${expectedPublishMessage()}Fixes #999\n`);
  await assert.rejects(runPublish({ summaryPath: planted.summaryPath, repoPath: planted.repo, planPath: planted.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: new FakeGitHubClient(), outPath: path.join(planted.out, 'publish-result.json'), ...rewriteOptions(planted) }), /commit message does not match/);
  const foreign = makeCommit('branch-foreign-author', expectedPublishMessage(), 'Foreign Author', 'foreign@example.invalid');
  await assert.rejects(runPublish({ summaryPath: foreign.summaryPath, repoPath: foreign.repo, planPath: foreign.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: new FakeGitHubClient(), outPath: path.join(foreign.out, 'publish-result.json'), ...rewriteOptions(foreign) }), /author identity/);
});

test('created PR head mismatch records failed receipt and does not label or comment', async () => {
  const c = createRepoCase('created-head-mismatch');
  const client = new FakeGitHubClient();
  client.nextCreatedHeadSha = c.baseline;
  const outPath = path.join(c.out, 'publish-result.json');
  await assert.rejects(runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix', githubClient: client, outPath, ...rewriteOptions(c) }), /does not match published commit/);
  const receipt = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.commit_sha === c.baseline, false);
  assert.equal(client.labels.length, 0);
  assert.equal(client.comments.length, 0);
});

test('label DELETE errors fail except 404 is ignored', async () => {
  const failing = new FakeGitHubClient();
  failing.deleteLabelStatus.set('squad:processing', 500);
  await assert.rejects(publishCase('label-delete-500', { client: failing, issueTitle: 'Fix' }), /DELETE squad:processing failed with 500/);
  assert.equal(failing.prs.length, 1);
  assert.equal(failing.comments.length, 0);

  const missing = new FakeGitHubClient();
  missing.deleteLabelStatus.set('squad:processing', 404);
  const ok = await publishCase('label-delete-404', { client: missing, issueTitle: 'Fix' });
  assert.equal(ok.result.status, 'succeeded');
  assert.deepEqual(missing.labels[0], { add: ['squad:queued'], remove: ['squad:processing'] });
});

test('token is scoped to repository URL for fetch and push and never in argv or output', async () => {
  const client = new FakeGitHubClient();
  const secret = 'github_pat_publishSecret';
  client.token = secret;
  const c = createRepoCase('token-boundary');
  const spawns = [];
  const published = await runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Fix @team #123 <b>', githubClient: client, onGitSpawn: s => spawns.push(s), outPath: path.join(c.out, 'publish-result.json'), ...rewriteOptions(c) });
  for (const spawn of spawns) assert.equal(spawn.args.join(' ').includes(client.token), false);
  const withToken = spawns.filter(spawn => JSON.stringify(spawn.env).includes(client.token));
  assert(withToken.length >= 2);
  assert(withToken.some(spawn => spawn.args.includes('fetch')));
  assert(withToken.some(spawn => spawn.args.includes('push')));
  const push = withToken.find(spawn => spawn.args.includes('push'));
  assert(push.args.includes('https://github.com/example/repo.git'));
  assert(push.args.includes('--force-with-lease=refs/heads/squad/aca-sandbox/issue-42-exec-12345-fix-team-123-b:'));
  assert.equal(push.env.GIT_CONFIG_KEY_0, 'http.https://github.com/example/repo.git.extraheader');
  assert.equal(push.env.GIT_CONFIG_KEY_1, 'http.followRedirects');
  assert.equal(push.env.GIT_CONFIG_VALUE_1, 'false');
  assert.equal(push.env.GIT_CONFIG_KEY_2, 'credential.helper');
  assert.deepEqual(Object.keys(published).sort(), ['result', 'resultPath']);
  assert.equal(JSON.stringify(published).includes(secret), false, 'serialized runPublish result must not contain the installation token');
  assert.equal(fs.readFileSync(published.resultPath, 'utf8').includes(secret), false);
  assert.equal(Object.hasOwn(process.env, 'GITHUB_TOKEN'), false);
});

test('markdown mention injection is neutralized with negative control', () => {
  const raw = 'hello @team and #123 <b>';
  assert.match(raw, /@team/);
  assert.match(raw, /#123/);
  const safe = sanitizeUntrusted(raw, 'raw');
  assert.doesNotMatch(safe, /@team/);
  assert.doesNotMatch(safe, /#123/);
  assert.match(safe, /@‍team/);
});

test('PR title strips invisible controls and neutralizes mentions and refs with negative control', async () => {
  const rawTitle = 'Fix \u202E @org/team #123';
  assert.match(rawTitle, /\u202E/);
  assert.match(rawTitle, /@org\/team/);
  assert.match(rawTitle, /#123/);
  const { client } = await publishCase('title-sanitized', { issueTitle: rawTitle });
  assert.doesNotMatch(client.prs[0].title, /\u202E/);
  assert.doesNotMatch(client.prs[0].title, /@org\/team/);
  assert.doesNotMatch(client.prs[0].title, /#123/);
  assert.match(client.prs[0].title, /@‍org\/team/);
  assert.match(client.prs[0].title, /#‍123/);
});

test('token pattern in persona-derived text fails closed', async () => {
  await assert.rejects(publishCase('persona-token', { ownerName: 'github_pat_badSecret' }), /token-looking pattern/);
});

test('real GitHub client caps responses and redacts bounded parse errors with negative control', async () => {
  const oldGate = process.env.SQUAD_ENABLE_PUBLISH;
  process.env.SQUAD_ENABLE_PUBLISH = '1';
  const originalRequest = https.request;
  const installMock = responder => {
    https.request = (url, options, callback) => {
      const req = new EventEmitter();
      req.setTimeout = (ms, handler) => { req.timeoutHandler = handler; };
      req.destroy = () => { req.destroyed = true; req.emit('error', new Error('destroyed github_pat_secret')); };
      req.end = () => responder(req, callback);
      return req;
    };
  };
  try {
    const client = new RealGitHubClient({ live: true, appId: '1', installationId: '2', privateKeyPem: 'not-used', maxResponseBytes: 20, requestTimeoutMs: 5 });
    installMock((req, callback) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      res.emit('data', Buffer.from('{"ok":true}'));
      res.emit('end');
    });
    assert.deepEqual(await client.request('GET', '/ok', undefined, 'github_pat_secret'), { ok: true });
    installMock((req, callback) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      res.emit('data', Buffer.from('{bad'));
      res.emit('end');
    });
    await assert.rejects(client.request('GET', '/bad-json', undefined, 'github_pat_secret'), error => {
      assert.match(error.message, /invalid JSON/);
      assert.doesNotMatch(error.message, /github_pat_secret/);
      return true;
    });
    installMock((req, callback) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      res.emit('data', Buffer.alloc(21, 'a'));
    });
    await assert.rejects(client.request('GET', '/too-large', undefined, 'github_pat_secret'), /response exceeded 20 bytes/);
    installMock(req => req.timeoutHandler());
    await assert.rejects(client.request('GET', '/timeout', undefined, 'github_pat_secret'), /timed out/);
  } finally {
    https.request = originalRequest;
    if (oldGate === undefined) delete process.env.SQUAD_ENABLE_PUBLISH; else process.env.SQUAD_ENABLE_PUBLISH = oldGate;
  }
});

test('PEM loader rejects unsafe key files with negative control', () => {
  const dir = path.join(workRoot, 'pem');
  resetDir(dir);
  const { privateKey } = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  const goodPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const good = path.join(dir, 'good.pem');
  fs.writeFileSync(good, goodPem);
  const oldSquad = process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH;
  const oldGitHub = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  try {
    process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH = good;
    assert.match(readPemFromEnv(), /PRIVATE KEY/);
    const big = path.join(dir, 'big.pem');
    fs.writeFileSync(big, `${'x'.repeat(17 * 1024)}\n`);
    process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH = big;
    assert.throws(() => readPemFromEnv(), /exceeds/);
    const directory = path.join(dir, 'directory.pem');
    fs.mkdirSync(directory);
    process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH = directory;
    assert.throws(() => readPemFromEnv(), /regular file/);
    const invalid = path.join(dir, 'invalid.pem');
    fs.writeFileSync(invalid, 'not a private key');
    process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH = invalid;
    assert.throws(() => readPemFromEnv(), /PEM private key/);
    try {
      const link = path.join(dir, 'link.pem');
      fs.symlinkSync(good, link);
      process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH = link;
      assert.throws(() => readPemFromEnv(), /symlink/);
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    }
  } finally {
    if (oldSquad === undefined) delete process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH; else process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH = oldSquad;
    if (oldGitHub === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY_PATH; else process.env.GITHUB_APP_PRIVATE_KEY_PATH = oldGitHub;
  }
});

test('global hooks do not run during commit or push with negative control', async () => {
  const c = createRepoCase('hooks');
  const marker = path.join(c.root, 'hook-ran.marker');
  const hooks = path.join(c.root, 'global-hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const hook = path.join(hooks, 'pre-push');
  fs.writeFileSync(hook, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exit(0);\n`);
  fs.chmodSync(hook, 0o755);
  const fakeHome = path.join(c.root, 'fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const hookEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  git(['config', '--global', 'core.hooksPath', hooks], c.repo, { env: hookEnv });
  git(['push', 'origin', 'main'], c.repo, { env: hookEnv });
  assert.equal(fs.existsSync(marker), true, 'negative control must prove pre-push can run');
  fs.rmSync(marker, { force: true });
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    await runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Hook safe', githubClient: new FakeGitHubClient(), outPath: path.join(c.out, 'publish-result.json'), ...rewriteOptions(c) });
    assert.equal(fs.existsSync(marker), false, 'publisher must disable global hooks');
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
  }
});

test('stale publish work hooks and symlinked hook directories are not reused', async () => {
  const c = createRepoCase('stale-hooks');
  const marker = path.join(c.root, 'stale-hook-ran.marker');
  const staleHooks = path.join(c.out, '.publish-work', 'hooks');
  fs.mkdirSync(staleHooks, { recursive: true });
  const hook = path.join(staleHooks, 'pre-push');
  fs.writeFileSync(hook, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exit(0);\n`);
  fs.chmodSync(hook, 0o755);
  git(['-c', `core.hooksPath=${staleHooks}`, 'push', 'origin', 'main:refs/heads/hook-negative-control'], c.repo);
  assert.equal(fs.existsSync(marker), true, 'negative control must prove the stale pre-push hook can run');
  fs.rmSync(marker, { force: true });

  await runPublish({ summaryPath: c.summaryPath, repoPath: c.repo, planPath: c.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Stale hooks', githubClient: new FakeGitHubClient(), outPath: path.join(c.out, 'publish-result.json'), ...rewriteOptions(c) });
  assert.equal(fs.existsSync(marker), false, 'publisher must use a fresh private hooks directory');

  const symlinkCase = createRepoCase('symlinked-hooks');
  const symlinkMarker = path.join(symlinkCase.root, 'symlink-hook-ran.marker');
  const actualHooks = path.join(symlinkCase.root, 'actual-hooks');
  fs.mkdirSync(actualHooks, { recursive: true });
  fs.writeFileSync(path.join(actualHooks, 'pre-push'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(symlinkMarker)}, 'ran');\nprocess.exit(0);\n`);
  fs.chmodSync(path.join(actualHooks, 'pre-push'), 0o755);
  const symlinkHooks = path.join(symlinkCase.out, '.publish-work', 'hooks');
  fs.mkdirSync(path.dirname(symlinkHooks), { recursive: true });
  try {
    fs.symlinkSync(actualHooks, symlinkHooks, 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    return;
  }
  assert.equal(fs.lstatSync(symlinkHooks).isSymbolicLink(), true, 'negative control must create a symlinked hooks directory');
  await runPublish({ summaryPath: symlinkCase.summaryPath, repoPath: symlinkCase.repo, planPath: symlinkCase.planPath, repoFullName: 'example/repo', issueNumber: 42, issueTitle: 'Symlink hooks', githubClient: new FakeGitHubClient(), outPath: path.join(symlinkCase.out, 'publish-result.json'), ...rewriteOptions(symlinkCase) });
  assert.equal(fs.existsSync(symlinkMarker), false, 'publisher must bypass a symlinked stale hooks directory');
});

test('live client refuses without live gate and token request is minimal repository scoped', async () => {
  const cli = spawnSync(process.execPath, ['dispatcher\\cli.js', 'publish', '--summary', 'missing.json', '--repo', '.', '--plan', 'missing-plan.json', '--repo-full-name', 'example/repo', '--issue-number', '42', '--live'], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', env: { ...process.env, SQUAD_ENABLE_PUBLISH: '' } });
  assert.notEqual(cli.status, 0);
  assert.match(`${cli.stdout}\n${cli.stderr}`, /SQUAD_ENABLE_PUBLISH=1/);
  const client = new FakeGitHubClient();
  await publishCase('token-request', { client });
  assert.deepEqual(client.tokenRequests[0].permissions, { contents: 'write', pull_requests: 'write', issues: 'write' });
  assert.equal(client.tokenRequests[0].repo, 'repo');
});
