const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateContract } = require('../contracts/aca-sandbox/v1/tools/validate');
const { assertIssueBinding, issueNumber: parseIssueNumber } = require('./lib/issue-binding');
const { validateSandboxImageRef } = require('./lib/sandbox-image');

const REPOSITORY_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required.`);
  return value.trim();
}

function parseBoolean(value, name) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function resolvePlanFile(repoRoot, userPath) {
  if (typeof userPath !== 'string' || userPath.length === 0) throw new Error('SQUAD_PLAN_PATH is required.');
  if (userPath.includes('\0') || userPath.includes('\\') || path.isAbsolute(userPath) || path.win32.isAbsolute(userPath)) {
    throw new Error('Plan path must be a relative POSIX path inside the checked-out repository.');
  }
  const parts = userPath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Plan path must not contain empty, dot, or parent segments.');
  }

  const root = path.resolve(repoRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Repository root must be a real directory.');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Plan path must not traverse symlinks: ${parts.slice(0, index + 1).join('/')}`);
    const isFinal = index === parts.length - 1;
    if (!isFinal && !stat.isDirectory()) throw new Error(`Plan path parent is not a directory: ${parts.slice(0, index + 1).join('/')}`);
    if (isFinal && !stat.isFile()) throw new Error('Plan path must resolve to a regular file.');
  }

  const resolved = path.resolve(current);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Plan path resolves outside the checked-out repository.');
  }
  return resolved;
}

function readExecutionPlan(repoRoot, planPath, checkedOutSha) {
  const resolvedPath = resolvePlanFile(repoRoot, planPath);
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Execution plan is not valid JSON: ${error.message}`);
  }
  if (plan.baseline_sha === '$CHECKED_OUT_SHA') {
    plan.baseline_sha = checkedOutSha;
    for (const task of plan.tasks || []) {
      if (task.baseline_sha === '$CHECKED_OUT_SHA') task.baseline_sha = checkedOutSha;
    }
  }
  const validation = validateContract('coordinator-execution.schema.json', plan);
  if (!validation.valid) throw new Error(`Execution plan is invalid: ${validation.errors.join('; ')}`);
  return { plan, planPath: resolvedPath };
}

function gitHead(repoRoot) {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not resolve checked-out commit: ${result.error?.message || result.stderr.trim()}`);
  }
  const sha = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Checked-out commit did not resolve to a full SHA.');
  return sha.toLowerCase();
}

function validateLiveSandboxConfig(env) {
  const required = [
    'SQUAD_SANDBOX_GROUP_NAME',
    'SQUAD_SANDBOX_AZURE_CLIENT_ID',
    'SQUAD_SANDBOX_AZURE_TENANT_ID',
    'SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID',
    'SQUAD_ACA_BIN',
    'SQUAD_SANDBOX_IMAGE_REF',
    'SQUAD_COPILOT_TOKEN'
  ];
  const missing = required.filter(name => typeof env[name] !== 'string' || env[name].trim() === '');
  if (missing.length) throw new Error(`Live sandbox configuration is incomplete: ${missing.join(', ')}.`);
  validateSandboxImageRef(env.SQUAD_SANDBOX_IMAGE_REF);
  if (!env.SQUAD_COPILOT_TOKEN.startsWith('github_pat_')) {
    throw new Error('SQUAD_COPILOT_TOKEN must be a fine-grained github_pat_ token.');
  }
  if (env.SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT !== '1') {
    throw new Error('Live ACA CLI behavior is unverified. Set SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT=1 only for a controlled manual probe.');
  }
  if (!path.isAbsolute(env.SQUAD_ACA_BIN)) throw new Error('SQUAD_ACA_BIN must be an absolute path to a pre-installed ACA CLI executable.');
  try {
    const stat = fs.statSync(env.SQUAD_ACA_BIN);
    fs.accessSync(env.SQUAD_ACA_BIN, fs.constants.X_OK);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw new Error('SQUAD_ACA_BIN must name an existing executable before Azure authentication.');
  }
}

