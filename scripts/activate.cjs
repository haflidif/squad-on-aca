'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validate } = require('./backend-router.cjs');
const schema = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'backend', 'v1', 'schemas', `${name}.schema.json`), 'utf8'));
const LEGACY = ['SQUAD_ISSUE_FLOW_ENABLED', 'SQUAD_ISSUE_OPT_IN_NUMBER'];
function parse(text) { return JSON.parse(text.replace(/^\uFEFF/, '')); }
function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) throw new Error(`${bin} ${args[0]} failed. Check CLI installation, authentication and permissions.`);
  return result.stdout;
}
function unwrap(input, source) {
  if (source === 'terraform') {
    if (input && Object.hasOwn(input, 'platform_descriptor')) return input.platform_descriptor?.value;
    if (input && Object.hasOwn(input, 'value')) return input.value;
    return input;
  }
  if (source === 'azd') {
    const value = input.PLATFORM_DESCRIPTOR ?? input.PLATFORMDESCRIPTOR ?? input.platformDescriptor;
    return typeof value === 'string' ? parse(value) : value;
  }
  return input;
}
function validateDescriptor(value) {
  if (value == null) throw new Error('Missing or null platform descriptor. Set jobs_image_ref (azd SQUAD_JOBS_IMAGE_REF) for jobs, or sandbox_image_ref (azd SQUAD_SANDBOX_IMAGE_REF) for sandbox to registry/repository@sha256:<64 lowercase hex>. Reprovision to export it. Terraform enable_aca_sandbox=true is legacy mixed inventory and cannot emit an activation descriptor; use a separate destination.');
  for (const key of schema('platform-descriptor').required) {
    if (!Object.hasOwn(value, key)) throw new Error(`Descriptor missing ${key}. Export the complete platform_descriptor/platformDescriptor output.`);
  }
  if (['jobs', 'sandbox'].includes(value.backend)) {
    for (const key of schema('platform-descriptor').properties[value.backend].required) {
      if (!value[value.backend] || !Object.hasOwn(value[value.backend], key) || !value[value.backend][key]) {
        throw new Error(`Descriptor missing ${value.backend}.${key}. Reprovision the selected backend; nothing activated.`);
      }
    }
  }
  validate(value, schema('platform-descriptor'));
  return value;
}
function settings(descriptor) {
  const subscription = descriptor.platform_id.split('/')[2];
  const name = id => id.split('/').at(-1);
  const variables = {};
  if (descriptor.backend === 'jobs') Object.assign(variables, {
    SQUAD_AZURE_CLIENT_ID: descriptor.jobs.identity_client_id,
    SQUAD_AZURE_TENANT_ID: descriptor.tenant_id,
    SQUAD_AZURE_SUBSCRIPTION_ID: subscription,
    SQUAD_STORAGE_ACCOUNT: name(descriptor.jobs.storage_account_id),
    SQUAD_QUEUE_NAME: descriptor.jobs.queue_name
  });
  else Object.assign(variables, {
    SQUAD_SANDBOX_GROUP_NAME: name(descriptor.sandbox.group_id),
    SQUAD_SANDBOX_REGION: descriptor.location,
    SQUAD_SANDBOX_RESOURCE_GROUP_NAME: descriptor.sandbox.group_id.split('/')[4],
    SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID: descriptor.sandbox.image_pull_client_id,
    SQUAD_SANDBOX_AZURE_CLIENT_ID: descriptor.sandbox.dispatcher_client_id,
    SQUAD_SANDBOX_AZURE_TENANT_ID: descriptor.tenant_id,
    SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID: subscription,
    SQUAD_SANDBOX_IMAGE_REF: descriptor.sandbox.image_ref
  });
  variables.SQUAD_EXECUTION_BACKEND = descriptor.backend;
  return variables;
}
function safe(file, directory = false) {
  if (!fs.existsSync(file)) {
    try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error(`Unsafe activation path: ${file}`);
}
function legacy(root, env, extra) {
  const found = new Set(LEGACY.filter(key => Object.hasOwn(env, key)));
  if (extra) {
    const values = parse(fs.readFileSync(extra, 'utf8'));
    for (const key of LEGACY) if (Array.isArray(values) ? values.some(item => item.name === key) : Object.hasOwn(values, key)) found.add(key);
  }
  const workflows = path.join(root, '.github', 'workflows');
  if (fs.existsSync(workflows)) {
    safe(path.join(root, '.github'), true); safe(workflows, true);
    for (const entry of fs.readdirSync(workflows)) {
      if (!/\.ya?ml$/.test(entry)) continue;
      const file = path.join(workflows, entry); safe(file);
      const text = fs.readFileSync(file, 'utf8');
      for (const key of [...LEGACY, 'sandbox-run']) if (text.includes(key)) found.add(key);
    }
  }
  return [...found];
}
function activate(options, { env = process.env, log = console.log, execute = run } = {}) {
  const root = path.resolve(options.target || '.');
  if (options.enable && options.disable || options.preview && options.apply) throw new Error('Conflicting activation options.');
  const repo = options.repo || '<owner/repo>';
  if (options.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Expected --repo owner/repo.');
  if ((options.apply || options.enable) && !options.repo) throw new Error('--repo owner/repo is required for --apply or --enable.');
  const input = options.terraform ? parse(fs.readFileSync(options.terraform === '-' ? 0 : options.terraform, 'utf8'))
    : options.azdValues ? parse(fs.readFileSync(options.azdValues, 'utf8'))
      : options.azd ? (env.PLATFORM_DESCRIPTOR || env.PLATFORMDESCRIPTOR || env.platformDescriptor ? env : parse(execute('azd', ['env', 'get-values', '--output', 'json'])))
        : options.descriptor ? parse(fs.readFileSync(options.descriptor, 'utf8')) : null;
  const value = unwrap(input, options.terraform ? 'terraform' : options.azd || options.azdValues ? 'azd' : 'descriptor');
  if (value == null) {
    let missing = input?.platform_descriptor_missing?.value ?? input?.PLATFORM_DESCRIPTOR_MISSING ?? input?.platform_descriptor_missing;
    if (typeof missing === 'string') missing = parse(missing);
    if (Array.isArray(missing) && missing.length) throw new Error(`Descriptor unavailable. Missing: ${missing.join('; ')}. Reprovision; nothing activated.`);
  }
  const descriptor = validateDescriptor(value);
  const folder = path.join(root, '.squad');
  // Refuse links in existing ancestors, including a target reached through a junction.
  for (let current = root; ; current = path.dirname(current)) {
    safe(current, true); if (path.dirname(current) === current) break;
  }
  safe(folder, true);
  const executionFile = path.join(folder, 'execution.json');
  const platformFile = path.join(folder, 'platform.json');
  safe(executionFile); safe(platformFile);
  const old = fs.existsSync(executionFile) ? parse(fs.readFileSync(executionFile, 'utf8')) : null;
  if (old) validate(old, schema('execution'));
  const changedBinding = old && (old.platform_id !== descriptor.platform_id || (old.backend ?? 'jobs') !== descriptor.backend);
  if (changedBinding && old.enabled) throw new Error('Pause admission first: set enabled=false on the old binding, drain work, then bind the destination. In-flight receipts keep their backend.');
  const enabled = options.enable ? true : options.disable || changedBinding ? false : old?.enabled === true;
  if (enabled) {
    const identity = descriptor.backend === 'jobs' ? descriptor.jobs.identity_client_id : descriptor.sandbox.dispatcher_client_id;
    const subject = descriptor.backend === 'jobs' ? `repo:${repo}:ref:refs/heads/main` : `repo:${repo}:environment:squad-sandbox-issue`;
    if (!descriptor.oidc.some(item => item.client_id === identity && item.subject === subject)) throw new Error(`Missing OIDC binding ${subject} for the selected identity. Add target_repos/TARGET_REPOS and reprovision.`);
    if (descriptor.backend === 'sandbox' && !['squad-sandbox-issue', 'squad-publish'].every(item => descriptor.protected_environments.includes(item))) throw new Error('Missing protected environments squad-sandbox-issue and squad-publish.');
  }
  const retired = legacy(root, env, options.legacySettings);
  if (retired.length) log(`LEGACY SETTINGS DETECTED: ${retired.join(', ')}. Retire old issue ingress and sandbox-run requests; remove SQUAD_ISSUE_FLOW_ENABLED and SQUAD_ISSUE_OPT_IN_NUMBER after transferring settings ownership. They no longer authorize or restrict routing. Use squad:<member> (or squad for Sandbox), .squad/execution.json and the single router.`);
  log('Remote legacy variables are not queried by default. Inspect gh variable list --repo ' + repo + ' --json name,value, or pass its JSON with --legacy-settings.');
  const variables = settings(descriptor);
  if (descriptor.backend === 'sandbox') {
    variables.SQUAD_GITHUB_APP_ID = options.appId || env.GITHUB_APP_ID || '<APP_ID>';
    variables.SQUAD_GITHUB_APP_INSTALLATION_ID = options.installationId || env.GITHUB_APP_INSTALLATION_ID || '<INSTALLATION_ID>';
    for (const key of ['SQUAD_GITHUB_APP_ID', 'SQUAD_GITHUB_APP_INSTALLATION_ID']) {
      if (!/^[1-9][0-9]*$/.test(variables[key]) && !variables[key].startsWith('<')) throw new Error(`${key} must be a positive numeric ID.`);
    }
  }
  log(`OIDC bindings: ${JSON.stringify(descriptor.oidc)}. Protected environments: ${JSON.stringify(descriptor.protected_environments)}.`);
  log('GitHub repository variables (print-only unless --apply; set SQUAD_EXECUTION_BACKEND last):');
  for (const [key, value] of Object.entries(variables).sort(([a], [b]) => (a === 'SQUAD_EXECUTION_BACKEND') - (b === 'SQUAD_EXECUTION_BACKEND'))) log(`gh variable set ${key} --repo ${repo} --body ${JSON.stringify(value)}`);
  if (descriptor.backend === 'sandbox') {
    log(`Required secret: SQUAD_GITHUB_APP_PRIVATE_KEY_PEM in protected environment squad-publish. Set securely with the interactive command gh secret set SQUAD_GITHUB_APP_PRIVATE_KEY_PEM --repo ${repo} --env squad-publish. Secret values are never read or applied by this script. Jobs App/PAT secrets are not required for Sandbox.`);
    log('Require reviewers and trusted-branch restrictions on squad-sandbox-issue and squad-publish. Actions Copilot authentication uses github.token, not a repository PAT.');
  } else log(`No GitHub repository secrets required for Jobs OIDC queue dispatch. In Key Vault ${descriptor.jobs.key_vault_id}, separately configure github-app-private-key and copilot-pat for the worker.`);
  log('Verify OIDC subjects, environment protections, installed callers, roster and competing ingress before --enable. Commit both JSON files through review; no files are committed by activation.');
  const execution = { schema_version: 'backend/v1', platform_id: descriptor.platform_id, backend: descriptor.backend, enabled };
  const writes = [[platformFile, descriptor], [executionFile, execution]];
  // Refuse changes while already enabled, including a new image on the same platform.
  if (old?.enabled && (!fs.existsSync(platformFile) || fs.readFileSync(platformFile, 'utf8') !== JSON.stringify(descriptor, null, 2) + '\n') && !options.disable) throw new Error('Pause admission before changing the platform descriptor.');
  for (const [, value] of writes) if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') > 65536) throw new Error('Activation config exceeds the router 64 KiB limit.');
  if (options.apply) {
    if (Object.values(variables).some(value => value.startsWith('<'))) throw new Error('--apply requires --app-id and --installation-id for Sandbox (or GITHUB_APP_ID/GITHUB_APP_INSTALLATION_ID).');
    execute('gh', ['--version']);
    for (const [key, value] of Object.entries(variables).sort(([a], [b]) => (a === 'SQUAD_EXECUTION_BACKEND') - (b === 'SQUAD_EXECUTION_BACKEND'))) execute('gh', ['variable', 'set', key, '--repo', repo, '--body', value]);
  }
  for (const [file, value] of writes) {
    const bytes = JSON.stringify(value, null, 2) + '\n';
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === bytes) { log(`KEEP ${path.relative(root, file)}`); continue; }
    log(`${options.preview ? 'WOULD WRITE' : 'WRITE'} ${path.relative(root, file)}`);
    if (!options.preview) { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(file, bytes); }
  }
  log(`Backend ${descriptor.backend}; enabled=${enabled}. ${options.preview ? 'Preview only.' : 'Local binding prepared.'} GitHub ${options.apply ? 'variables applied; secrets and protections remain manual.' : 'unchanged.'}`);
  return { descriptor, execution, variables, legacy: retired };
}
function main(argv) {
  const options = {};
  const flags = { '--azd': 'azd', '--apply': 'apply', '--preview': 'preview', '--enable': 'enable', '--disable': 'disable' };
  const values = { '--terraform': 'terraform', '--azd-values': 'azdValues', '--descriptor': 'descriptor', '--target': 'target', '--repo': 'repo', '--legacy-settings': 'legacySettings', '--app-id': 'appId', '--installation-id': 'installationId' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (flags[arg]) options[flags[arg]] = true;
    else if (values[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) options[values[arg]] = argv[++index];
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  if ([options.terraform, options.azd, options.azdValues, options.descriptor].filter(Boolean).length !== 1) throw new Error('Choose exactly one input: --terraform <output.json|->, --azd, --azd-values <values.json>, or --descriptor <platform.json>.');
  activate(options);
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(`ACTIVATION_REJECTED ${error.message}`); process.exitCode = 1; } }
module.exports = { activate, validateDescriptor, unwrap, settings, legacy };
