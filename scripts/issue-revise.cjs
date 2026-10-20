'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadRoster, supportedKind, evaluateEvent } = require('./issue-plan.cjs');
const { loadConfig, memberPaths, globToRegExp, isDeniedPath } = require('./sandbox-flow-config.cjs');
const { ensureLabel } = require('./issue-triage.cjs');
const BRANCH = /^squad\/aca-sandbox\/issue-([1-9][0-9]*)-[a-z0-9-]+$/;
const HINT = '<!-- squad-sandbox-conflict-hint:v1 -->';
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
function fail(code) { throw new Error(code); }
function parseCommand(body) {
  if (typeof body !== 'string' || body.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) fail('REVISE_COMMAND_INVALID');
  const match = /^\/squad revise[ \t]+?(?:([a-z][a-z0-9-]*):[ \t]*)?([^\s][\s\S]*)$/.exec(body.trim());
  if (!match || !match[2].trim() || /^\S+:/.test(match[2]) || match[2].includes('/squad revise')) fail('REVISE_COMMAND_INVALID');
  return { target: match[1] || null, instructions: match[2].trim() };
}
function ownedPull(pr, repository) {
  return pr?.state === 'open' && pr.user?.type === 'Bot' &&
    pr.head?.repo?.full_name === repository && pr.base?.repo?.full_name === repository && pr.base.ref === 'main' && BRANCH.test(pr.head.ref);
}
function validateRequest(event, pr, env, roster) {
  if (event.action !== 'created' || !event.issue?.pull_request || !TRUSTED.has(event.comment?.author_association) || event.comment.user?.type !== 'User') fail('REVISE_COMMENT_NOT_TRUSTED');
  if (!ownedPull(pr, env.GITHUB_REPOSITORY) || pr.number !== event.issue.number) fail('REVISE_PR_REJECTED');
  const issueNumber = Number(BRANCH.exec(pr.head.ref)[1]);
  if (!Number.isSafeInteger(issueNumber) || env.SQUAD_ISSUE_NUMBER && env.SQUAD_ISSUE_NUMBER !== String(issueNumber)) fail('REVISE_ISSUE_MISMATCH');
  const command = parseCommand(event.comment.body);
  const labels = new Set((pr.labels || []).map(label => label.name));
  const allowed = roster.members.filter(member => supportedKind(member) && labels.has(`squad:${member.resolved_persistent_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`));
  const selected = command.target ? allowed.filter(member => member.logical_member_id === command.target) : allowed;
  if (!selected.length || command.target && selected.length !== 1) fail('REVISE_TARGET_NOT_ASSIGNED');
  if (!/^[a-f0-9]{40}$/.test(pr.head.sha) || !/^[a-f0-9]{40}$/.test(pr.base.sha)) fail('REVISE_SHA_INVALID');
  return { schema: 1, repository: env.GITHUB_REPOSITORY, issue_number: issueNumber, pr_number: pr.number, branch: pr.head.ref,
    head_sha: pr.head.sha, main_sha: pr.base.sha, run_id: env.GITHUB_RUN_ID, comment_id: event.comment.id, ...command, allowed_members: selected.map(member => member.logical_member_id) };
}
function git(repo, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-C', repo, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, shell: false });
  if (result.error || result.status !== 0) fail('REVISE_GIT_FAILED');
  return result.stdout;
}
function requireCurrentMain(repo, main, head) {
  try { git(repo, ['merge-base', '--is-ancestor', main, head]); }
  catch { fail('REVISE_MAIN_NOT_INCLUDED: Merge current main into the PR branch, resolve conflicts manually, then comment /squad revise again. No automatic conflict resolution.'); }
}
function readContext(file, repository, issueNumber) {
  const ctx = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (ctx.schema !== 1 || ctx.repository !== repository || ctx.issue_number !== Number(issueNumber) || !BRANCH.test(ctx.branch) || Number(BRANCH.exec(ctx.branch)[1]) !== ctx.issue_number || !/^[a-f0-9]{40}$/.test(ctx.head_sha) || !/^[a-f0-9]{40}$/.test(ctx.main_sha) || !Array.isArray(ctx.allowed_members) || !ctx.allowed_members.length) fail('REVISE_CONTEXT_INVALID');
  return ctx;
}
function validateActionsRevise(env, root = env.GITHUB_WORKSPACE || path.resolve(__dirname, '..')) {
  if (env.GITHUB_EVENT_NAME !== 'issue_comment' || env.GITHUB_REF !== 'refs/heads/main' ||
      env.SQUAD_REVISE_VALIDATED !== 'true' || env.SQUAD_ISSUE_FLOW_OPT_IN !== '1') fail('REVISE_ACTIONS_GATE_REQUIRED');
  const ctx = readContext(path.join(root, '.squad-issue', 'revise.json'), env.GITHUB_REPOSITORY, env.SQUAD_ISSUE_NUMBER);
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  // Replay the gate validator against its captured PR metadata and the original Actions event.
  const validated = validateRequest(event, ctx.request_pull, env, loadRoster(root));
  if (!env.GITHUB_RUN_ID || ctx.run_id !== env.GITHUB_RUN_ID || ctx.main_sha !== env.GITHUB_SHA) fail('REVISE_ACTIONS_RUN_MISMATCH');
  for (const key of ['repository', 'issue_number', 'pr_number', 'branch', 'head_sha', 'run_id', 'comment_id', 'target', 'instructions', 'allowed_members']) {
    if (JSON.stringify(ctx[key]) !== JSON.stringify(validated[key])) fail('REVISE_ACTIONS_CAPTURE_MISMATCH');
  }
  return ctx;
}
function validateBaseline(repo, ctx) {
  requireCurrentMain(repo, ctx.main_sha, ctx.head_sha);
  const rows = git(repo, ['diff', '--raw', '--no-renames', ctx.main_sha, ctx.head_sha]).trim().split('\n').filter(Boolean);
  const config = loadConfig(repo);
  const roster = loadRoster(repo);
  const allowedMembers = roster.members.filter(member => ctx.allowed_members.includes(member.logical_member_id));
  for (const row of rows) {
    const match = /^:(\d+) (\d+) [a-f0-9]+ [a-f0-9]+ [AMD]\t(.+)$/.exec(row);
    const relative = match?.[3];
    const allowed = relative && !isDeniedPath(relative, repo) && allowedMembers.some(member => memberPaths(member, config).some(pattern => globToRegExp(pattern).test(relative)));
    if (!match || !['000000', '100644', '100755'].includes(match[1]) || !['000000', '100644', '100755'].includes(match[2]) || !allowed) fail('REVISE_BASELINE_SCOPE_REJECTED');
  }
}
function validateSelections(ctx, selections) {
  if (selections.some(selection => !ctx.allowed_members.includes(selection.member.logical_member_id)) || ctx.target && selections.length !== 1) fail('REVISE_ROUTE_REJECTED');
}
function assertHeadUnchanged(actual, expected, published) {
  if (actual === published) return 'existing';
  if (actual !== expected) fail('REVISE_BRANCH_HEAD_MOVED');
  return 'push';
}
async function transitionLabels(github, repository, numbers, success, revising = false) {
  const terminal = revising ? 'sandbox:revising' : success ? 'sandbox:ready' : 'sandbox:failed';
  await ensureLabel(github, repository, { name: terminal, color: success ? '0E8A16' : 'B60205', description: 'Sandbox execution lifecycle' });
  for (const number of new Set(numbers)) {
    const issue = { ...repository, issue_number: number };
    await github.rest.issues.addLabels({ ...issue, labels: [terminal] });
    for (const name of ['sandbox:queued', 'sandbox:processing', 'sandbox:ready', 'sandbox:failed', 'sandbox:revising'].filter(name => name !== terminal)) {
      try { await github.rest.issues.removeLabel({ ...issue, name }); } catch (error) { if (error.status !== 404) throw error; }
    }
  }
}
async function conflictHints({ github, context, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const pulls = await github.paginate(github.rest.pulls.list, { ...context.repo, state: 'open', base: 'main', per_page: 100 });
  for (const pull of pulls.filter(pr => ownedPull(pr, `${context.repo.owner}/${context.repo.repo}`))) {
    let { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: pull.number });
    for (let attempt = 0; pr.mergeable === null && attempt < 2; attempt++) {
      await sleep(1000);
      ({ data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: pull.number }));
    }
    if (pr.mergeable !== false) continue;
    const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: pr.number, per_page: 100 });
    if (!comments.some(comment => comment.user?.type === 'Bot' && comment.body?.includes(HINT))) await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body: `${HINT}\nThis sandbox PR conflicts with main. Merge current main into this branch and resolve conflicts, then ask a trusted maintainer to comment \`/squad revise <instructions>\`.` });
  }
}
async function prepare({ github, context, root, env = process.env }) {
  const out = path.join(root, '.squad-issue'); fs.mkdirSync(out, { recursive: true });
  let event = context.payload, revise = null;
  if (context.eventName === 'issue_comment') {
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: event.issue.number });
    revise = { ...validateRequest(event, pr, env, loadRoster(root)), request_pull: pr };
    const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: pr.number, per_page: 100 });
    if (comments.some(comment => comment.user?.type === 'Bot' && comment.body?.includes(`<!-- squad-revise:${env.GITHUB_RUN_ID} -->`))) {
      await transitionLabels(github, context.repo, [revise.issue_number, revise.pr_number], true);
      fs.appendFileSync(env.GITHUB_OUTPUT, 'already_published=true\n'); return;
    }
    const capturedFile = path.join(out, 'revise.json');
    if (env.GITHUB_RUN_ATTEMPT !== '1' && !fs.existsSync(capturedFile)) fail('REVISE_CAPTURE_MISSING: Original run artifact unavailable; inspect the PR and post a new revise comment.');
    if (fs.existsSync(capturedFile)) {
      const captured = readContext(capturedFile, env.GITHUB_REPOSITORY, revise.issue_number);
      if (captured.run_id !== env.GITHUB_RUN_ID || captured.comment_id !== revise.comment_id) fail('REVISE_CAPTURE_MISMATCH');
      if (pr.head.sha !== captured.head_sha) fail('REVISE_BRANCH_HEAD_MOVED: Inspect the PR before posting a new revise comment.');
      revise = captured;
    }
    const { data: main } = await github.rest.repos.getCommit({ ...context.repo, ref: 'main' });
    if (!fs.existsSync(capturedFile)) revise.main_sha = main.sha;
    if (main.sha !== env.GITHUB_SHA) fail('REVISE_MAIN_MOVED: Post a new revise comment against current main.');
    const { data: diff } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number, mediaType: { format: 'diff' } });
    if (typeof diff !== 'string' || Buffer.byteLength(diff) > 1024 * 1024) fail('REVISE_DIFF_TOO_LARGE');
    if (!fs.existsSync(capturedFile)) revise.diff = diff;
    const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: revise.issue_number });
    event = { action: 'labeled', label: { name: 'squad' }, repository: { full_name: env.GITHUB_REPOSITORY }, issue, sender: context.payload.comment.user };
    evaluateEvent(event, env, { requireOptIn: true });
    fs.writeFileSync(path.join(out, 'revise.json'), JSON.stringify(revise));
  } else evaluateEvent(event, env, { requireOptIn: true });
  fs.writeFileSync(path.join(out, 'event.json'), JSON.stringify(event));
  fs.appendFileSync(env.GITHUB_OUTPUT, `issue_number=${event.issue.number}\nrevise=${Boolean(revise)}\n`);
}
function hydrate(root, file, env = process.env) {
  const ctx = readContext(file, env.GITHUB_REPOSITORY, env.SQUAD_ISSUE_NUMBER);
  const token = env.SQUAD_FETCH_TOKEN;
  const fetch = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, 'fetch', '--no-tags', 'origin', ctx.head_sha, '+refs/heads/main:refs/remotes/origin/main'], {
    encoding: 'utf8', shell: false, env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` }
  });
  if (fetch.error || fetch.status !== 0) fail('REVISE_FETCH_FAILED');
  requireCurrentMain(root, git(root, ['rev-parse', 'refs/remotes/origin/main']).trim(), ctx.head_sha);
  validateBaseline(root, ctx);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n.squad-issue/\n');
  if (env.SQUAD_REVISE_POSTPROCESS === 'true') {
    const patch = git(root, ['diff', '--binary', '--full-index', ctx.main_sha, ctx.head_sha]);
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, 'apply', '--index', '--whitespace=nowarn', '-'], { input: patch, encoding: 'utf8' });
    if (result.error || result.status !== 0) fail('REVISE_POSTPROCESS_BASELINE_FAILED');
  }
  return ctx;
}
if (require.main === module) {
  try { hydrate(process.cwd(), process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateActionsRevise, validateSelections, hydrate, BRANCH, HINT, parseCommand, ownedPull, validateRequest, readContext, validateBaseline, requireCurrentMain, assertHeadUnchanged, transitionLabels, conflictHints, prepare, git };
