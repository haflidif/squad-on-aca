const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { validateContract } = require('../contracts/aca-sandbox/v1/tools/validate');
const { assertIssueBinding, issueNumber: parseIssueNumber } = require('./lib/issue-binding');
const { validateChangedPaths } = require('../contracts/aca-sandbox/v1/tools/path-scope');
const { readJson, writeJson, sha256File, sha256Bytes, safeName, redact, containsToken, buildSafeChildEnv } = require('./lib/util');
const { hardenedGitArgs, hardenedVerificationEnv, verificationGitCommand } = require('./lib/hardened-git');

const BOT_NAME = 'squad-aca-bot[bot]';
const BOT_EMAIL = '3362344+squad-aca-bot[bot]@users.noreply.github.com';
const LIFECYCLE_LABELS = ['squad:processing', 'squad:queued', 'squad:revising'];
const PUBLISH_ALLOWED_GIT = new Set(['rev-parse', 'fetch', 'merge-base', 'ls-remote', 'read-tree', 'apply', 'write-tree', 'commit-tree', 'push', 'diff', 'diff-tree', 'cat-file']);
const TOKEN_PATTERN = /github_pat_[A-Za-z0-9_]+|gh[opsur]_[A-Za-z0-9_]+|ghp_[A-Za-z0-9_]+|ghs_[A-Za-z0-9_]+|gho_[A-Za-z0-9_]+/;
const DEFAULT_GIT_HOST = 'github.com';
const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const STRIPPED_FORMATTING_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g;
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;
const MAX_GITHUB_ERROR_BYTES = 2048;
const GITHUB_REQUEST_TIMEOUT_MS = 30000;
const GITHUB_COMMENT_PAGE_SIZE = 100;
const MAX_GITHUB_COMMENT_PAGES = 100;
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;

