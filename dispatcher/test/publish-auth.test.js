'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { authGitEnv, validatePostprocessBinding } = require('../publish');

test('git auth uses basic x-access-token header, not bearer', () => {
  const repoUrl = 'https://github.com/owner/repo.git';
  const env = authGitEnv({ globalConfig: '/tmp/gc', homeDir: '/tmp/home' }, repoUrl, 'ghs_example');
  assert.equal(env.GIT_CONFIG_KEY_0, `http.${repoUrl}.extraheader`);
  const expected = Buffer.from('x-access-token:ghs_example').toString('base64');
  assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${expected}`);
  assert.doesNotMatch(env.GIT_CONFIG_VALUE_0, /bearer/i);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('live publish binding rejects artifacts from another attempt or patch', () => {
  const expected = { runId: '123', runAttempt: '2', executionId: 'exec-1', baselineSha: 'abc', patchSha: 'def' };
  assert.doesNotThrow(() => validatePostprocessBinding({ schema_version: 1, run_id: '123', run_attempt: '2', execution_id: 'exec-1', baseline_sha: 'ABC', patch_sha256: 'DEF' }, expected));
  for (const field of ['run_id', 'run_attempt', 'execution_id', 'baseline_sha', 'patch_sha256']) {
    const binding = { schema_version: 1, run_id: '123', run_attempt: '2', execution_id: 'exec-1', baseline_sha: 'abc', patch_sha256: 'def' };
    binding[field] = 'wrong';
    assert.throws(() => validatePostprocessBinding(binding, expected), /postprocess artifact binding/);
  }
});
