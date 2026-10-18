const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULT_SECRET_ENV_KEYS = new Set([
  'SQUAD_COPILOT_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'GITHUB_PAT'
]);
const SECRET_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD)|PAT$/i;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function redact(value, token) {
  let text = String(value ?? '');
  if (token) text = text.split(token).join('[REDACTED_GITHUB_TOKEN]');
  return text.replace(/github_pat_[A-Za-z0-9_]+|gh[ops]_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_TOKEN]');
}

function containsToken(value, token) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  return Boolean((token && text.includes(token)) || /github_pat_[A-Za-z0-9_]+|gh[ops]_[A-Za-z0-9_]+/.test(text));
}

function isSecretEnvKey(key, extraSecretKeys = []) {
  const normalized = String(key || '');
  return DEFAULT_SECRET_ENV_KEYS.has(normalized) || extraSecretKeys.includes(normalized) || SECRET_ENV_PATTERN.test(normalized);
}

function buildSafeChildEnv(overrides = {}, options = {}) {
  const extraSecretKeys = options.secretEnvKeys || [];
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isSecretEnvKey(key, extraSecretKeys)) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!isSecretEnvKey(key, extraSecretKeys)) env[key] = value;
  }
  return env;
}

function findBash() {
  const candidates = [
    process.env.BASH,
    'bash',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', env: buildSafeChildEnv() });
    if (result.status === 0) return candidate;
  }
  return null;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const { secretEnvKeys, env, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, env: buildSafeChildEnv(env, { secretEnvKeys }), shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000).unref?.();
      }, options.timeoutMs);
    }
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: error.message, timedOut });
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    }
  });
}

async function runChecked(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) {
    const error = new Error(`${command} ${args.join(' ')} failed with ${result.exitCode}\n${result.stderr || result.stdout}`);
    error.result = result;
    throw error;
  }
  return result.stdout.trim();
}

function toPosixPath(value) {
  return String(value).split(path.sep).join('/');
}

module.exports = {
  buildSafeChildEnv,
  readJson,
  writeJson,
  sha256Bytes,
  sha256File,
  safeName,
  redact,
  containsToken,
  findBash,
  run,
  runChecked,
  toPosixPath
};
