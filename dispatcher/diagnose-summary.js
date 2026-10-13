const fs = require('node:fs');
const path = require('node:path');
const { validateContract } = require('../contracts/aca-sandbox/v1/tools/validate');

const MAX_MESSAGE_CHARS = 1500;
const MAX_LOG_BYTES = 64 * 1024;
const MAX_PRINTED_LOG_LINES = 60;
const MAX_PRINTED_LINE_CHARS = 300;
const MAX_COPIED_FILE_BYTES = 128 * 1024;
const MIN_EXACT_TOKEN_LENGTH = 8;

const CLASSIFIERS = [
  [/credential material detected/i, 'CREDENTIAL_LEAK_DETECTED'],
  [/timed out/i, 'RUNNER_TIMEOUT'],
  [/sandbox baseline clone failed/i, 'BASELINE_CLONE_FAILED'],
  [/dispatch validation failed/i, 'DISPATCH_VALIDATION_FAILED'],
  [/(persona-result|artifact-manifest) validation failed/i, 'ARTIFACT_CONTRACT_INVALID'],
  [/sha256 mismatch/i, 'ARTIFACT_SHA_MISMATCH'],
  [/unsafe artifact path|ownership (check|drift)|exceeds .* limit/i, 'ARTIFACT_POLICY_VIOLATION'],
  [/sandbox delete failed|integration sandbox delete failed/i, 'SANDBOX_DELETE_FAILED'],
  [/disk image/i, 'DISK_IMAGE_FAILURE'],
  [/access-token/i, 'AZURE_TOKEN_FAILURE'],
  [/unauthori[sz]ed|forbidden|authenticat|\b40[13]\b|not logged in|AADSTS\d+/i, 'AUTHENTICATION_FAILURE'],
  [/manifest unknown|image pull|ImagePull|pull access denied/i, 'IMAGE_PULL_FAILURE'],
  [/aca sandbox create|sandbox create/i, 'SANDBOX_CREATE_FAILED'],
  [/integrat/i, 'INTEGRATION_FAILED']
];

const STAGE_FALLBACKS = [
  [/disk image/i, 'disk-image'],
  [/sandbox baseline clone/i, 'baseline-clone'],
  [/sandbox delete/i, 'cleanup'],
  [/timed out/i, 'runner-exec'],
  [/validation failed|artifact|sha256/i, 'artifact-collection']
];

function classify(message) {
  for (const [pattern, code] of CLASSIFIERS) if (pattern.test(message)) return code;
  return 'UNCLASSIFIED_SEE_MESSAGE';
}

function fallbackStage(message) {
  for (const [pattern, stage] of STAGE_FALLBACKS) if (pattern.test(message)) return stage;
  return 'unattributed';
}

function tokenVariants(token) {
  if (typeof token !== 'string' || token.length < MIN_EXACT_TOKEN_LENGTH) return [];
  const variants = new Set([token, token.trim()]);
  variants.add(Buffer.from(token).toString('base64'));
  variants.add(Buffer.from(token).toString('base64url'));
  variants.add(encodeURIComponent(token));
  variants.add(Buffer.from(token).toString('hex'));
  return [...variants].filter(value => value.length >= MIN_EXACT_TOKEN_LENGTH);
}

function makeRedactor(token) {
  const variants = tokenVariants(token);
  return function redact(value) {
    let text = String(value ?? '');
    for (const variant of variants) text = text.split(variant).join('[REDACTED_TOKEN]');
    return text
      .replace(/github_pat_[A-Za-z0-9_]+|gh[opsur]_[A-Za-z0-9_]+/g, '[REDACTED_TOKEN]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer [REDACTED_TOKEN]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]')
      .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi, '$1=[REDACTED]');
  };
}

function safeLine(text, limit = MAX_PRINTED_LINE_CHARS) {
  let line = String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  line = line.replace(/^(\s*)::/, '$1: :');
  return line.length > limit ? `${line.slice(0, limit)}...[truncated]` : line;
}

function readRegularFile(file, maxBytes) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const size = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    return { text: buffer.toString('utf8'), truncated: stat.size > maxBytes };
  } finally {
    fs.closeSync(fd);
  }
}

