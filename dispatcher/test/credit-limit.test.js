const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { validateMaxAiCredits, resolvePersonaCreditLimit } = require('../../contracts/aca-sandbox/v1/tools/copilot-credit-limit');
const { buildDispatch } = require('../dispatcher');
const { validateContract } = require('../../contracts/aca-sandbox/v1/tools/validate');

test('credit limit defaults to 30 and accepts only explicit safe supported integer values', () => {
  assert.equal(validateMaxAiCredits(), 30);
  for (const value of [30, '30', 31, '100']) assert.equal(validateMaxAiCredits(value), Number(value));
  for (const value of [null, false, '', ' 30', '30 ', '030', '3e1', '30.0', '30 --agent other', '30\n', 0, 29, 30.5, Infinity, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateMaxAiCredits(value), /max-ai-credits/);
  }
});

test('contract and runner-only environment limit must agree; omission stays bounded', () => {
  assert.equal(resolvePersonaCreditLimit({}, {}), 30);
  assert.equal(resolvePersonaCreditLimit({ max_ai_credits: 30 }, { SQUAD_COPILOT_MAX_AI_CREDITS: '30' }), 30);
  assert.equal(resolvePersonaCreditLimit({}, { SQUAD_COPILOT_MAX_AI_CREDITS: '31' }), 31);
  assert.throws(() => resolvePersonaCreditLimit({ max_ai_credits: 30 }, { SQUAD_COPILOT_MAX_AI_CREDITS: '31' }), /does not match/);
  assert.throws(() => resolvePersonaCreditLimit({ max_ai_credits: null }, {}), /credit limit/);
});

test('dispatch exposes a numeric bounded limit and schema rejects invalid limit types', () => {
  const dispatch = buildDispatch({}, {}, 30);
  assert.equal(dispatch.max_ai_credits, 30);
  for (const max_ai_credits of [29, '30', null, 30.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = validateContract('persona-dispatch.schema.json', { ...dispatch, max_ai_credits });
    assert.equal(result.valid, false);
    assert(result.errors.some(error => error.includes('max_ai_credits')));
  }
});

test('CLI advertises the bounded option and rejects missing, malformed and arbitrary options', () => {
  const cli = path.resolve(__dirname, '..', 'cli.js');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--max-ai-credits/);
  const missing = spawnSync(process.execPath, [cli, '--max-ai-credits'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires a value/);
  for (const value of ['29', '30 --yolo', '']) {
    const invalid = spawnSync(process.execPath, [cli, '--max-ai-credits', value], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /max-ai-credits/);
  }
  const arbitrary = spawnSync(process.execPath, [cli, '--copilot-options', '--yolo'], { encoding: 'utf8' });
  assert.equal(arbitrary.status, 1);
  assert.match(arbitrary.stderr, /Unknown argument/);
});
