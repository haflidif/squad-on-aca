#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');


function usage() {
  return 'Usage: node infra/hooks/sandbox-lab-bootstrap.js --outputs <terraform-output.json> --repo <owner/repo> --environment <name> [--apply] [--allow-self-review]';
}

function parseArguments(args) {
  // Local lab values belong in the ignored infra/hooks/sandbox-lab.local.json, never in tracked defaults.
  const configPath = process.env.SANDBOX_LAB_CONFIG || require('node:path').join(__dirname, 'sandbox-lab.local.json');
  let local = {};
  if (fs.existsSync(configPath)) local = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const options = {
    repo: process.env.SANDBOX_LAB_REPO || local.repo,
    environment: process.env.SANDBOX_LAB_ENVIRONMENT || local.environment
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--allow-self-review') options.allowSelfReview = true;
    else if (['--outputs', '--repo', '--environment'].includes(args[i]) && args[i + 1]) {
      options[args[i].slice(2)] = args[++i];
    } else throw new Error(usage());
  }
  if (!options.outputs || !/^[^/\s]+\/[^/\s]+$/.test(options.repo || '') || !/^[A-Za-z0-9_-]+$/.test(options.environment || '')) throw new Error(usage());
  return options;
}

function readVariables(outputPath) {
  const outputs = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  const required = (key) => {
    if (typeof outputs[key]?.value !== 'string' || !outputs[key].value) throw new Error(`Missing Terraform output ${key}.`);
    return outputs[key].value;
  };
  const subscription = required('subscription_id');
  const guidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  for (const key of ['subscription_id', 'dispatcher_client_id', 'dispatcher_tenant_id', 'image_pull_client_id']) {
    if (!guidPattern.test(required(key))) throw new Error(`Terraform output ${key} must be a GUID.`);
  }
  return {
    SQUAD_SANDBOX_GROUP_NAME: required('sandbox_group_name'),
    SQUAD_SANDBOX_RESOURCE_GROUP_NAME: required('resource_group_name'),
    SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID: required('image_pull_client_id'),
    SQUAD_SANDBOX_AZURE_CLIENT_ID: required('dispatcher_client_id'),
    SQUAD_SANDBOX_AZURE_TENANT_ID: required('dispatcher_tenant_id'),
    SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID: subscription
  };
}

function runGhp(args, stdin) {
  const result = spawnSync('ghp', args, { encoding: 'utf8', input: stdin, shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) throw new Error(`ghp ${args[0]} failed: ${result.error?.message || result.stderr?.trim()}`);
  return result.stdout;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// GitHub reports prevent_self_review on the required_reviewers protection rule, not on the environment.
// allowSelfReview is an explicit single-maintainer test-tenant exception; the reviewer rule itself is still required.
function verifyEnvironment(environment, policies, manual, { allowSelfReview = false } = {}) {
  const rules = isObject(environment) ? environment.protection_rules : undefined;
  if (!Array.isArray(rules) || !rules.every(rule => isObject(rule) && typeof rule.type === 'string')) {
    throw new Error(`Environment protection rules are missing or malformed. ${manual}`);
  }
  const reviewerRules = rules.filter(rule => rule.type === 'required_reviewers');
  if (reviewerRules.length !== 1) {
    throw new Error(`Environment must have exactly one required reviewers rule. ${manual}`);
  }
  const [rule] = reviewerRules;
  const validReviewer = entry => isObject(entry) && ['User', 'Team'].includes(entry.type) &&
    isObject(entry.reviewer) && Number.isInteger(entry.reviewer.id);
  if (!Array.isArray(rule.reviewers) || rule.reviewers.length === 0 || !rule.reviewers.every(validReviewer)) {
    throw new Error(`Environment required reviewers rule must list at least one valid reviewer. ${manual}`);
  }
  if (typeof rule.prevent_self_review !== 'boolean' || (rule.prevent_self_review !== true && !allowSelfReview)) {
    throw new Error(`Environment required reviewers rule must prevent self-review. ${manual}`);
  }
  if (!isObject(environment.deployment_branch_policy) ||
      environment.deployment_branch_policy.custom_branch_policies !== true ||
      environment.deployment_branch_policy.protected_branches !== false ||
      environment.can_admins_bypass !== false) {
    throw new Error(`Environment is not verified as protected. ${manual}`);
  }
  // Requiring total_count === 1 === branch_policies.length also fails closed on any paginated or partial response.
  const list = isObject(policies) ? policies.branch_policies : undefined;
  const [policy] = Array.isArray(list) ? list : [];
  if (!Number.isInteger(policies?.total_count) || policies.total_count !== 1 ||
      !Array.isArray(list) || list.length !== policies.total_count ||
      !isObject(policy) || !Number.isInteger(policy.id) || policy.id <= 0 ||
      policy.name !== 'main' || policy.type !== 'branch') {
    throw new Error(`Environment must permit only the main branch. ${manual}`);
  }
}

function run(options) {
  const vars = readVariables(options.outputs);
  const manual = `Manually create ${options.repo} as a private repo and protect environment ${options.environment} with required reviewers, no self-approval and main-only deployment branches before setting variables.`;
  if (!options.apply) {
    console.log(`DRY RUN: ${manual}`);
    console.log(`Would set only protected environment variables: ${Object.keys(vars).join(', ')}.`);
    return;
  }
  let environment;
  let policies;
  try {
    environment = JSON.parse(runGhp(['api', `repos/${options.repo}/environments/${options.environment}`]));
    policies = JSON.parse(runGhp(['api', `repos/${options.repo}/environments/${options.environment}/deployment-branch-policies`]));
  } catch (error) {
    throw new Error(`Cannot verify the existing GitHub environment through ghp: ${error.message}. ${manual}`);
  }
  verifyEnvironment(environment, policies, manual, { allowSelfReview: options.allowSelfReview === true });
  if (options.allowSelfReview && environment.protection_rules.find(rule => rule.type === 'required_reviewers').prevent_self_review !== true) {
    console.warn('WARNING: self-review is allowed by explicit --allow-self-review (single-maintainer test tenant only).');
  }
  for (const [name, value] of Object.entries(vars)) {
    runGhp(['variable', 'set', name, '--repo', options.repo, '--env', options.environment, '--body', value]);
  }
  console.log(`Set ${Object.keys(vars).length} non-secret dispatch environment variables; image digest, CLI path, credentials and publisher configuration remain manual.`);
}

if (require.main === module) {
  try {
    run(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, readVariables, run, verifyEnvironment };
