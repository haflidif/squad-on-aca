'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateContract } = require('../contracts/aca-sandbox/v1/tools/validate');

const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STAGE = /^[a-z][a-z-]{0,39}$/;
const MEMBER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MEMBER_NAME = /^[A-Za-z][A-Za-z0-9 .'-]{0,79}$/;
const SAFE_REASON = /^[A-Za-z0-9][A-Za-z0-9 .,;:()/_+-]{0,159}$/;
const ENTRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const ENTRY_KINDS = new Set(['task', 'integration']);
const ENTRY_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'skipped', 'not_run']);
const JOB_RESULTS = new Set(['success', 'failure', 'cancelled', 'skipped']);
const MAX_JSON_BYTES = 4 * 1024 * 1024;

function readRegular(file, maxBytes = MAX_JSON_BYTES) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return fs.readFileSync(file);
  } catch { return null; }
}

function sha256(buffer) {
  return buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : null;
}

function pick(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function readJson(file) {
  const bytes = readRegular(file);
  try { return bytes ? JSON.parse(bytes.toString('utf8')) : null; } catch { return null; }
}

function summarizeStage(summaryFile, diagnosticsDir) {
  const summaryBytes = readRegular(summaryFile);
  const diagnosticsBytes = readRegular(path.join(diagnosticsDir, 'diagnostics.json'));
  let summary = null;
  let diagnostics = null;
  try { summary = summaryBytes ? JSON.parse(summaryBytes.toString('utf8')) : null; } catch { summary = null; }
  try { diagnostics = diagnosticsBytes ? JSON.parse(diagnosticsBytes.toString('utf8')) : null; } catch { diagnostics = null; }
  const entries = Array.isArray(diagnostics?.entries) ? diagnostics.entries : [];
  return {
    status: diagnostics?.overall_status === 'succeeded' || diagnostics?.overall_status === 'failed' ? diagnostics.overall_status : 'unknown',
    code: pick(diagnostics?.code, CODE),
    stage: pick(diagnostics?.stage, STAGE),
    entries: entries
      .filter(entry => ENTRY_KINDS.has(entry?.kind) && ENTRY_STATUSES.has(entry?.status) && pick(entry?.id, ENTRY_ID))
      .map(entry => ({ kind: entry.kind, id: entry.id, status: entry.status })),
    integration_status: ENTRY_STATUSES.has(summary?.integration?.status) ? summary.integration.status : null,
    failed_task_id: pick(summary?.integration?.failed_task_id, ENTRY_ID),
    hashes: {
      dispatcher_summary_sha256: sha256(summaryBytes),
      integration_patch_sha256: pick(summary?.integration?.sha256, SHA256),
      diagnostics_sha256: sha256(diagnosticsBytes)
    }
  };
}

function validateRoute(route) {
  if (!route || route.schema !== 1) return null;
  return validateRouteBody(route);
}

function validateRouteBody(route) {
  if (Array.isArray(route?.members)) {
    if (!route.members.length || route.members.length > 3 || !pick(route.reason, SAFE_REASON)) return null;
    const members = [];
    for (const member of route.members) {
      if (!pick(member?.logical_member_id, MEMBER_ID) || !pick(member?.resolved_persistent_name, MEMBER_NAME) ||
          !pick(member?.objective, SAFE_REASON) || typeof member?.role !== 'string' || !/^[A-Za-z0-9 &.,;:()/_+-]{1,160}$/.test(member.role) ||
          !Array.isArray(member?.owned_paths) || !member.owned_paths.every(scope => typeof scope === 'string' && /^[A-Za-z0-9_.*/-]{1,200}$/.test(scope))) return null;
      members.push({ logical_member_id: member.logical_member_id, resolved_persistent_name: member.resolved_persistent_name,
        role: member.role, objective: member.objective, owned_paths: member.owned_paths });
    }
    if (new Set(members.map(member => member.logical_member_id)).size !== members.length) return null;
    return { members, member: { logical_member_id: members[0].logical_member_id, resolved_persistent_name: members[0].resolved_persistent_name }, reason: route.reason };
  }
  if (!route || !route.member || typeof route.member !== 'object') return null;
  const id = pick(route.member.logical_member_id, MEMBER_ID);
  const name = pick(route.member.resolved_persistent_name, MEMBER_NAME);
  const reason = pick(route.reason, SAFE_REASON);
  return id && name && reason ? { member: { logical_member_id: id, resolved_persistent_name: name }, reason } : null;
}

function resolveContainedFile(rootPath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || path.isAbsolute(relativePath)) return null;
  const parts = relativePath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  const root = path.resolve(rootPath);
  let current = root;
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return null;
      const final = index === parts.length - 1;
      if ((!final && !stat.isDirectory()) || (final && !stat.isFile())) return null;
    }
  } catch { return null; }
  const relative = path.relative(root, current);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return current;
}

