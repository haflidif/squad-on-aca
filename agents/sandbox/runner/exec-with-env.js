#!/usr/bin/env node
const { spawn } = require('node:child_process');

const allowedExactKeys = new Set([
  'SQUAD_SOURCE_REPO_PATH',
  'SQUAD_OUTPUT_DIR',
  'SQUAD_COPILOT_TOKEN',
  'SQUAD_COPILOT_BIN',
  'SQUAD_FAKE_COPILOT_ENV_ALLOWLIST',
  'PATH_SCOPE_TOOL'
]);

function isAllowedKey(key) {
  return allowedExactKeys.has(key) || /^FAKE_[A-Z0-9_]+$/.test(key);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function strictParseStringMapJson(input) {
  const text = input || '{}';
  let index = 0;
  const result = {};
  const seen = new Set();

  function skipWhitespace() {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  }

  function parseString(label) {
    skipWhitespace();
    if (text[index] !== '"') throw new Error(`Environment ${label} must be a string.`);
    const start = index;
    index += 1;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          throw new Error('Environment payload must be valid JSON.');
        }
      }
      if (char === '\\') {
        index += 1;
        if (index >= text.length) throw new Error('Environment payload must be valid JSON.');
        const escape = text[index];
        if (escape === 'u') {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Environment payload must be valid JSON.');
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(escape)) throw new Error('Environment payload must be valid JSON.');
      } else if (char < ' ') {
        throw new Error('Environment payload must be valid JSON.');
      }
      index += 1;
    }
    throw new Error('Environment payload must be valid JSON.');
  }

  skipWhitespace();
  if (text[index] !== '{') throw new Error('Environment payload must be a flat JSON object.');
  index += 1;
  skipWhitespace();
  if (text[index] === '}') {
    index += 1;
    skipWhitespace();
    if (index !== text.length) throw new Error('Environment payload must be valid JSON.');
    return result;
  }

  while (index < text.length) {
    const key = parseString('key');
    if (seen.has(key)) throw new Error('Environment payload contains duplicate keys.');
    seen.add(key);
    skipWhitespace();
    if (text[index] !== ':') throw new Error('Environment payload must be valid JSON.');
    index += 1;
    skipWhitespace();
    if (text[index] === '{' || text[index] === '[') throw new Error('Environment payload must be a flat JSON object.');
    const value = parseString('value');
    result[key] = value;
    skipWhitespace();
    if (text[index] === ',') {
      index += 1;
      skipWhitespace();
      continue;
    }
    if (text[index] === '}') {
      index += 1;
      skipWhitespace();
      if (index !== text.length) throw new Error('Environment payload must be valid JSON.');
      return result;
    }
    throw new Error('Environment payload must be valid JSON.');
  }
  throw new Error('Environment payload must be valid JSON.');
}

const argv = process.argv.slice(2);
if (argv.length === 0) fail('Usage: exec-with-env.js <command> [args...]');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 1024 * 1024) fail('Environment payload is too large.');
});

process.stdin.on('end', () => {
  let payload;
  try {
    payload = strictParseStringMapJson(input);
  } catch (error) {
    fail(error.message);
  }

  const env = { ...process.env };
  for (const [key, value] of Object.entries(payload)) {
    if (!isAllowedKey(key)) fail(`Environment key is not allowed: ${key}`);
    env[key] = value;
  }

  const child = spawn(argv[0], argv.slice(1), {
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
    shell: false
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on('error', error => {
    console.error(`Failed to start requested command: ${error.message}`);
    process.exit(127);
  });
});
