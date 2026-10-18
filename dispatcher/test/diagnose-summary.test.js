const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRedactor, classify, safeLine, tokenVariants } = require('../diagnose-summary');
test('opaque Actions tokens and encodings are removed exactly', () => {
  const token = 'opaque-credential-fixture-without-ghs-prefix';
  const redact = makeRedactor(token);
  for (const value of tokenVariants(token)) assert.ok(!redact('before ' + value + ' after').includes(value));
  assert.equal(redact('harmless result'), 'harmless result');
});
test('NO_CHANGES has a specific failure code', () => {
  assert.equal(classify('NO_CHANGES'), 'NO_CHANGES');
});
test('failure output is classified and workflow commands are neutralized', () => {
  assert.equal(classify('ACA sandbox create failed: unauthorized'), 'AUTHENTICATION_FAILURE');
  assert.equal(classify('Check command verify-result-exact-content failed with exit code 1.'), 'INTEGRATION_CHECK_FAILED');
  assert.equal(classify('ACA disk image create returned unexpected HTTP status 403.'), 'DISK_IMAGE_FAILURE');
  assert.equal(safeLine('::error::fixture'), ': :error::fixture');
});
