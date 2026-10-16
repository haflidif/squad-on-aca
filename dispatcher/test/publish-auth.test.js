'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { authGitEnv } = require('../publish');

test('git auth uses basic x-access-token header, not bearer', () => {
  const repoUrl = 'https://github.com/owner/repo.git';
  const env = authGitEnv({ globalConfig: '/tmp/gc', homeDir: '/tmp/home' }, repoUrl, 'ghs_example');
  assert.equal(env.GIT_CONFIG_KEY_0, `http.${repoUrl}.extraheader`);
  const expected = Buffer.from('x-access-token:ghs_example').toString('base64');
  assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${expected}`);
  assert.doesNotMatch(env.GIT_CONFIG_VALUE_0, /bearer/i);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});
