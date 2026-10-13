const fs = require('node:fs');

const DEFAULT_MAX_AI_CREDITS = 30;

function validateMaxAiCredits(value = DEFAULT_MAX_AI_CREDITS) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !/^[1-9][0-9]*$/.test(value)) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < 30) {
    throw new Error('max-ai-credits must be a safe integer >= 30 (Copilot CLI 1.0.96 minimum; soft AI-credit limit, not a hard USD cap).');
  }
  return Number(value);
}

function resolvePersonaCreditLimit(dispatch, env = process.env) {
  const contract = dispatch.max_ai_credits;
  const injected = env.SQUAD_COPILOT_MAX_AI_CREDITS;
  if (contract !== undefined) {
    if (typeof contract !== 'number') throw new Error('Persona max_ai_credits must be a numeric credit limit.');
    validateMaxAiCredits(contract);
  }
  if (injected !== undefined) validateMaxAiCredits(injected);
  if (contract !== undefined && injected !== undefined && Number(contract) !== Number(injected)) {
    throw new Error('Copilot credit limit does not match the persona dispatch contract.');
  }
  return validateMaxAiCredits(contract ?? injected ?? DEFAULT_MAX_AI_CREDITS);
}

if (require.main === module) {
  try {
    console.log(resolvePersonaCreditLimit(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { DEFAULT_MAX_AI_CREDITS, validateMaxAiCredits, resolvePersonaCreditLimit };