function validateInputs(env, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const actualHead = gitHead(repoRoot);
  const expectedHead = requiredString(env.GITHUB_SHA, 'GITHUB_SHA').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(expectedHead) || actualHead !== expectedHead) {
    throw new Error('Checked-out HEAD does not match the workflow commit SHA.');
  }

  const repository = requiredString(env.SQUAD_REPOSITORY, 'SQUAD_REPOSITORY');
  if (!REPOSITORY_PATTERN.test(repository) || repository.includes('..') || repository.endsWith('.git')) {
    throw new Error('SQUAD_REPOSITORY must be a valid owner/repository value.');
  }
  if (repository !== requiredString(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY')) {
    throw new Error('SQUAD_REPOSITORY must exactly match the checked-out GitHub repository.');
  }
  if (repository === 'AzureViking/squad-on-aca-sandbox-lab' && env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('The lab workflow must run from its reviewed main branch.');
  }

  const issueNumber = parseIssueNumber(requiredString(env.SQUAD_ISSUE_NUMBER, 'SQUAD_ISSUE_NUMBER'));
  const mode = requiredString(env.SQUAD_EXECUTION_MODE, 'SQUAD_EXECUTION_MODE');
  if (!['fake', 'live'].includes(mode)) throw new Error('SQUAD_EXECUTION_MODE must be fake or live.');
  const liveSandbox = parseBoolean(env.SQUAD_ENABLE_SANDBOX_LIVE, 'SQUAD_ENABLE_SANDBOX_LIVE');
  const livePublish = parseBoolean(env.SQUAD_ENABLE_PUBLISH_LIVE, 'SQUAD_ENABLE_PUBLISH_LIVE');
  if (mode === 'fake' && (liveSandbox || livePublish)) {
    throw new Error('Fake mode cannot enable live sandbox execution or publication.');
  }
  if (mode === 'live' && !liveSandbox) throw new Error('Live mode requires the separate sandbox live opt-in.');
  if (mode === 'live' && repository === 'AzureViking/squad-on-aca-sandbox-lab' &&
    env.SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID !== 'e69b8a95-fe38-42da-b5e6-e3e0a833cf9e') {
    throw new Error('Lab live mode requires the approved Azure subscription.');
  }
  if (livePublish && (mode !== 'live' || !liveSandbox)) {
    throw new Error('Live publication requires live sandbox dispatch and the separate publish opt-in.');
  }
  if (repository === 'AzureViking/squad-on-aca-sandbox-lab' && livePublish) {
    throw new Error('Lab publication is disabled pending separate approval.');
  }

  const { plan, planPath } = readExecutionPlan(repoRoot, env.SQUAD_PLAN_PATH, actualHead);
  if (plan.baseline_sha.toLowerCase() !== actualHead) {
    throw new Error(`Plan baseline_sha ${plan.baseline_sha} does not match checked-out commit ${actualHead}.`);
  }
  assertIssueBinding(plan, repository, issueNumber, mode === 'live');
  if (mode === 'live' && plan.run_id === 'run-offline-smoke-template') {
    throw new Error('The checked-in offline smoke plan cannot be used for live dispatch.');
  }
  if (mode === 'live' && options.requireLiveSandboxConfig !== false) validateLiveSandboxConfig(env);
  return { repoRoot, planPath, plan, head: actualHead, repository, issueNumber, mode, liveSandbox, livePublish };
}

function assertPublishableSummary(summary, plan) {
  const validation = validateContract('dispatcher-summary.schema.json', summary);
  if (!validation.valid) throw new Error(`Dispatcher summary is invalid: ${validation.errors.join('; ')}`);
  if (summary.status !== 'succeeded') throw new Error('Dispatcher summary status must be succeeded.');
  if (!summary.integration || summary.integration.status !== 'succeeded') {
    throw new Error('Integration must have succeeded before publication.');
  }
  if (summary.run_id !== plan.run_id) throw new Error('Dispatcher summary run_id does not match the validated plan.');
  if (!summary.integration.integrated_patch_path) throw new Error('Dispatcher summary has no integrated patch path.');
  return summary;
}