function summarize({ leadSummaryFile, leadDiagnosticsDir, memberSummaryFile, memberDiagnosticsDir, routeFile, env }) {
  const lead = summarizeStage(leadSummaryFile, leadDiagnosticsDir);
  const member = summarizeStage(memberSummaryFile, memberDiagnosticsDir);
  const route = validateRoute(readJson(routeFile));
  const serverUrl = env.GITHUB_SERVER_URL === 'https://github.com' ? env.GITHUB_SERVER_URL : 'https://github.com';
  const repository = pick(env.GITHUB_REPOSITORY, /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);
  const runId = pick(env.GITHUB_RUN_ID, /^[0-9]{1,20}$/);
  const status = lead.status === 'failed' || member.status === 'failed' ? 'failed'
    : lead.status === 'succeeded' && member.status === 'succeeded' ? 'succeeded' : 'unknown';
  return {
    schema: 2,
    status,
    stages: { lead, member },
    route,
    run_url: repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null,
    publication: 'disabled'
  };
}

function summarizeStored(result) {
  const route = validateRouteBody(result?.route);
  const stage = value => ({
    status: ['succeeded', 'failed', 'unknown'].includes(value?.status) ? value.status : 'unknown',
    code: pick(value?.code, CODE),
    stage: pick(value?.stage, STAGE),
    entries: (Array.isArray(value?.entries) ? value.entries : [])
      .filter(entry => ENTRY_KINDS.has(entry?.kind) && ENTRY_STATUSES.has(entry?.status) && pick(entry?.id, ENTRY_ID))
      .map(entry => ({ kind: entry.kind, id: entry.id, status: entry.status })),
    integration_status: ENTRY_STATUSES.has(value?.integration_status) ? value.integration_status : null,
    failed_task_id: pick(value?.failed_task_id, ENTRY_ID),
    hashes: {
      dispatcher_summary_sha256: pick(value?.hashes?.dispatcher_summary_sha256, SHA256),
      integration_patch_sha256: pick(value?.hashes?.integration_patch_sha256, SHA256),
      diagnostics_sha256: pick(value?.hashes?.diagnostics_sha256, SHA256)
    }
  });
  return {
    schema: 2,
    status: ['succeeded', 'failed', 'unknown'].includes(result?.status) ? result.status : 'unknown',
    stages: { lead: stage(result?.stages?.lead), member: stage(result?.stages?.member) },
    route,
    run_url: pick(result?.run_url, /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/actions\/runs\/[0-9]{1,20}$/),
    publication: 'disabled'
  };
}

function renderComment(result, jobs = {}) {
  const gate = JOB_RESULTS.has(jobs.gate) ? jobs.gate : 'unknown';
  const leadJob = JOB_RESULTS.has(jobs.lead) ? jobs.lead : 'unknown';
  const memberJob = JOB_RESULTS.has(jobs.member) ? jobs.member : 'unknown';
  const publishJob = JOB_RESULTS.has(jobs.publish) ? jobs.publish : 'unknown';
  const lines = ['### Squad sandbox run', ''];
  if (!result) {
    lines.push('Status: `no result` (the staged dispatch produced no sanitized result).', '', `- gate job: \`${gate}\``, `- lead dispatch job: \`${leadJob}\``, `- member dispatch job: \`${memberJob}\``);
  } else {
    const overall = [leadJob, memberJob, publishJob].some(status => ['failure', 'cancelled', 'skipped'].includes(status)) ? 'failed' : result.status;
    lines.push(`Status: \`${overall}\``, '');
    if (result.route) {
      for (const member of result.route.members || [result.route.member]) {
        lines.push(`- routed member: \`${member.logical_member_id}\` (${member.resolved_persistent_name})${member.role ? `, ${member.role}` : ''}${member.objective ? `: ${member.objective}` : ''}`);
      }
      lines.push(`- routing reason: ${result.route.reason}`);
    } else {
      lines.push('- routed member: `unavailable`');
    }
    for (const key of ['lead', 'member']) {
      const stage = result.stages[key];
      lines.push(`- ${key} stage: \`${stage.status}\`${stage.code ? ` (\`${stage.code}\` at \`${stage.stage || 'unknown'}\`)` : ''}`);
      for (const entry of stage.entries) lines.push(`  - ${entry.kind} \`${entry.id}\`: \`${entry.status}\``);
      if (stage.failed_task_id) lines.push(`  - failed task: \`${stage.failed_task_id}\``);
      if (stage.integration_status) lines.push(`  - integration: \`${stage.integration_status}\``);
      for (const [label, value] of [
        [`${key} dispatcher summary sha256`, stage.hashes.dispatcher_summary_sha256],
        [`${key} integration patch sha256`, stage.hashes.integration_patch_sha256],
        [`${key} diagnostics sha256`, stage.hashes.diagnostics_sha256]
      ]) if (pick(value, SHA256)) lines.push(`  - ${label}: \`${value}\``);
    }
    lines.push(`- gate job: \`${gate}\``, `- lead dispatch job: \`${leadJob}\``, `- member dispatch job: \`${memberJob}\``);
    if (result.run_url) lines.push('', `Run: ${result.run_url}`);
  }
  lines.push('', `- publish job: \`${publishJob}\``);
  return `${lines.join('\n')}\n`;
}

