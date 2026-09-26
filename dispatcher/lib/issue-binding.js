const { validateContract } = require('../../contracts/aca-sandbox/v1/tools/validate');

function issueNumber(value) {
  if ((typeof value === 'string' && !/^[1-9][0-9]*$/.test(value)) ||
      (typeof value !== 'string' && typeof value !== 'number')) {
    throw new Error('Issue number must be a positive decimal integer.');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Issue number must be a positive decimal integer.');
  return number;
}

function assertIssueBinding(plan, repository, selectedIssue, required = false) {
  const validation = validateContract('coordinator-execution.schema.json', plan);
  if (!validation.valid) throw new Error(`Execution plan is invalid: ${validation.errors.join('; ')}`);
  if (!plan.issue) {
    if (required) throw new Error('Live execution requires a plan issue binding.');
    return;
  }
  if (plan.issue.repo.includes('..') || plan.issue.repo.endsWith('.git') ||
      !Number.isSafeInteger(plan.issue.issue_number)) {
    throw new Error('Plan issue binding has an invalid repository or issue number.');
  }
  if (plan.issue.repo !== repository || plan.issue.issue_number !== issueNumber(selectedIssue)) {
    throw new Error('Plan issue binding does not match the selected repository and issue.');
  }
}

module.exports = { assertIssueBinding, issueNumber };