function parseStageFailures(logText) {
  const stages = new Map();
  for (const line of logText.split(/\r?\n/)) {
    const match = /^stage-failure (?:task=(\S+)|(integration)) stage=([a-z-]+)$/.exec(line);
    if (match) stages.set(match[1] || 'integration', match[3]);
  }
  return stages;
}

function describeEntry(kind, id, entry, stages, redact) {
  const message = redact(entry.reason || '').slice(0, MAX_MESSAGE_CHARS);
  const failed = entry.status === 'failed';
  return {
    kind,
    id,
    status: entry.status,
    stage: failed ? (stages.get(kind === 'integration' ? 'integration' : id) || fallbackStage(message)) : null,
    code: failed ? classify(message) : null,
    message: failed ? message : '',
    sandbox_id: entry.sandbox_id || '',
    deletion_error: redact(entry.deletion_error || '').slice(0, MAX_MESSAGE_CHARS)
  };
}

function buildReport({ summary, summaryError, stages, redact }) {
  if (!summary) {
    return {
      overall_status: 'unknown',
      code: summaryError.code,
      stage: 'dispatcher-no-summary',
      message: redact(summaryError.message).slice(0, MAX_MESSAGE_CHARS),
      entries: [],
      cleanup: { owned_sandbox_ids_with_deletion_error: [], disk_image_deletion_error: '' }
    };
  }
  const entries = summary.tasks.map(task => describeEntry('task', task.task_id, task, stages, redact));
  if (summary.integration) entries.push(describeEntry('integration', 'integration', summary.integration, stages, redact));
  const failing = entries.find(entry => entry.status === 'failed') || entries.find(entry => entry.status === 'skipped');
  const diskError = redact(summary.disk_image_deletion_error || '').slice(0, MAX_MESSAGE_CHARS);
  return {
    overall_status: summary.status,
    code: failing?.code || (diskError ? 'DISK_IMAGE_FAILURE' : null),
    stage: failing?.stage || (diskError ? 'disk-image' : null),
    message: failing?.message || diskError,
    entries,
    cleanup: {
      owned_sandbox_ids_with_deletion_error: entries.filter(entry => entry.deletion_error).map(entry => entry.sandbox_id),
      disk_image_deletion_error: diskError
    }
  };
}

function redactJsonText(file, redact) {
  const loaded = readRegularFile(file, MAX_COPIED_FILE_BYTES);
  if (!loaded) return null;
  return `${redact(loaded.text)}${loaded.truncated ? '\n[truncated]\n' : ''}`;
}

function writeBundle({ diagnosticsDir, report, summary, logText, summaryDir, redact, token }) {
  if (fs.existsSync(diagnosticsDir)) throw new Error('Diagnostics directory must not already exist.');
  fs.mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 });
  const outputs = new Map();
  outputs.set('diagnostics.json', `${JSON.stringify(report, null, 2)}\n`);
  if (summary) outputs.set('dispatcher-summary.redacted.json', redact(`${JSON.stringify(summary, null, 2)}\n`));
  if (logText) outputs.set('dispatcher.log.redacted.txt', redact(logText));
  if (summary && summaryDir) {
    for (const task of summary.tasks) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(task.task_id)) continue;
      const safeId = task.task_id.replace(/[^a-zA-Z0-9._-]/g, '-');
      const text = redactJsonText(path.join(summaryDir, 'tasks', safeId, 'persona-result.json'), redact);
      if (text !== null) outputs.set(`tasks/${safeId}/persona-result.json`, text);
    }
  }
  const variants = tokenVariants(token);
  for (const [name, content] of outputs) {
    if (variants.some(variant => content.includes(variant))) {
      fs.rmSync(diagnosticsDir, { recursive: true, force: true });
      throw new Error(`Credential material survived redaction in ${name}; diagnostics bundle discarded.`);
    }
  }
  for (const [name, content] of outputs) {
    const target = path.join(diagnosticsDir, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode: 0o600 });
  }
  return [...outputs.keys()];
}

