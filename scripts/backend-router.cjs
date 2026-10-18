'use strict';
const fs = require('node:fs');
const path = require('node:path');
const PROVIDERS = { jobs: 'aca-job', sandbox: 'aca-sandbox' };
const MARKER = '<!-- squad-route:v1 -->';
const CLAIM = '<!-- squad-route-request:v1 -->';
const BOT = 'github-actions[bot]';
const LIFECYCLE = new Set(['squad:processing', 'squad:queued', 'squad:ready', 'squad:failed', 'squad:revising']);
function fail(message) { throw new Error(`ROUTE_REJECTED ${message}`); }
function validate(value, schema) {
  if (schema === false) fail('CONFIG_FIELD_NOT_ALLOWED');
  if (schema === true) return;
  if (schema.type) {
    const valid = schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'array' ? Array.isArray(value) : schema.type === 'integer' ? Number.isInteger(value) : typeof value === schema.type;
    if (!valid) fail('CONFIG_TYPE_INVALID');
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const || schema.enum && !schema.enum.includes(value)) fail('CONFIG_VALUE_INVALID');
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(candidate => { try { validate(value, candidate); return true; } catch { return false; } });
    if (matches.length !== 1) fail('CONFIG_VARIANT_INVALID');
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`CONFIG_REQUIRED_${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validate(child, schema.properties[key]);
      else if (schema.additionalProperties === false) fail('CONFIG_UNKNOWN_FIELD');
    }
  }
  if (typeof value === 'string' && (schema.pattern && !new RegExp(schema.pattern).test(value) || schema.minLength && value.length < schema.minLength)) fail('CONFIG_STRING_INVALID');
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) fail('CONFIG_NUMBER_INVALID');
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems || schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('CONFIG_ARRAY_INVALID');
    if (schema.items) value.forEach(item => validate(item, schema.items));
  }
}
function schema(name) { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'backend', 'v1', 'schemas', `${name}.schema.json`), 'utf8')); }
function selectBackend(setting, descriptor) {
  if (setting && Object.hasOwn(setting, 'backend') && !['jobs', 'sandbox'].includes(setting.backend)) fail('BACKEND_INVALID: expected jobs or sandbox; nothing dispatched');
  validate(setting, schema('execution'));
  const backend = setting.backend ?? 'jobs';
  if (setting.enabled !== true) fail('REPOSITORY_DISABLED');
  validate(descriptor, schema('platform-descriptor'));
  if (descriptor.platform_id !== setting.platform_id || descriptor.backend !== backend) fail('PLATFORM_BINDING_MISMATCH');
  return { backend, provider: PROVIDERS[backend], platform_id: setting.platform_id };
}
function readTrusted(root, name) {
  let current = root;
  for (const part of ['.squad', name]) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('CONFIG_SYMLINK');
  }
  const stat = fs.statSync(current);
  if (!stat.isFile() || stat.size > 65536) fail('CONFIG_FILE_INVALID');
  return JSON.parse(fs.readFileSync(current, 'utf8'));
}
function hasExecution(root) {
  try {
    const directory = fs.lstatSync(path.join(root, '.squad'));
    if (!directory.isDirectory() || directory.isSymbolicLink()) fail('CONFIG_DIRECTORY_INVALID');
    fs.lstatSync(path.join(root, '.squad', 'execution.json'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function trusted(comment) { return comment.user?.login === BOT && comment.user?.type === 'Bot' && comment.user?.id === 41898282; }
function records(comments, marker) {
  return comments.filter(comment => trusted(comment) && comment.body?.startsWith(marker)).map(comment => {
    try { return JSON.parse(comment.body.slice(marker.length).trim()); } catch { fail('RECEIPT_MALFORMED_RECONCILE_REQUIRED'); }
  });
}
function routeReceipt(comments, repository, issueNumber) {
  const receipts = records(comments, MARKER);
  if (receipts.length > 1) fail('RECEIPT_AMBIGUOUS_RECONCILE_REQUIRED');
  const receipt = receipts[0];
  if (receipts.length && (!receipt || typeof receipt !== 'object' || receipt.schema !== 1 || receipt.repository !== repository || receipt.issue_number !== issueNumber || !Object.hasOwn(PROVIDERS, receipt.backend) || receipt.provider !== PROVIDERS[receipt.backend] || !/^[1-9][0-9]*$/.test(receipt.run_id) || typeof receipt.platform_id !== 'string' || !(receipt.platform_id === 'legacy-jobs' && receipt.backend === 'jobs' || /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+(?:\/providers\/[^/]+(?:\/[^/]+)+)?$/.test(receipt.platform_id)))) fail('RECEIPT_INVALID_RECONCILE_REQUIRED');
  return receipt;
}
function eligibleLabel(label) { return typeof label === 'string' && (label === 'squad' || /^squad:[a-z][a-z0-9-]*$/.test(label) && !LIFECYCLE.has(label)); }
async function admit({ github, context, root, env = process.env }) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (env.GITHUB_REPOSITORY !== repository || context.payload.repository?.full_name !== repository || env.GITHUB_REF !== `refs/heads/${context.payload.repository?.default_branch}`) fail('TRUSTED_DEFAULT_BRANCH_REQUIRED');
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || '')) fail('RUN_ID_INVALID');
  const event = context.payload;
  const revise = context.eventName === 'issue_comment';
  if (!['issues', 'issue_comment'].includes(context.eventName) || event.action !== (revise ? 'created' : 'labeled')) fail('EVENT_REJECTED');
  const actor = revise ? event.comment?.user : event.sender;
  if (actor?.type !== 'User' || !/^[A-Za-z0-9-]{1,39}$/.test(actor.login || '')) fail('ACTOR_REJECTED');
  const { data: permission } = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: actor.login });
  if (!['admin', 'maintain', 'write'].includes(permission.permission) && !['admin', 'maintain', 'write'].includes(permission.role_name)) fail('ACTOR_WRITE_REQUIRED');
  let issueNumber = event.issue?.number;
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) fail('ISSUE_NUMBER_INVALID');
  if (revise) {
    if (!event.issue.pull_request || !Number.isSafeInteger(event.comment?.id) || event.comment.id < 1) fail('REVISE_PR_REQUIRED');
    require('./issue-revise.cjs').parseCommand(event.comment?.body);
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: issueNumber });
    if (!require('./issue-revise.cjs').ownedPull(pr, repository)) fail('REVISE_PR_REJECTED');
    issueNumber = Number(require('./issue-revise.cjs').BRANCH.exec(pr.head.ref)[1]);
  } else if (event.issue?.pull_request || event.issue?.state !== 'open' || !eligibleLabel(event.label?.name)) fail('ISSUE_REQUEST_REJECTED');
  const target = { ...context.repo, issue_number: issueNumber };
  const comments = await github.paginate(github.rest.issues.listComments, { ...target, per_page: 100 });
  let receipt = routeReceipt(comments, repository, issueNumber);
  if (revise && !receipt) fail('REVISE_RECEIPT_REQUIRED');
  // Legacy Jobs installs have no execution file. No legacy input may select Sandbox.
  const selection = receipt || (hasExecution(root)
    ? selectBackend(readTrusted(root, 'execution.json'), readTrusted(root, 'platform.json'))
    : { backend: 'jobs', provider: 'aca-job', platform_id: 'legacy-jobs' });
  if (revise && selection.backend !== 'sandbox') fail('JOBS_REVISE_UNSUPPORTED: use the existing Jobs review process');
  if (!revise && selection.backend === 'jobs' && !event.label.name.startsWith('squad:')) fail('JOBS_MEMBER_LABEL_REQUIRED');
  const requestId = revise ? `comment:${event.comment.id}` : 'initial';
  const claims = records(comments, CLAIM);
  if (claims.some(claim => claim.request_id === requestId) || Number(env.GITHUB_RUN_ATTEMPT || '1') !== 1 || !revise && receipt) fail('DISPATCH_AMBIGUOUS_RECONCILE_REQUIRED: inspect the original run before retrying');
  if (!receipt) {
    receipt = { schema: 1, repository, issue_number: issueNumber, ...selection, run_id: env.GITHUB_RUN_ID };
    await github.rest.issues.createComment({ ...target, body: `${MARKER}\n${JSON.stringify(receipt)}` });
  }
  await github.rest.issues.createComment({ ...target, body: `${CLAIM}\n${JSON.stringify({ schema: 1, repository, issue_number: issueNumber, backend: receipt.backend, request_id: requestId, run_id: env.GITHUB_RUN_ID })}` });
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `backend=${receipt.backend}\nroute_run_id=${env.GITHUB_RUN_ID}\nissue_number=${issueNumber}\n`);
  return receipt;
}
async function assertRoute({ github, context, backend, runId, env = process.env }) {
  if (Number(env.GITHUB_RUN_ATTEMPT || '1') !== 1) fail('DISPATCH_AMBIGUOUS_RECONCILE_REQUIRED');
  if (String(context.runId) !== runId || !Object.hasOwn(PROVIDERS, backend)) fail('CALLER_RUN_MISMATCH');
  const event = context.payload;
  let issueNumber = event.issue?.number;
  if (event.issue?.pull_request) {
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: issueNumber });
    if (!require('./issue-revise.cjs').ownedPull(pr, `${context.repo.owner}/${context.repo.repo}`)) fail('REVISE_PR_REJECTED');
    issueNumber = Number(require('./issue-revise.cjs').BRANCH.exec(pr.head.ref)[1]);
  }
  const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: issueNumber, per_page: 100 });
  const receipt = routeReceipt(comments, `${context.repo.owner}/${context.repo.repo}`, issueNumber);
  const claims = records(comments, CLAIM).filter(claim => claim.run_id === runId);
  const requestId = event.issue?.pull_request ? `comment:${event.comment?.id}` : 'initial';
  if (receipt?.backend !== backend || claims.length !== 1 || claims[0].backend !== backend || claims[0].repository !== `${context.repo.owner}/${context.repo.repo}` || claims[0].issue_number !== issueNumber || claims[0].request_id !== requestId) fail('BACKEND_RECEIPT_REQUIRED');
}
module.exports = { admit, assertRoute, selectBackend, routeReceipt, eligibleLabel, validate, MARKER, CLAIM };