function copyDiagnostics(source, destination, label) {
  if (typeof source === 'string' && source && fs.existsSync(source) && fs.lstatSync(source).isDirectory() && !fs.lstatSync(source).isSymbolicLink()) {
    fs.cpSync(source, path.join(destination, label), { recursive: true, dereference: false });
  }
}

function copyMemberPatch(summaryFile, destination) {
  const summary = readJson(summaryFile);
  const patch = summary && resolveContainedFile(path.dirname(summaryFile), summary.integration?.integrated_patch_path);
  if (!patch) return null;
  const target = path.join(destination, 'member-integrated.patch');
  fs.copyFileSync(patch, target, fs.constants.COPYFILE_EXCL);
  return target;
}
function copyMemberIntegrationArtifacts(summaryFile, summary, destination) {
  const patch = resolveContainedFile(path.dirname(summaryFile), summary.integration.integrated_patch_path);
  const manifestPath = resolveContainedFile(path.dirname(summaryFile), 'integration/artifact-manifest.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (error) { throw new Error(`integration artifact manifest is missing or invalid: ${error.message}`); }
  const validation = validateContract('artifact-manifest.schema.json', manifest);
  if (!validation.valid) throw new Error(`integration artifact manifest is invalid: ${validation.errors.join('; ')}`);
  if (manifest.task_id !== 'integration' || manifest.run_id !== summary.run_id) {
    throw new Error('integration artifact manifest identity does not match dispatcher summary');
  }
  const patchBytes = fs.readFileSync(patch);
  const patchSha = crypto.createHash('sha256').update(patchBytes).digest('hex');
  const patchArtifact = manifest.artifacts.find(artifact => artifact.kind === 'patch');
  if (patchSha !== summary.integration.sha256?.toLowerCase() || !patchArtifact ||
      `integration/${patchArtifact.path}` !== summary.integration.integrated_patch_path.replace(/\\/g, '/') ||
      patchArtifact.sha256.toLowerCase() !== patchSha) {
    throw new Error('integrated patch does not match dispatcher summary and artifact manifest');
  }
  const targetPatch = path.join(destination, ...summary.integration.integrated_patch_path.split('/'));
  const targetManifest = path.join(destination, 'integration', 'artifact-manifest.json');
  fs.mkdirSync(path.dirname(targetPatch), { recursive: true });
  fs.copyFileSync(patch, targetPatch, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(manifestPath, targetManifest, fs.constants.COPYFILE_EXCL);
  return { patchPath: targetPatch, manifestPath: targetManifest };
}

function main(argv, env) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index].replace(/^--/, '');
    if (key === 'include-patch') args[key] = true;
    else args[key] = rest[++index];
  }
  if (command === 'summarize') {
    const result = summarize({
      leadSummaryFile: args['lead-summary'], leadDiagnosticsDir: args['lead-diagnostics'],
      memberSummaryFile: args['member-summary'], memberDiagnosticsDir: args['member-diagnostics'],
      routeFile: args.route, env
    });
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, 'issue-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    copyDiagnostics(args['lead-diagnostics'], args.out, 'lead-diagnostics');
    copyDiagnostics(args['member-diagnostics'], args.out, 'member-diagnostics');
    copyMemberPatch(args['member-summary'], args.out);
    console.log(`ISSUE_RESULT status=${result.status}`);
    return;
  }
  if (command === 'stage-artifact') {
    fs.mkdirSync(args.out, { recursive: true });
    const summaryBytes = args.summary ? readRegular(args.summary) : null;
    let summary = null;
    try { summary = summaryBytes ? JSON.parse(summaryBytes.toString('utf8')) : null; } catch { summary = null; }
    if (summaryBytes) fs.writeFileSync(path.join(args.out, 'dispatcher-summary.json'), summaryBytes, { mode: 0o600, flag: 'wx' });
    copyDiagnostics(args.diagnostics, args.out, 'diagnostics');
    if (args['include-patch'] !== undefined && summary?.integration?.status === 'succeeded') {
      copyMemberIntegrationArtifacts(args.summary, summary, args.out);
    }
    return;
  }
  if (command === 'comment') {
    const raw = args.result ? readRegular(args.result, 64 * 1024) : null;
    let result = null;
    try { result = raw ? JSON.parse(raw.toString('utf8')) : null; } catch { result = null; }
    const clean = result && result.schema === 2 ? summarizeStored(result) : null;
    fs.writeFileSync(args.out, renderComment(clean, {
      gate: env.GATE_RESULT, lead: env.LEAD_RESULT, member: env.MEMBER_RESULT, publish: env.PUBLISH_RESULT
    }), { mode: 0o600 });
    return;
  }
  throw new Error('Usage: issue-report.cjs summarize|comment');
}

if (require.main === module) {
  try { main(process.argv.slice(2), process.env); }
  catch (error) {
    console.error(`ISSUE_REPORT_FAILED ${error.message.slice(0, 120)}`);
    process.exitCode = 1;
  }
}

module.exports = { renderComment, summarize, summarizeStage, summarizeStored, validateRoute };