function renderMarkdown(report) {
  const lines = [`### Dispatcher diagnostics`, '', `- overall: \`${report.overall_status}\``, `- code: \`${report.code || 'none'}\``, `- stage: \`${report.stage || 'none'}\``];
  for (const entry of report.entries) {
    lines.push(`- ${entry.kind} \`${entry.id}\`: ${entry.status}${entry.code ? ` (${entry.code} at ${entry.stage})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function diagnose({ summaryPath, diagnosticsDir, token, print = console.log }) {
  const redact = makeRedactor(token);
  const summaryFile = path.resolve(summaryPath);
  const summaryDir = path.dirname(summaryFile);
  const logLoaded = readRegularFile(path.join(summaryDir, 'dispatcher.log'), MAX_LOG_BYTES);
  const logText = logLoaded ? logLoaded.text : '';
  const stages = parseStageFailures(logText);

  let summary = null;
  let summaryError = null;
  const loaded = readRegularFile(summaryFile, 4 * 1024 * 1024);
  if (!loaded) {
    summaryError = { code: 'SUMMARY_MISSING', message: 'Dispatcher did not produce a summary file before exiting.' };
  } else {
    try {
      const parsed = JSON.parse(loaded.text);
      const validation = validateContract('dispatcher-summary.schema.json', parsed);
      if (validation.valid) summary = parsed;
      else summaryError = { code: 'SUMMARY_INVALID', message: `Dispatcher summary failed schema validation: ${validation.errors.join('; ')}` };
    } catch (error) {
      summaryError = { code: 'SUMMARY_INVALID', message: `Dispatcher summary is not valid JSON: ${error.message}` };
    }
  }

  const report = buildReport({ summary, summaryError, stages, redact });
  const files = writeBundle({ diagnosticsDir, report, summary, logText, summaryDir, redact, token });

  print(`diagnostics: overall=${report.overall_status} code=${report.code || 'none'} stage=${report.stage || 'none'}`);
  for (const entry of report.entries) {
    print(`diagnostics: ${entry.kind}=${safeLine(entry.id, 80)} status=${entry.status} stage=${entry.stage || '-'} code=${entry.code || '-'} sandbox=${safeLine(entry.sandbox_id, 64) || '-'}`);
    if (entry.message) print(`diagnostics:   message: ${safeLine(entry.message, MAX_MESSAGE_CHARS)}`);
    if (entry.deletion_error) print(`diagnostics:   deletion_error: ${safeLine(entry.deletion_error, MAX_MESSAGE_CHARS)}`);
  }
  if (!summary) print(`diagnostics: message: ${safeLine(report.message, MAX_MESSAGE_CHARS)}`);
  if (report.cleanup.disk_image_deletion_error) print(`diagnostics: disk_image_deletion: ${safeLine(report.cleanup.disk_image_deletion_error, MAX_MESSAGE_CHARS)}`);
  if (report.overall_status !== 'succeeded' && logText) {
    const lines = redact(logText).split(/\r?\n/).filter(Boolean).slice(-MAX_PRINTED_LOG_LINES);
    print('diagnostics: --- redacted dispatcher.log tail ---');
    for (const line of lines) print(`diagnostics: | ${safeLine(line)}`);
  }
  return { report, files };
}

if (require.main === module) {
  try {
    const summaryPath = process.env.SUMMARY_FILE || process.env.SQUAD_SUMMARY_PATH;
    if (!summaryPath) throw new Error('SUMMARY_FILE is not set.');
    if (!process.env.SQUAD_DIAGNOSTICS_DIR) throw new Error('SQUAD_DIAGNOSTICS_DIR is not set.');
    const { report } = diagnose({
      summaryPath,
      diagnosticsDir: process.env.SQUAD_DIAGNOSTICS_DIR,
      token: process.env.SQUAD_COPILOT_TOKEN || ''
    });
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
  } catch (error) {
    console.error(`diagnostics failed: ${safeLine(error.message, MAX_MESSAGE_CHARS)}`);
    process.exitCode = 2;
  }
}

module.exports = { classify, diagnose, makeRedactor, safeLine, tokenVariants };