function writeMaterializedPlan(destination, runnerTemp, plan) {
  const tempRoot = path.resolve(requiredString(runnerTemp, 'RUNNER_TEMP'));
  const target = path.resolve(requiredString(destination, 'SQUAD_MATERIALIZED_PLAN_PATH'));
  if (target !== path.join(tempRoot, 'validated-squad-plan.json')) {
    throw new Error('Materialized plan path must be the fixed file under RUNNER_TEMP.');
  }
  const rootStat = fs.lstatSync(tempRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('RUNNER_TEMP must be a real directory.');
  let fd;
  try {
    fd = fs.openSync(target, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw new Error(`Could not write the validated plan: ${error.message}`);
  }
  fs.closeSync(fd);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    fs.rmSync(target, { force: true });
    throw new Error('Materialized plan is not a private regular file.');
  }
  return target;
}

function resolveContainedFile(rootPath, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\\') || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative POSIX path.`);
  }
  const parts = relativePath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${label} contains an unsafe path segment.`);
  const root = path.resolve(rootPath);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse symlinks.`);
    const final = index === parts.length - 1;
    if (!final && !stat.isDirectory()) throw new Error(`${label} parent is not a directory.`);
    if (final && !stat.isFile()) throw new Error(`${label} must be a regular file.`);
  }
  const relative = path.relative(root, current);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside its output directory.`);
  }
  return current;
}

function stagePublishInputs(summaryPath, destination, plan) {
  const sourceSummaryPath = path.resolve(requiredString(summaryPath, 'SQUAD_SUMMARY_PATH'));
  const summary = assertPublishableSummary(readSummary(sourceSummaryPath), plan);
  const sourceRoot = path.dirname(sourceSummaryPath);
  const manifestSource = resolveContainedFile(sourceRoot, 'integration/artifact-manifest.json', 'Integration manifest');
  const patchSource = resolveContainedFile(sourceRoot, summary.integration.integrated_patch_path, 'Integrated patch');
  const targetRoot = path.resolve(requiredString(destination, 'SQUAD_PUBLISH_INPUT_DIR'));
  if (fs.existsSync(targetRoot)) throw new Error('Publish input staging directory must not already exist.');
  fs.mkdirSync(path.join(targetRoot, 'integration', 'patches'), { recursive: true });
  fs.copyFileSync(sourceSummaryPath, path.join(targetRoot, 'dispatcher-summary.json'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(manifestSource, path.join(targetRoot, 'integration', 'artifact-manifest.json'), fs.constants.COPYFILE_EXCL);
  const patchRelative = path.relative(sourceRoot, patchSource);
  const targetPatch = path.join(targetRoot, ...patchRelative.split(path.sep));
  fs.mkdirSync(path.dirname(targetPatch), { recursive: true });
  fs.copyFileSync(patchSource, targetPatch, fs.constants.COPYFILE_EXCL);
  return targetRoot;
}

function readSummary(summaryPath) {
  const resolved = path.resolve(requiredString(summaryPath, 'SQUAD_SUMMARY_PATH'));
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Dispatcher summary must be a regular, non-symlink file.');
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`Dispatcher summary is not valid JSON: ${error.message}`);
  }
}

function runCli(command, env = process.env) {
  const inputs = validateInputs(env, {
    requireLiveSandboxConfig: command === 'check' && env.SQUAD_PREFLIGHT_REQUIRE_LIVE_CONFIG === '1'
  });
  if (command === 'verify-summary') {
    assertPublishableSummary(readSummary(env.SQUAD_SUMMARY_PATH), inputs.plan);
    if (env.SQUAD_MATERIALIZED_PLAN_PATH) {
      writeMaterializedPlan(env.SQUAD_MATERIALIZED_PLAN_PATH, env.RUNNER_TEMP, inputs.plan);
    }
    console.log(`Dispatcher and integration succeeded for ${inputs.head}.`);
    return;
  }
  if (command === 'stage-publish-inputs') {
    stagePublishInputs(env.SQUAD_SUMMARY_PATH, env.SQUAD_PUBLISH_INPUT_DIR, inputs.plan);
    console.log('Only the validated summary and integration artifacts were staged.');
    return;
  }
  if (command !== 'check') throw new Error('Usage: node dispatcher/workflow-preflight.js check|verify-summary');
  if (env.SQUAD_MATERIALIZED_PLAN_PATH) {
    writeMaterializedPlan(env.SQUAD_MATERIALIZED_PLAN_PATH, env.RUNNER_TEMP, inputs.plan);
  }
  console.log(`Plan validated for checked-out commit ${inputs.head}.`);
}

if (require.main === module) {
  try {
    runCli(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  assertPublishableSummary,
  parseBoolean,
  readExecutionPlan,
  resolvePlanFile,
  stagePublishInputs,
  validateInputs,
  validateLiveSandboxConfig,
  writeMaterializedPlan
};
