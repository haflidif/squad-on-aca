const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const execWithEnv = path.join(repoRoot, 'agents', 'sandbox', 'runner', 'exec-with-env.js');

function runPayload(payload) {
  return spawnSync(process.execPath, [
    execWithEnv,
    process.execPath,
    '-e',
    'process.exit(process.env.SQUAD_OUTPUT_DIR === "out" ? 0 : 3)'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: payload,
    env: {}
  });
}

function assertRejected(payload, expected) {
  const result = runPayload(payload);
  assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, expected);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes('secret-value'), false);
}

test('exec-with-env accepts a flat object of string keys and string values', () => {
  const result = runPayload('{"SQUAD_OUTPUT_DIR":"out"}');
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

test('exec-with-env rejects duplicate keys before JSON.parse can collapse them', () => {
  assertRejected('{"SQUAD_OUTPUT_DIR":"secret-value","SQUAD_OUTPUT_DIR":"out"}', /duplicate keys/);
});

test('exec-with-env rejects nested objects', () => {
  assertRejected('{"SQUAD_OUTPUT_DIR":{"nested":"secret-value"}}', /flat JSON object/);
});

test('exec-with-env rejects non-string values', () => {
  assertRejected('{"SQUAD_OUTPUT_DIR":123}', /value must be a string/);
});

test('exec-with-env rejects oversized payloads without echoing values', () => {
  assertRejected(`{"SQUAD_OUTPUT_DIR":"${'a'.repeat(1024 * 1024)}secret-value"}`, /too large/);
});