function stripControls(value) {
  return String(value ?? '').replace(STRIPPED_FORMATTING_PATTERN, '');
}
function cap(value, max) {
  const text = stripControls(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function neutralizeMentionsAndRefs(value) {
  return String(value).replace(/@([A-Za-z0-9][A-Za-z0-9-]{0,38})(\/[A-Za-z0-9][A-Za-z0-9-]{0,38})?/g, '@\u200d$1$2').replace(/(^|\s)#(\d+)/g, '$1#\u200d$2');
}
function escapeMarkdown(value, max = 4096) {
  const text = neutralizeMentionsAndRefs(cap(value, max));
  return text.replace(/[\\`*_{}\[\]()<>#+\-.!|]/g, '\\$&');
}
function assertNoTokenPatterns(text, label) {
  if (TOKEN_PATTERN.test(String(text ?? ''))) throw new Error(`refusing to publish ${label}: token-looking pattern detected`);
}
function sanitizeUntrusted(value, label, max = 4096) {
  assertNoTokenPatterns(value, label);
  return escapeMarkdown(value, max);
}
function sanitizeTitle(value, label, max = 100) {
  assertNoTokenPatterns(value, label);
  return neutralizeMentionsAndRefs(cap(value, max)).replace(/\s+/g, ' ').trim();
}
function slug(value, max = 32) {
  return safeName(stripControls(value).toLowerCase()).replace(/[._]+/g, '-').slice(0, max).replace(/^-+|-+$/g, '') || 'issue';
}
function outputDirForSummary(summaryPath) { return path.dirname(path.resolve(summaryPath)); }
function integrationManifestPath(summaryPath) { return path.join(outputDirForSummary(summaryPath), 'integration', 'artifact-manifest.json'); }
function integratedPatchPath(summaryPath, summary) { return path.join(outputDirForSummary(summaryPath), ...summary.integration.integrated_patch_path.split('/')); }
function assertAllowedGit(args) {
  const command = verificationGitCommand(args);
  if (!PUBLISH_ALLOWED_GIT.has(command)) throw new Error(`publish git command is not allowed: ${command || args.join(' ')}`);
  if (command === 'apply' && !args.includes('--cached')) throw new Error('publish git apply must use --cached');
  if (command === 'read-tree' && args.some(arg => arg === '-u' || arg === '--reset' || arg === '-m')) throw new Error('publish git read-tree must not update a worktree or merge trees');
  if (command === 'push' && args.some(arg => arg === '--force' || arg === '-f' || (String(arg).startsWith('--force') && !/^--force-with-lease=refs\/heads\/[^:]+:$/.test(String(arg))))) throw new Error('publish git push must not force');
}
function assertFreshPrivateDirectory(dir, label) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const entries = fs.readdirSync(dir);
  if (entries.length) throw new Error(`${label} must be empty`);
  try { fs.chmodSync(dir, 0o700); } catch {}
}
function createGitContext(repoPath, workDir, config = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(workDir, 'run-'));
  assertFreshPrivateDirectory(runDir, 'publish git run directory');
  const homeDir = path.join(runDir, 'home');
  const hooksDir = path.join(runDir, 'hooks');
  fs.mkdirSync(homeDir, { mode: 0o700 });
  fs.mkdirSync(hooksDir, { mode: 0o700 });
  assertFreshPrivateDirectory(homeDir, 'publish git HOME directory');
  assertFreshPrivateDirectory(hooksDir, 'publish git hooks directory');
  const globalConfig = path.join(runDir, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '', { mode: 0o600 });
  const globalStat = fs.lstatSync(globalConfig);
  if (!globalStat.isFile() || globalStat.isSymbolicLink()) throw new Error('publish git global config must be a real file');
  const ctx = {
    cwd: repoPath,
    runDir,
    homeDir,
    hooksDir,
    globalConfig,
    secretEnvKeys: config.secretEnvKeys || [],
    onGitSpawn: config.onGitSpawn
  };
  return ctx;
}
function cleanupGitContext(ctx) {
  if (ctx?.runDir) fs.rmSync(ctx.runDir, { recursive: true, force: true });
}
function runGit(ctx, args, options = {}) {
  assertAllowedGit(args);
  const gitArgs = hardenedGitArgs(ctx, args);
  const env = options.env || hardenedVerificationEnv(ctx, options.extraEnv || {});
  if (typeof ctx.onGitSpawn === 'function') ctx.onGitSpawn({ args: [...gitArgs], env: { ...env } });
  return new Promise(resolve => {
    const child = spawn('git', gitArgs, { cwd: options.cwd || ctx.cwd, env: buildSafeChildEnv(env, { secretEnvKeys: ctx.secretEnvKeys }), shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => resolve({ exitCode: 127, stdout, stderr: error.message }));
    child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  }).then(result => {
    if (result.exitCode !== 0 && options.check !== false) {
      const message = redact(`git ${args.join(' ')} failed with ${result.exitCode}\n${result.stderr || result.stdout}`, options.token);
      throw new Error(message);
    }
    return result;
  });
}
async function gitText(ctx, args, options = {}) { return (await runGit(ctx, args, options)).stdout.trim(); }
function validateRepoFullName(repoFullName) {
  const value = String(repoFullName || '');
  if (!REPO_FULL_NAME_PATTERN.test(value) || value.includes('..') || value.endsWith('.git')) {
    throw new Error('--repo-full-name must match owner/repo, must not contain .., and must not end with .git');
  }
  const [owner, repo] = value.split('/');
  return { owner, repo, repoFullName: value };
}
function configuredGitHost(options = {}) {
  const host = String(options.gitHost || DEFAULT_GIT_HOST).toLowerCase();
  const allowed = new Set([DEFAULT_GIT_HOST, ...(options.allowedGitHosts || [])].map(item => String(item).toLowerCase()));
  if (!allowed.has(host)) throw new Error(`git host ${host} is not in the publisher allowlist`);
  return host;
}
function buildRepositoryUrl({ repoFullName, gitHost }) {
  const { owner, repo } = validateRepoFullName(repoFullName);
  return `https://${gitHost}/${owner}/${repo}.git`;
}
function gitConfigEnv(ctx, entries, extra = {}) {
  const env = {};
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = String(value);
  });
  env.GIT_CONFIG_COUNT = String(entries.length);
  return hardenedVerificationEnv(ctx, { ...env, ...extra });
}
function authGitEnv(ctx, repoUrl, token, extraEntries = []) {
  const entries = [
    [`http.${repoUrl}.extraheader`, `AUTHORIZATION: bearer ${token}`],
    ['http.followRedirects', 'false'],
    ['credential.helper', ''],
    ...extraEntries
  ];
  return gitConfigEnv(ctx, entries);
}
function localGitRewriteEntries(repoUrl, localBaseUrl) {
  if (!localBaseUrl) return [];
  return [[`url.${localBaseUrl}.insteadOf`, repoUrl.replace(/\/[^/]+\/[^/]+\.git$/, '/')]];
}
async function defaultBranch(ctx, remoteUrl, env) {
  const out = await gitText(ctx, ['ls-remote', '--symref', remoteUrl, 'HEAD'], { env });
  const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m.exec(out);
  return match ? match[1] : 'main';
}
async function remoteBranchCommit(ctx, remoteUrl, branch, env) {
  const out = await gitText(ctx, ['ls-remote', '--heads', remoteUrl, branch], { env });
  const first = out.split(/\r?\n/).find(Boolean);
  return first ? first.split(/\s+/)[0] : '';
}
async function fetchRemoteBranch(ctx, remoteUrl, branch, env) {
  const ref = `refs/publish-check/${safeName(branch)}-${crypto.createHash('sha256').update(branch).digest('hex').slice(0, 12)}`;
  await runGit(ctx, ['fetch', '--no-tags', remoteUrl, `refs/heads/${branch}:${ref}`], { env });
  const sha = await gitText(ctx, ['rev-parse', ref]);
  return { ref, sha };
}
async function verifyPublishedBranchContent(ctx, { ref, expectedTree, baselineSha, label }) {
  const tree = await gitText(ctx, ['rev-parse', `${ref}^{tree}`]);
  const parents = (await gitText(ctx, ['rev-parse', `${ref}^@`])).split(/\r?\n/).filter(Boolean);
  if (tree !== expectedTree || parents.length !== 1 || parents[0] !== baselineSha) {
    throw new Error(`${label} does not match verified publish content: expected tree ${expectedTree} with parent ${baselineSha}, found tree ${tree} with parents ${parents.join(',') || 'none'}`);
  }
  return { tree, parent: parents[0] };
}
async function readCommitObject(ctx, ref) {
  const text = (await runGit(ctx, ['cat-file', '-p', ref])).stdout;
  const splitAt = text.indexOf('\n\n');
  if (splitAt < 0) throw new Error(`commit ${ref} has no message`);
  const headers = text.slice(0, splitAt).split(/\r?\n/);
  const message = text.slice(splitAt + 2);
  const authorLine = headers.find(line => line.startsWith('author ')) || '';
  const committerLine = headers.find(line => line.startsWith('committer ')) || '';
  const parseIdentity = (line, field) => {
    const match = new RegExp(`^${field} (.+) <([^>]+)> \\d+ [+-]\\d+$`).exec(line);
    if (!match) throw new Error(`commit ${ref} has invalid ${field} identity`);
    return { name: match[1], email: match[2] };
  };
  return { message, author: parseIdentity(authorLine, 'author'), committer: parseIdentity(committerLine, 'committer') };
}
async function verifyBranchCommitMetadata(ctx, { ref, expectedMessage, label }) {
  const commit = await readCommitObject(ctx, ref);
  const expected = { name: BOT_NAME, email: BOT_EMAIL };
  if (commit.message !== expectedMessage) {
    throw new Error(`${label} commit message does not match the publisher-generated message`);
  }
  for (const role of ['author', 'committer']) {
    if (commit[role].name !== expected.name || commit[role].email !== expected.email) {
      throw new Error(`${label} ${role} identity ${commit[role].name} <${commit[role].email}> does not match publisher identity ${expected.name} <${expected.email}>`);
    }
  }
}
function pullRequestHeadSha(pr) {
  if (!pr) return '';
  if (typeof pr.head === 'object' && pr.head) return pr.head.sha || '';
  return pr.head_sha || '';
}
function pullRequestHeadRef(pr) {
  if (!pr) return '';
  if (typeof pr.head === 'string') return pr.head;
  if (typeof pr.head === 'object' && pr.head) return pr.head.ref || '';
  return '';
}
async function verifyRemoteBaseline(ctx, remoteUrl, targetBranch, baselineSha, env) {
  const ref = `refs/publish-check/${safeName(targetBranch)}`;
  await runGit(ctx, ['fetch', '--no-tags', remoteUrl, `refs/heads/${targetBranch}:${ref}`], { env });
  const result = await runGit(ctx, ['merge-base', '--is-ancestor', baselineSha, ref], { check: false });
  if (result.exitCode !== 0) throw new Error(`target branch ${targetBranch} does not contain baseline ${baselineSha}`);
  return ref;
}
function parseNul(text) { return String(text || '').split('\0').filter(Boolean); }
function normalizeRepoPath(value) { return String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''); }
function pathTouchesGitDir(value) { const p = normalizeRepoPath(value); return p === '.git' || p.startsWith('.git/'); }
function pathTouchesProtected(value) { const p = normalizeRepoPath(value); return p === '.squad' || p.startsWith('.squad/') || p === '.github/workflows' || p.startsWith('.github/workflows/'); }
function parseRawDiff(text) {
  const parts = parseNul(text);
  const entries = [];
  for (let i = 0; i < parts.length;) {
    const meta = parts[i++];
    if (!meta.startsWith(':')) continue;
    const filePath = parts[i++];
    const fields = meta.slice(1).split(' ');
    entries.push({ oldMode: fields[0], newMode: fields[1], status: fields[4] || '', path: filePath });
  }
  return entries;
}
async function indexDelta(ctx, baselineSha, tree, indexFile) {
  const paths = parseNul((await runGit(ctx, ['diff', '--no-renames', '-z', '--name-only', baselineSha, tree], { extraEnv: { GIT_INDEX_FILE: indexFile } })).stdout);
  const entries = parseRawDiff((await runGit(ctx, ['diff-tree', '-r', '--no-renames', '--raw', '-z', baselineSha, tree], { extraEnv: { GIT_INDEX_FILE: indexFile } })).stdout);
  return { paths: [...new Set(paths)], entries };
}
function validateDelta(delta, tasks) {
  const ownedUnion = tasks.flatMap(task => task.owned_paths || []);
  const violations = [];
  const scope = validateChangedPaths(delta.paths, ownedUnion);
  for (const item of scope.violations) violations.push(`outside owned path union: ${JSON.stringify(item)}`);
  for (const rel of delta.paths) {
    if (pathTouchesGitDir(rel)) violations.push(`${rel}: .git paths are not allowed`);
    if (pathTouchesProtected(rel)) violations.push(`${rel}: protected paths are not allowed`);
  }
  for (const entry of delta.entries) {
    if (entry.oldMode === '120000' || entry.newMode === '120000') violations.push(`${entry.path}: symlinks are not allowed`);
    if (entry.oldMode === '160000' || entry.newMode === '160000') violations.push(`${entry.path}: gitlinks are not allowed`);
    const owner = tasks.find(task => validateChangedPaths([entry.path], task.owned_paths || []).violations.length === 0);
    const oldExec = entry.oldMode !== '000000' && entry.oldMode.endsWith('755');
    const newExec = entry.newMode !== '000000' && entry.newMode.endsWith('755');
    if (!oldExec && newExec && owner?.allow_executable_bits !== 'true') violations.push(`${entry.path}: executable mode changes are not allowed`);
  }
  return violations;
}
async function buildCommit(ctx, { baselineSha, patchPath, tasks, executionId, issueNumber, issueTitle, branch, commitDate }) {
  assertNoTokenPatterns(issueTitle, 'issue title');
  for (const task of tasks) {
    assertNoTokenPatterns(task.task_id, 'task id');
    assertNoTokenPatterns(task.owner?.logical_member_id, 'logical member');
    assertNoTokenPatterns(task.owner?.resolved_persistent_name, 'persistent name');
  }
  const indexFile = path.join(ctx.homeDir, 'publish.index');
  fs.rmSync(indexFile, { force: true });
  await runGit(ctx, ['read-tree', `${baselineSha}^{tree}`], { extraEnv: { GIT_INDEX_FILE: indexFile } });
  await runGit(ctx, ['apply', '--cached', patchPath], { extraEnv: { GIT_INDEX_FILE: indexFile } });
  const tree = await gitText(ctx, ['write-tree'], { extraEnv: { GIT_INDEX_FILE: indexFile } });
  const delta = await indexDelta(ctx, baselineSha, tree, indexFile);
  const violations = validateDelta(delta, tasks);
  if (violations.length) throw new Error(`integrated patch violates publisher delta policy: ${violations.join('; ')}`);
  const personas = [...new Map(tasks.map(t => [t.owner.logical_member_id, t.owner])).values()]
    .map(owner => `${owner.logical_member_id} (${owner.resolved_persistent_name})`).sort();
  const subject = `squad: publish issue #${issueNumber} from ${executionId}`;
  const body = [
    subject,
    '',
    `Issue: #${issueNumber} ${stripControls(issueTitle || '')}`,
    `Execution: ${executionId}`,
    `Branch: ${branch}`,
    '',
    'Contributing personas:',
    ...personas.map(item => `- ${stripControls(item)}`),
    '',
    `Squad-Execution-Id: ${executionId}`,
    `Co-authored-by: ${BOT_NAME} <${BOT_EMAIL}>`,
    ''
  ].join('\n');
  const commit = await gitText(ctx, ['commit-tree', tree, '-p', baselineSha], {
    stdin: body,
    extraEnv: {
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: BOT_NAME,
      GIT_AUTHOR_EMAIL: BOT_EMAIL,
      GIT_AUTHOR_DATE: commitDate || '2000-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: BOT_NAME,
      GIT_COMMITTER_EMAIL: BOT_EMAIL,
      GIT_COMMITTER_DATE: commitDate || '2000-01-01T00:00:00Z'
    }
  });
  return { commit, tree, delta, message: body };
}
function branchName({ issueNumber, executionId, issueTitle }) {
  return `squad/aca-sandbox/issue-${issueNumber}-${slug(executionId, 16)}-${slug(issueTitle, 32)}`;
}
function titleForIssue(issueTitle, issueNumber) {
  const base = sanitizeTitle(issueTitle || `Issue ${issueNumber}`, 'issue title', 80);
  return `squad: ${base}`.slice(0, 100);
}
function markdownTable(tasks) {
  const rows = ['| Task ID | Logical member | Persistent name | Owned paths | Status |', '|---|---|---|---|---|'];
  for (const task of tasks) {
    rows.push(`| ${sanitizeUntrusted(task.task_id, 'task id', 80)} | ${sanitizeUntrusted(task.owner.logical_member_id, 'logical member', 80)} | ${sanitizeUntrusted(task.owner.resolved_persistent_name, 'persistent name', 120)} | ${sanitizeUntrusted((task.owned_paths || []).join(', '), 'owned paths', 200)} | ${sanitizeUntrusted(task.status || 'succeeded', 'task status', 40)} |`);
  }
  return rows.join('\n');
}
function prBody({ repoFullName, issueNumber, executionId, baselineSha, patchSha, tasks, checkResults }) {
  const issueLink = repoFullName ? `https://github.com/${repoFullName}/issues/${issueNumber}` : `#${issueNumber}`;
  const checks = (checkResults || []).length
    ? ['| Check | Status | Exit code |', '|---|---|---|', ...(checkResults || []).map(check => `| ${sanitizeUntrusted(check.name, 'check name', 120)} | ${sanitizeUntrusted(check.status, 'check status', 40)} | ${Number.isInteger(check.exit_code) ? check.exit_code : ''} |`)].join('\n')
    : 'No integration checks were configured.';
  const body = `## Squad ACA Sandbox publish\n\nThis draft PR publishes the verified integrated patch for ${issueLink}.\n\n- Execution ID: \`${sanitizeUntrusted(executionId, 'execution id', 120)}\`\n- Baseline SHA: \`${baselineSha}\`\n- Integrated patch SHA-256: \`${patchSha}\`\n\n### Tasks\n\n${markdownTable(tasks)}\n\n### Check results\n\n${checks}\n\nCloses #\u200d${issueNumber}\n`;
  assertNoTokenPatterns(body, 'pull request body');
  return body;
}
function issueComment(prUrl, executionId) {
  const body = `Draft PR opened for ACA Sandbox execution \`${sanitizeUntrusted(executionId, 'execution id', 120)}\`: ${sanitizeUntrusted(prUrl, 'PR URL', 300)}\n\n<!-- squad-aca-publish:${sanitizeTitle(executionId, 'execution id', 120)} -->`;
  assertNoTokenPatterns(body, 'issue comment');
  return body;
}
function issueCommentMarker(executionId) {
  return `<!-- squad-aca-publish:${sanitizeTitle(executionId, 'execution id', 120)} -->`;
}
async function ensurePublishComment(client, { owner, repo, issueNumber, prUrl, executionId }) {
  const marker = issueCommentMarker(executionId);
  if (typeof client.listIssueComments === 'function') {
    for (let page = 1; page <= MAX_GITHUB_COMMENT_PAGES; page += 1) {
      const comments = await client.listIssueComments({ owner, repo, issueNumber, page, perPage: GITHUB_COMMENT_PAGE_SIZE });
      if (!Array.isArray(comments)) throw new Error('GitHub issue comments response must be an array');
      if (comments.some(comment => String(comment.body || comment).includes(marker))) return { created: false };
      if (comments.length < GITHUB_COMMENT_PAGE_SIZE) break;
      if (page === MAX_GITHUB_COMMENT_PAGES) throw new Error(`GitHub issue comments exceeded ${MAX_GITHUB_COMMENT_PAGES} pages`);
    }
  }
  await client.createIssueComment({ owner, repo, issueNumber, body: issueComment(prUrl, executionId) });
  return { created: true };
}
function failedPublishResult({ summary, branch, commitSha, pr }) {
  return {
    schema_version: 'aca-sandbox/v1',
    message_type: 'publish.result',
    run_id: summary.run_id,
    status: 'failed',
    branch,
    commit_sha: commitSha,
    pr_number: pr.number,
    pr_url: pr.html_url,
    idempotency: 'created',
    labels: { added: [], removed: [] }
  };
}
class FakeGitHubClient {
  constructor() { this.prs = []; this.labels = []; this.comments = []; this.commentListPages = []; this.tokenRequests = []; this.token = 'github_pat_fakePublishToken'; this.nextCreatedHeadSha = undefined; this.deleteLabelStatus = new Map(); }
  async createInstallationToken(options) { this.tokenRequests.push(options); return { token: this.token }; }
  async findPullRequestByHead({ head }) { return this.prs.find(pr => pullRequestHeadRef(pr) === head) || null; }
  async createPullRequest({ head, headSha, base, title, body, draft }) { const pr = { number: this.prs.length + 1, html_url: `https://github.example/pr/${this.prs.length + 1}`, head: { ref: head, sha: this.nextCreatedHeadSha ?? headSha }, base, title, body, draft, state: 'open' }; this.prs.push(pr); return pr; }
  async setIssueLabels({ add = [], remove = [] }) {
    for (const label of remove) {
      const status = this.deleteLabelStatus instanceof Map ? this.deleteLabelStatus.get(label) : undefined;
      if (status && status !== 404) {
        const error = new Error(`DELETE ${label} failed with ${status}`);
        error.statusCode = status;
        throw error;
      }
    }
    this.labels.push({ add, remove });
    return { added: add, removed: remove };
  }
  async createIssueComment({ body }) { const comment = { id: this.comments.length + 1, body }; this.comments.push(comment); return comment; }
  async listIssueComments({ page = 1, perPage = GITHUB_COMMENT_PAGE_SIZE } = {}) {
    this.commentListPages.push(page);
    return this.comments.slice((page - 1) * perPage, page * perPage);
  }
}
class RealGitHubClient {
  constructor({ apiBase = 'https://api.github.com', appId, installationId, privateKeyPem, live, maxResponseBytes = MAX_GITHUB_RESPONSE_BYTES, requestTimeoutMs = GITHUB_REQUEST_TIMEOUT_MS }) {
    this.apiBase = apiBase;
    this.appId = appId;
    this.installationId = installationId;
    this.privateKeyPem = privateKeyPem;
    this.live = live;
    this.maxResponseBytes = maxResponseBytes;
    this.requestTimeoutMs = requestTimeoutMs;
    if (!live || process.env.SQUAD_ENABLE_PUBLISH !== '1') throw new Error('Refusing live publish unless --live and SQUAD_ENABLE_PUBLISH=1 are set.');
  }
  jwt() {
    const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: String(this.appId) })}`;
    const sig = crypto.createSign('RSA-SHA256').update(body).sign(this.privateKeyPem).toString('base64url');
    return `${body}.${sig}`;
  }
  request(method, pathname, body, token) {
    const url = new URL(pathname, this.apiBase);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { 'User-Agent': 'squad-aca-publisher', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finishReject = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = https.request(url, { method, headers }, res => {
        const chunks = [];
        let total = 0;
        res.on('data', c => {
          total += c.length;
          if (total > this.maxResponseBytes) {
            finishReject(new Error(`GitHub API ${method} ${pathname} response exceeded ${this.maxResponseBytes} bytes`));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            finishReject(new Error(`GitHub API ${method} ${pathname} returned invalid JSON`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const safeBody = cap(redact(data, token), MAX_GITHUB_ERROR_BYTES);
            const error = new Error(`GitHub API ${method} ${pathname} failed with ${res.statusCode}: ${safeBody}`);
            error.statusCode = res.statusCode;
            finishReject(error);
          } else {
            settled = true;
            resolve(parsed);
          }
        });
      });
      req.setTimeout(this.requestTimeoutMs, () => {
        finishReject(new Error(`GitHub API ${method} ${pathname} timed out after ${this.requestTimeoutMs}ms`));
        req.destroy();
      });
      req.on('error', error => finishReject(new Error(`GitHub API ${method} ${pathname} request failed: ${cap(redact(error.message, token), 300)}`)));
      if (payload) req.end(payload); else req.end();
    });
  }
  async createInstallationToken({ owner, repo }) {
    const body = { repositories: [repo], permissions: { contents: 'write', pull_requests: 'write', issues: 'write' } };
    const token = this.jwt();
    const result = await this.request('POST', `/app/installations/${this.installationId}/access_tokens`, body, token);
    return { token: result.token };
  }
  async findPullRequestByHead({ owner, repo, head }) {
    const pulls = await this.request('GET', `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}`, undefined, this.token);
    return pulls[0] || null;
  }
  async createPullRequest({ owner, repo, head, base, title, body, draft }) { return this.request('POST', `/repos/${owner}/${repo}/pulls`, { head, base, title, body, draft }, this.token); }
  async setIssueLabels({ owner, repo, issueNumber, add = [], remove = [] }) {
    for (const label of add) await this.request('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { labels: [label] }, this.token);
    for (const label of remove) {
      await this.request('DELETE', `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, undefined, this.token).catch(error => {
        if (error.statusCode === 404) return {};
        throw error;
      });
    }
    return { added: add, removed: remove };
  }
  async createIssueComment({ owner, repo, issueNumber, body }) { return this.request('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body }, this.token); }
  async listIssueComments({ owner, repo, issueNumber, page = 1, perPage = GITHUB_COMMENT_PAGE_SIZE }) {
    if (!Number.isInteger(page) || page < 1 || page > MAX_GITHUB_COMMENT_PAGES) throw new Error('GitHub issue comments page is outside the allowed range');
    if (!Number.isInteger(perPage) || perPage !== GITHUB_COMMENT_PAGE_SIZE) throw new Error('GitHub issue comments page size is invalid');
    return this.request('GET', `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`, undefined, this.token);
  }
}
function readPemFromEnv() {
  const keyPath = process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH || process.env.GITHUB_APP_PRIVATE_KEY_PATH || '';
  delete process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH;
  delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!keyPath) throw new Error('SQUAD_GITHUB_APP_PRIVATE_KEY_PATH is required for live publish in v1. Key Vault retrieval is deferred to workflow wiring.');
  const stat = fs.lstatSync(keyPath);
  if (stat.isSymbolicLink()) throw new Error('GitHub App private key path must not be a symlink');
  if (!stat.isFile()) throw new Error('GitHub App private key path must be a regular file');
  if (stat.size > MAX_PRIVATE_KEY_BYTES) throw new Error(`GitHub App private key exceeds ${MAX_PRIVATE_KEY_BYTES} bytes`);
  const pem = fs.readFileSync(keyPath, 'utf8');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) throw new Error('GitHub App private key file is not a PEM private key');
  try {
    crypto.createPrivateKey(pem);
  } catch {
    throw new Error('GitHub App private key file is not a valid private key');
  }
  return pem;
}
async function runPublish(options) {
  const summaryPath = path.resolve(options.summaryPath || options.summary);
  const repoPath = path.resolve(options.repoPath || options.repo || process.cwd());
  const outPath = path.resolve(options.outPath || options.out || path.join(outputDirForSummary(summaryPath), 'publish-result.json'));
  if (options.update) throw new Error('--update is refused in publish v1');
  const summary = readJson(summaryPath);
  const validation = validateContract('dispatcher-summary.schema.json', summary);
  if (!validation.valid) throw new Error(`dispatcher summary is invalid: ${validation.errors.join('; ')}`);
  if (summary.status !== 'succeeded') throw new Error('dispatcher summary status must be succeeded');
  if (!summary.integration || summary.integration.status !== 'succeeded') throw new Error('dispatcher integration status must be succeeded');
  const manifest = readJson(integrationManifestPath(summaryPath));
  const manifestValidation = validateContract('artifact-manifest.schema.json', manifest);
  if (!manifestValidation.valid) throw new Error(`integration artifact manifest is invalid: ${manifestValidation.errors.join('; ')}`);
  if (manifest.task_id !== 'integration') throw new Error('integration artifact manifest task_id must be integration');
  if (manifest.run_id !== summary.run_id) throw new Error('integration artifact manifest run_id does not match dispatcher summary');
  if (summary.baseline_sha && manifest.baseline_sha.toLowerCase() !== summary.baseline_sha.toLowerCase()) {
    throw new Error('integration artifact manifest baseline_sha does not match dispatcher summary');
  }
  const patchPath = integratedPatchPath(summaryPath, summary);
  const patchSha = sha256File(patchPath);
  if (patchSha !== summary.integration.sha256.toLowerCase()) throw new Error('integrated patch sha256 does not match dispatcher summary');
  const patchArtifact = manifest.artifacts.find(a => a.kind === 'patch');
  if (!patchArtifact || patchArtifact.sha256.toLowerCase() !== patchSha) throw new Error('integrated patch sha256 does not match artifact manifest');
  if (!patchArtifact || `integration/${patchArtifact.path}` !== summary.integration.integrated_patch_path.replace(/\\/g, '/')) {
    throw new Error('integrated patch path does not match the integration artifact manifest');
  }
  const baselineSha = manifest.baseline_sha;
  if (!baselineSha) throw new Error('baseline sha is required in the integration artifact manifest');
  if (options.baselineSha && options.baselineSha.toLowerCase() !== baselineSha.toLowerCase()) {
    throw new Error('--baseline-sha does not match the integration artifact manifest');
  }
  if (options.live && !options.planPath) throw new Error('Live publication requires a validated execution plan with an issue binding.');
  const plan = options.planPath ? readJson(path.resolve(options.planPath)) : null;
  const planTasks = plan ? plan.tasks : (summary.execution_tasks || options.tasks || []);
  if (!Array.isArray(planTasks) || !planTasks.length) throw new Error('publisher requires plan tasks via --plan or dispatcher summary execution_tasks');
  const issueNumber = parseIssueNumber(options.issueNumber ?? summary.issue?.number);
  const issueTitle = options.issueTitle || summary.issue?.title || `Issue ${issueNumber}`;
  const repoFullName = options.repoFullName || summary.repository || '';
  const { owner, repo } = validateRepoFullName(repoFullName);
  if (options.live && process.env.GITHUB_REPOSITORY && repoFullName !== process.env.GITHUB_REPOSITORY) {
    throw new Error('Live publication repository does not match the workflow repository.');
  }
  if (plan) {
    if (plan.run_id !== summary.run_id ||
        manifest.run_id !== plan.run_id ||
        plan.baseline_sha.toLowerCase() !== baselineSha.toLowerCase() ||
        manifest.baseline_sha.toLowerCase() !== plan.baseline_sha.toLowerCase()) {
      throw new Error('Execution plan run_id or baseline_sha does not match dispatcher output.');
    }
    const manifestPlanValidation = validateContract('artifact-manifest.schema.json', manifest, plan);
    if (!manifestPlanValidation.valid) throw new Error(`integration artifact manifest does not match execution plan: ${manifestPlanValidation.errors.join('; ')}`);
    assertIssueBinding(plan, repoFullName, issueNumber, Boolean(options.live));
  }
  const gitHost = configuredGitHost(options);
  const repoUrl = buildRepositoryUrl({ repoFullName, gitHost });
  const workDir = path.join(path.dirname(outPath), '.publish-work');
  const ctx = createGitContext(repoPath, workDir, { onGitSpawn: options.onGitSpawn, secretEnvKeys: ['SQUAD_GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_PRIVATE_KEY_PATH'] });
  try {
    const branch = branchName({ issueNumber, executionId: summary.run_id, issueTitle });
    let client = options.githubClient;
    if (!client) client = options.live ? new RealGitHubClient({ appId: process.env.GITHUB_APP_ID, installationId: process.env.GITHUB_APP_INSTALLATION_ID, privateKeyPem: readPemFromEnv(), live: true }) : new FakeGitHubClient();
    const tokenResult = await client.createInstallationToken({ owner, repo, permissions: { contents: 'write', pull_requests: 'write', issues: 'write' } });
    const token = tokenResult.token || '';
    client.token = token;
    if (!token) throw new Error('installation token was empty');
    delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; delete process.env.GITHUB_PAT; delete process.env.GITHUB_APP_PRIVATE_KEY_PATH; delete process.env.SQUAD_GITHUB_APP_PRIVATE_KEY_PATH;
    const rewriteEntries = localGitRewriteEntries(repoUrl, options.gitRewriteBaseUrl);
    const remoteEnv = authGitEnv(ctx, repoUrl, token, rewriteEntries);
    const targetBranch = options.targetBranch || summary.target_branch || await defaultBranch(ctx, repoUrl, remoteEnv);
    await verifyRemoteBaseline(ctx, repoUrl, targetBranch, baselineSha, remoteEnv);
    const commitInfo = await buildCommit(ctx, { baselineSha, patchPath, tasks: planTasks, executionId: summary.run_id, issueNumber, issueTitle, branch, commitDate: summary.ended_at || summary.started_at });
    const existingPr = await client.findPullRequestByHead({ owner, repo, head: branch, state: 'all' });
    if (existingPr) {
      if (existingPr.state && existingPr.state !== 'open') throw new Error(`publish branch ${branch} already has a ${existingPr.merged_at ? 'merged' : 'closed'} pull request; refusing to push or create another PR`);
      const current = await remoteBranchCommit(ctx, repoUrl, branch, remoteEnv);
      if (!current) throw new Error(`publish branch ${branch} has an open pull request but no remote branch; refusing to reuse`);
      const prHeadSha = pullRequestHeadSha(existingPr);
      if (!prHeadSha) throw new Error(`publish branch ${branch} open pull request has no head sha; refusing to reuse`);
      if (prHeadSha !== current) throw new Error(`publish branch ${branch} open pull request head ${prHeadSha} does not match remote branch ${current}; refusing to reuse`);
      const fetched = await fetchRemoteBranch(ctx, repoUrl, branch, remoteEnv);
      if (fetched.sha !== current) throw new Error(`publish branch ${branch} changed while verifying; refusing to reuse`);
      await verifyPublishedBranchContent(ctx, { ref: fetched.ref, expectedTree: commitInfo.tree, baselineSha, label: `open pull request branch ${branch}` });
      const labels = await client.setIssueLabels({ owner, repo, issueNumber, remove: ['squad:processing'], add: ['squad:queued'] });
      await ensurePublishComment(client, { owner, repo, issueNumber, prUrl: existingPr.html_url, executionId: summary.run_id });
      const existing = { schema_version: 'aca-sandbox/v1', message_type: 'publish.result', run_id: summary.run_id, status: 'succeeded', branch, commit_sha: current, pr_number: existingPr.number, pr_url: existingPr.html_url, idempotency: 'existing', labels };
      writeJson(outPath, existing);
      return { result: existing, resultPath: outPath };
    }
    const currentRemote = await remoteBranchCommit(ctx, repoUrl, branch, remoteEnv);
    let publishedCommit = commitInfo.commit;
    if (currentRemote) {
      const fetched = await fetchRemoteBranch(ctx, repoUrl, branch, remoteEnv);
      if (fetched.sha !== currentRemote) throw new Error(`publish branch ${branch} changed while verifying; refusing to create PR`);
      await verifyPublishedBranchContent(ctx, { ref: fetched.ref, expectedTree: commitInfo.tree, baselineSha, label: `existing remote branch ${branch}` });
      await verifyBranchCommitMetadata(ctx, { ref: fetched.ref, expectedMessage: commitInfo.message, label: `existing remote branch ${branch}` });
      publishedCommit = currentRemote;
    } else {
      const pushEnv = authGitEnv(ctx, repoUrl, token, rewriteEntries);
      await runGit(ctx, ['push', `--force-with-lease=refs/heads/${branch}:`, repoUrl, `${commitInfo.commit}:refs/heads/${branch}`], { env: pushEnv, token });
    }
    const body = prBody({ repoFullName, issueNumber, executionId: summary.run_id, baselineSha, patchSha, tasks: planTasks.map(t => ({ ...t, status: summary.tasks.find(s => s.task_id === t.task_id)?.status || 'succeeded' })), checkResults: summary.integration.check_results });
    const pr = await client.createPullRequest({ owner, repo, head: branch, headSha: publishedCommit, base: targetBranch, title: titleForIssue(issueTitle, issueNumber), body, draft: true });
    const prHeadSha = pullRequestHeadSha(pr);
    if (prHeadSha !== publishedCommit) {
      const failed = failedPublishResult({ summary, branch, commitSha: publishedCommit, pr });
      writeJson(outPath, failed);
      throw new Error(`created pull request head ${prHeadSha || 'missing'} does not match published commit ${publishedCommit}; refusing to mark publish successful`);
    }
    const labels = await client.setIssueLabels({ owner, repo, issueNumber, remove: ['squad:processing'], add: ['squad:queued'] });
    await ensurePublishComment(client, { owner, repo, issueNumber, prUrl: pr.html_url, executionId: summary.run_id });
    const result = { schema_version: 'aca-sandbox/v1', message_type: 'publish.result', run_id: summary.run_id, status: 'succeeded', branch, commit_sha: publishedCommit, pr_number: pr.number, pr_url: pr.html_url, idempotency: 'created', labels };
    const resultValidation = validateContract('publish-result.schema.json', result);
    if (!resultValidation.valid) throw new Error(`internal publish result validation failed: ${resultValidation.errors.join('; ')}`);
    writeJson(outPath, result);
    if (containsToken(JSON.stringify(result), token)) throw new Error('credential material detected in publish output');
    return { result, resultPath: outPath };
  } finally {
    cleanupGitContext(ctx);
  }
}
module.exports = { runPublish, FakeGitHubClient, RealGitHubClient, sanitizeUntrusted, branchName, prBody, readPemFromEnv, LIFECYCLE_LABELS };
