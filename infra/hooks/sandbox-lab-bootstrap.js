#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const REPO = 'AzureViking/squad-on-aca-sandbox-lab';
const ENVIRONMENT = 'squad-sandbox-dispatch';
const SUBSCRIPTION = 'e69b8a95-fe38-42da-b5e6-e3e0a833cf9e';

function usage() {
  return 'Usage: node infra/hooks/sandbox-lab-bootstrap.js --outputs <terraform-output.json> --repo AzureViking/squad-on-aca-sandbox-lab --environment   squad-sandbox-dispatch [--apply] [--allow-self-review]';
}

function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--allow-self-review') options.allowSelfReview = true;
    else if (['--outputs', '--repo', '--environment'].includes(args[i]) && args[i + 1]) {
      options[args[i].slice(2)] = args[++i];
    } else throw new Error(usage());
  }
  if (!options.outputs || options.repo !== REPO || options.environment !== ENVIRONMENT) throw new Error(usage());
  return options;
}

function readVariables(outputPath) {
  const outputs = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  const required = (key) => {
    if (typeof outputs[key]?.value !== 'string' || !outputs[key].value) throw new Error(`Missing Terraform output ${key}.`);
    return outputs[key].value;
  };
  if (required('subscription_id') !== SUBSCRIPTION) throw new Error('Terraform outputs do not match approved subscription.');
  if (required('resource_group_name') !== 'rg-squad-aca-sandbox-lab') throw new Error('Terraform outputs do not match approved lab resource group.');
  if (required('sandbox_group_name') !== 'sbg-squad-aca-sandbox-lab') throw new Error('Terraform outputs do not match approved Sandbox Group.');
  if (!/^[-0-9a-f]{36}$/i.test(required('dispatcher_client_id')) ||
      !/^[-0-9a-f]{36}$/i.test(required('dispatcher_tenant_id'))) {
    throw new Error('Terraform outputs must include valid dispatcher client and tenant IDs.');
  }
  return {
    SQUAD_SANDBOX_GROUP_NAME: required('sandbox_group_name'),
    SQUAD_SANDBOX_AZURE_CLIENT_ID: required('dispatcher_client_id'),
    SQUAD_SANDBOX_AZURE_TENANT_ID: required('dispatcher_tenant_id'),
    SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID: SUBSCRIPTION
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
    throw new Error(`Environment must permit only the lab main branch. ${manual}`);
  }
}

function run(options) {
  const vars = readVariables(options.outputs);
  const manual = `Manually create ${REPO} as a private repo and protect environment ${ENVIRONMENT} with required reviewers, no self-approval and main-only deployment branches before setting variables.`;
  if (!options.apply) {
    console.log(`DRY RUN: ${manual}`);
    console.log(`Would set only protected environment variables: ${Object.keys(vars).join(', ')}.`);
    return;
  }
  let environment;
  let policies;
  try {
    environment = JSON.parse(runGhp(['api', `repos/${REPO}/environments/${ENVIRONMENT}`]));
    policies = JSON.parse(runGhp(['api', `repos/${REPO}/environments/${ENVIRONMENT}/deployment-branch-policies`]));
  } catch (error) {
    throw new Error(`Cannot verify the existing GitHub environment through ghp: ${error.message}. ${manual}`);
  }
  verifyEnvironment(environment, policies, manual, { allowSelfReview: options.allowSelfReview === true });
  if (options.allowSelfReview && environment.protection_rules.find(rule => rule.type === 'required_reviewers').prevent_self_review !== true) {
    console.warn('WARNING: self-review is allowed by explicit --allow-self-review (single-maintainer test tenant only).');
  }
  for (const [name, value] of Object.entries(vars)) {
    runGhp(['variable', 'set', name, '--repo', REPO, '--env', ENVIRONMENT, '--body', value]);
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
