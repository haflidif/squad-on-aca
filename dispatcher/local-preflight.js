const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readExecutionPlan } = require('./workflow-preflight');
const { assertIssueBinding, issueNumber } = require('./lib/issue-binding');
const { validateSandboxImageRef } = require('./lib/sandbox-image');
const { buildSafeChildEnv } = require('./lib/util');
const { validateCopilotAuth, COPILOT_AUTH_MODES } = require('./lib/auth');

function validateLocalInputs(options) {
  if (!Number.isInteger(options.concurrency) || options.concurrency !== 1) {
    throw new Error('Local lab concurrency must be exactly 1.');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 300000) {
    throw new Error('Local timeout must be an integer between 1000 and 300000 ms.');
  }
  const blockers = [];
  if (!options.imageRef) blockers.push('Missing approved corrected immutable ImageRef; the local build is not a released digest.');
  else {
    validateSandboxImageRef(options.imageRef);
  }

  let planPath;
  if (options.planPath || options.repository || options.issueNumber) {
    if (!options.planPath || !options.repository || !options.issueNumber) {
      throw new Error('PlanPath, Repository and IssueNumber must be supplied together.');
    }
    const root = path.resolve(options.repoRoot);
    const headResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: root, encoding: 'utf8', shell: false, windowsHide: true, env: buildSafeChildEnv()
    });
    if (headResult.error || headResult.status !== 0 || !/^[a-f0-9]{40}$/i.test(headResult.stdout.trim())) {
      throw new Error('Could not resolve local repository HEAD.');
    }
    const head = headResult.stdout.trim().toLowerCase();
    const relative = path.relative(root, path.resolve(root, options.planPath)).split(path.sep).join('/');
    // Local plans must contain an actual reviewed baseline, not the workflow template placeholder.
    const result = readExecutionPlan(root, relative);
    planPath = result.planPath;
    const plan = result.plan;
    if (plan.baseline_sha.toLowerCase() !== head) throw new Error('Plan baseline must match the checked-out HEAD.');
    assertIssueBinding(plan, options.repository, issueNumber(options.issueNumber), true);
    if (plan.run_id === 'run-offline-smoke-template') throw new Error('The offline smoke fixture is not a live task.');
    if (plan.tasks.length !== 1) throw new Error('First local lab operation requires exactly one persona task.');
    const origin = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root, encoding: 'utf8', shell: false, windowsHide: true, env: buildSafeChildEnv()
    });
    const allowedOrigins = [
      `https://github.com/${options.repository}`,
      `https://github.com/${options.repository}.git`,
      `git@github.com:${options.repository}.git`
    ];
    if (origin.error || origin.status !== 0 || !allowedOrigins.includes(origin.stdout.trim())) {
      throw new Error('Checkout origin must exactly identify the configured repository (no embedded credentials).');
    }
  } else {
    blockers.push('Missing reviewed lab checkout and repo/issue-bound single-persona plan.');
  }
  if (!options.allowUnverifiedClient) {
    blockers.push('Explicit AllowUnverifiedClient approval is required; active-process termination and full live flow remain unverified.');
  }
  if (!options.preflightOnly) {
    if (!options.outDir || fs.existsSync(path.resolve(options.outDir))) {
      throw new Error('OutDir must name a new run-specific directory.');
    }
    validateCopilotAuth({
      token: process.env.SQUAD_COPILOT_TOKEN,
      authMode: options.authMode || process.env.SQUAD_COPILOT_AUTH_MODE || 'pat',
      isLive: true,
      clientKind: 'aca',
      env: process.env
    });
  }
  return { planPath, blockers, ready: blockers.length === 0 };
}

if (require.main === module) {
  try {
    const options = JSON.parse(process.argv[2]);
    const result = validateLocalInputs(options);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { validateLocalInputs };
