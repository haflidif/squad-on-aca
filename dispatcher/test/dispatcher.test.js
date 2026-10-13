const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { runDispatcher } = require('../dispatcher');
const {
  AcaCliSandboxClient,
  getAzureAccessToken,
  commandFromArgv,
  parseCreatedSandboxId,
  setAndVerifyWindowsAcl
} = require('../clients/aca-cli-client');
const { createDiskImage, TOKEN_AUDIENCE } = require('../lib/aca-disk-image');
const { validateSandboxImageRef } = require('../lib/sandbox-image');
const { FakeSandboxClient } = require('../clients/fake-sandbox-client');
const { validateContract } = require('../../contracts/aca-sandbox/v1/tools/validate');
const { sha256Bytes } = require('../lib/util');

const repoRoot = path.resolve(__dirname, '..', '..');
const workRoot = path.join(__dirname, '.work');
// Actions sets GITHUB_REPOSITORY; tests that need the workflow-repository check set it explicitly.
delete process.env.GITHUB_REPOSITORY;

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

function git(args, cwd) {
  return run('git', args, { cwd });
}

function gitResult(args, options = {}) {
  return spawnSync('git', args, { cwd: options.cwd || repoRoot, encoding: options.encoding || 'utf8', env: options.env || process.env, shell: false, input: options.input });
}

function assertGitOk(args, options = {}) {
  const result = gitResult(args, options);
  assert.equal(result.status, 0, `git ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return String(result.stdout || '').trim();
}

function createBaselineBundle(name) {
  const { repo, baseline } = createRepo(name);
  const bundle = path.join(workRoot, name, 'baseline.bundle');
  git(['bundle', 'create', bundle, 'HEAD'], repo);
  return { repo, baseline, bundle };
}

function createRepo(name) {
  const repo = path.join(workRoot, name, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init'], repo);
  git(['config', 'user.name', 'Dispatcher Test'], repo);
  git(['config', 'user.email', 'dispatcher-test@example.invalid'], repo);
  for (const dir of ['alpha', 'beta', 'fail', 'dependent', 'violate', 'slow', 'mismatch']) {
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
    fs.writeFileSync(path.join(repo, dir, 'base.txt'), `${dir} baseline\n`);
  }
  git(['add', '.'], repo);
  git(['commit', '-m', 'baseline'], repo);
  return { repo, baseline: git(['rev-parse', 'HEAD'], repo) };
}

function member(id, capability = 'container') {
  return {
    logical_member_id: id,
    resolved_persistent_name: `Test ${id}`,
    charter_ref: `.squad/agents/${id}/charter.md`,
    membership: 'persona',
    capabilities: [capability]
  };
}

function planFor(baseline, tasks) {
  const members = [...new Map(tasks.map(task => [task.owner.logical_member_id, task.owner])).values()];
  return {
    schema_version: 'aca-sandbox/v1',
    run_id: `run-${Math.random().toString(16).slice(2)}`,
    provider: { id: 'test-provider', kind: 'aca-sandbox', contract_version: 'aca-sandbox-provider/v1' },
    baseline_sha: baseline,
    roster: {
      revision: 'test-roster-1',
      hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      members
    },
    tasks: tasks.map(task => ({
      task_id: task.task_id,
      owner: task.owner,
      objective: task.objective || `Complete ${task.task_id}`,
      required_capabilities: ['container'],
      dependencies: task.dependencies || [],
      baseline_sha: baseline,
      provider: { id: 'test-provider', kind: 'aca-sandbox', contract_version: 'aca-sandbox-provider/v1' },
      schema_version: 'aca-sandbox/v1',
      owned_paths: task.owned_paths
    }))
  };
}

function writePlan(dir, plan) {
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  return file;
}

function createFakeCopilot(dir) {
  const file = path.join(dir, 'fake-copilot.sh');
  fs.writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
node -e 'const assert=require("node:assert/strict"); assert.deepEqual(process.argv.slice(1), ["--yolo","--agent","squad","--max-ai-credits","30"])' -- "$@"
prompt="$(cat)"
: "\${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
if [[ -n "\${FAKE_COPILOT_ENV_FILE:-}" ]]; then
  env | sort > "\${FAKE_COPILOT_ENV_FILE}"
fi
case "\${prompt}" in
  *task-alpha*) mkdir -p alpha; printf 'alpha changed\\n' > alpha/result.txt ;;
  *task-beta*) mkdir -p beta; printf 'beta changed\\n' > beta/result.txt ;;
  *task-fail*) echo 'intentional failure' >&2; exit 7 ;;
  *task-dependent*) mkdir -p dependent; printf 'dependent changed\\n' > dependent/result.txt ;;
  *task-violate*) mkdir -p violate; printf 'claimed ok\\n' > violate/result.txt ;;
  *task-mismatch*) mkdir -p mismatch; printf 'mismatch changed\\n' > mismatch/result.txt ;;
  *task-slow*) sleep 2; mkdir -p slow; printf 'slow changed\\n' > slow/result.txt ;;
  *) echo 'unknown task' >&2; exit 2 ;;
esac
`, 'utf8');
  fs.chmodSync(file, 0o755);
  return file;
}

async function dispatchCase(name, tasks, options = {}) {
  const caseDir = path.join(workRoot, name);
  resetDir(caseDir);
  const repoInfo = createRepo(name);
  const repo = repoInfo.repo;
  let baseline = repoInfo.baseline;
  if (options.repoPatch) baseline = options.repoPatch(repo, baseline) || git(['rev-parse', 'HEAD'], repo);
  const fakeCopilot = createFakeCopilot(caseDir);
  const plan = planFor(baseline, tasks);
  if (options.planPatch) options.planPatch(plan);
  const planPath = writePlan(caseDir, plan);
  const outDir = path.join(caseDir, 'out');
  const oldBin = process.env.SQUAD_COPILOT_BIN;
  process.env.SQUAD_COPILOT_BIN = fakeCopilot;
  try {
    const client = options.client || new FakeSandboxClient({ root: path.join(caseDir, 'sandboxes'), onBeforeReadFile: options.onBeforeReadFile });
    const result = await runDispatcher({
      planPath,
      repoPath: repo,
      outDir,
      clientKind: 'fake',
      clientInstance: client,
      concurrency: options.concurrency || 3,
      config: { timeoutMs: options.timeoutMs || 20000, ...(options.config || {}) },
      ...(options.useEnvToken ? {} : { copilotToken: options.token || 'github_pat_testdispatcher' })
    });
    return { ...result, outDir, plan, client };
  } finally {
    if (oldBin === undefined) delete process.env.SQUAD_COPILOT_BIN;
    else process.env.SQUAD_COPILOT_BIN = oldBin;
  }
}

test.beforeEach(() => resetDir(workRoot));

test('invalid credit limits are rejected before sandbox create or bundle preparation', async () => {
  for (const maxAiCredits of [0, 29, null, '', '30 --yolo', '30;echo injected', '3e1', 30.5, Infinity, NaN, {}, Number.MAX_SAFE_INTEGER + 1]) {
    const owner = member('test-credit');
    let creates = 0;
    await assert.rejects(dispatchCase('invalid-credits', [
      { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
    ], { config: { maxAiCredits }, client: { create() { creates++; } } }), /max-ai-credits/);
    assert.equal(creates, 0);
    assert.equal(fs.existsSync(path.join(workRoot, 'invalid-credits', 'out')), false);
  }
});

test('happy path with two independent tasks produces valid summary and verified artifacts', async () => {
  const ownerA = member('test-alpha');
  const ownerB = member('test-beta');
  const { summary, outDir, client } = await dispatchCase('happy', [
    { task_id: 'task-alpha', owner: ownerA, owned_paths: ['alpha'] },
    { task_id: 'task-beta', owner: ownerB, owned_paths: ['beta'] }
  ], { timeoutMs: 120000 });
  assert.equal(summary.status, 'succeeded', JSON.stringify(summary, null, 2));
  assert.equal(summary.tasks.length, 2);
  assert(summary.tasks.every(task => task.status === 'succeeded'));
  assert.equal(summary.integration.status, 'succeeded');
  assert.equal(fs.existsSync(path.join(outDir, ...summary.integration.integrated_patch_path.split('/'))), true);
  assert.equal(validateContract('dispatcher-summary.schema.json', summary).valid, true);
  assert.equal(client.deleted.length, 3);
  for (const task of summary.tasks) {
    for (const rel of task.artifact_paths) assert.equal(fs.existsSync(path.join(outDir, ...rel.split('/'))), true);
  }
});

test('dependency on a failed task is skipped', async () => {
  const owner = member('test-fail');
  const { summary, client } = await dispatchCase('dependency-skip', [
    { task_id: 'task-fail', owner, owned_paths: ['fail'] },
    { task_id: 'task-dependent', owner, owned_paths: ['dependent'], dependencies: [{ task_id: 'task-fail', condition: 'successful' }] }
  ]);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.tasks.find(task => task.task_id === 'task-fail').status, 'failed');
  assert.equal(summary.tasks.find(task => task.task_id === 'task-dependent').status, 'skipped');
  assert.equal(summary.integration.status, 'skipped');
  assert.equal(client.deleted.length, 1);
});

test('one persona failure fails the execution and deletes the sandbox', async () => {
  const owner = member('test-fail');
  const { summary, client } = await dispatchCase('persona-failure', [
    { task_id: 'task-fail', owner, owned_paths: ['fail'] }
  ]);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.tasks[0].status, 'failed');
  assert.equal(summary.integration.status, 'skipped');
  assert.equal(client.deleted.length, 1);
});

test('dispatcher detects ownership violation even when sandbox result falsely claims success', async () => {
  let tampered = false;
  const hook = async (handle, remotePath, client) => {
    if (tampered || !remotePath.endsWith('persona-result.json')) return;
    tampered = true;
    const patch = Buffer.from('diff --git a/other/evil.txt b/other/evil.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/other/evil.txt\n@@ -0,0 +1 @@\n+evil\n');
    const patchPath = client.remoteToHost(handle, '/workspace/output/patches/task-violate.patch');
    fs.mkdirSync(path.dirname(patchPath), { recursive: true });
    fs.writeFileSync(patchPath, patch);
    const manifestPath = client.remoteToHost(handle, '/workspace/output/artifact-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const patchArtifact = manifest.artifacts.find(artifact => artifact.kind === 'patch');
    patchArtifact.sha256 = sha256Bytes(patch);
    patchArtifact.size_bytes = patch.length;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const owner = member('test-violate');
  const { summary } = await dispatchCase('ownership-tamper', [
    { task_id: 'task-violate', owner, owned_paths: ['violate'] }
  ], { onBeforeReadFile: hook });
  assert.equal(summary.status, 'failed');
  assert.match(summary.tasks[0].reason, /path ownership/);
});

test('sha256 mismatch fails', async () => {
  const hook = async (handle, remotePath, client) => {
    if (!remotePath.endsWith('patches/task-mismatch.patch')) return;
    fs.appendFileSync(client.remoteToHost(handle, remotePath), '\ntampered\n');
  };
  const owner = member('test-mismatch');
  const { summary } = await dispatchCase('sha-mismatch', [
    { task_id: 'task-mismatch', owner, owned_paths: ['mismatch'] }
  ], { onBeforeReadFile: hook });
  assert.equal(summary.status, 'failed');
  assert.match(summary.tasks[0].reason, /sha256 mismatch/);
});

test('token never appears in dispatcher output or logs', async () => {
  const token = 'github_pat_secretNeverWritten';
  const ownerA = member('test-alpha');
  const { outDir, summary } = await dispatchCase('token-redaction', [
    { task_id: 'task-alpha', owner: ownerA, owned_paths: ['alpha'] }
  ], { token });
  assert.equal(summary.status, 'succeeded');
  const stack = [outDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else assert.equal(fs.readFileSync(full, 'utf8').includes(token), false, `${full} contains token`);
    }
  }
});

test('runner environment is delivered through bootstrap stdin, not local spawn env', async () => {
  const owner = member('test-alpha');
  const client = new FakeSandboxClient({ root: path.join(workRoot, 'stdin-env', 'sandboxes') });
  const fakeEnvFile = path.join(workRoot, 'stdin-env', 'fake-copilot-env.txt');
  const oldAllowlist = process.env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST;
  const oldEnvFile = process.env.FAKE_COPILOT_ENV_FILE;
  process.env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST = 'FAKE_COPILOT_ENV_FILE';
  process.env.FAKE_COPILOT_ENV_FILE = fakeEnvFile;
  try {
    const token = 'github_pat_stdinOnlySecret';
    const { summary } = await dispatchCase('stdin-env', [
      { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
    ], { client, token });
    assert.equal(summary.status, 'succeeded');
    const runnerExec = client.execCalls.find(call => call.argv.some(arg => String(arg).endsWith('exec-with-env.js')));
    assert(runnerExec, 'runner exec should use the env bootstrap');
    assert.deepEqual(runnerExec.env, {});
    assert.equal(JSON.stringify(runnerExec.env).includes(token), false);
    assert.equal(JSON.stringify(runnerExec.env).includes('SQUAD_SOURCE_REPO_PATH'), false);
    const stdinPayload = JSON.parse(runnerExec.stdin);
    assert.equal(stdinPayload.SQUAD_COPILOT_TOKEN, token);
    assert.equal(stdinPayload.SQUAD_COPILOT_MAX_AI_CREDITS, '30');
    assert.equal(stdinPayload.SQUAD_SOURCE_REPO_PATH.length > 0, true);
    const fakeEnv = fs.readFileSync(fakeEnvFile, 'utf8');
    assert.match(fakeEnv, /^GITHUB_TOKEN=github_pat_stdinOnlySecret$/m);
    assert.doesNotMatch(fakeEnv, /^SQUAD_SOURCE_REPO_PATH=/m);
    assert.doesNotMatch(fakeEnv, /^SQUAD_OUTPUT_DIR=/m);
    assert.doesNotMatch(fakeEnv, /^SQUAD_COPILOT_MAX_AI_CREDITS=/m);
    const integrationExec = client.execCalls.find(call => call.argv.some(arg => String(arg).includes('integrate-run.sh')));
    assert(integrationExec, 'integration exec should use the env bootstrap');
    assert.deepEqual(integrationExec.env, {});
    assert.equal(integrationExec.stdin.includes('SQUAD_COPILOT_TOKEN'), false);
    assert.equal(integrationExec.stdin.includes('SQUAD_COPILOT_MAX_AI_CREDITS'), false);
    assert.equal(integrationExec.stdin.includes(token), false);
  } finally {
    if (oldAllowlist === undefined) delete process.env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST;
    else process.env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST = oldAllowlist;
    if (oldEnvFile === undefined) delete process.env.FAKE_COPILOT_ENV_FILE;
    else process.env.FAKE_COPILOT_ENV_FILE = oldEnvFile;
  }
});

test('dispatcher removes SQUAD_COPILOT_TOKEN from process env after startup', async () => {
  const owner = member('test-alpha');
  const oldToken = process.env.SQUAD_COPILOT_TOKEN;
  process.env.SQUAD_COPILOT_TOKEN = 'github_pat_parentEnvSecret';
  try {
    const { summary } = await dispatchCase('delete-parent-token', [
      { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
    ], { useEnvToken: true });
    assert.equal(summary.status, 'succeeded');
    assert.equal(Object.hasOwn(process.env, 'SQUAD_COPILOT_TOKEN'), false);
  } finally {
    if (oldToken === undefined) delete process.env.SQUAD_COPILOT_TOKEN;
    else process.env.SQUAD_COPILOT_TOKEN = oldToken;
  }
});

test('aca client strips credential variables from the local aca process environment', async () => {
  const caseDir = path.join(workRoot, 'aca-env-strip');
  resetDir(caseDir);
  const dumpFile = path.join(caseDir, 'aca-env.json');
  const stub = path.join(caseDir, 'aca-stub.js');
  fs.writeFileSync(stub, `const fs = require('node:fs');
fs.writeFileSync(process.env.ACA_ENV_DUMP_FILE, JSON.stringify(process.env, null, 2));
if (process.argv.includes('create')) process.stdout.write('{"ok":true}\\n');
`, 'utf8');
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  const oldGroup = process.env.SQUAD_SANDBOX_GROUP_NAME;
  const oldDump = process.env.ACA_ENV_DUMP_FILE;
  const oldSquadToken = process.env.SQUAD_COPILOT_TOKEN;
  const oldGitHubToken = process.env.GITHUB_TOKEN;
  const oldGhToken = process.env.GH_TOKEN;
  const oldCopilotGithub = process.env.COPILOT_GITHUB_TOKEN;
  const oldPat = process.env.GITHUB_PAT;
  const oldPassword = process.env.TEST_PASSWORD;
  const oldAzureSecret = process.env.AZURE_CLIENT_SECRET;
  const oldAzureClient = process.env.AZURE_CLIENT_ID;
  try {
    process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
    process.env.SQUAD_SANDBOX_GROUP_NAME = 'test-group';
    process.env.ACA_ENV_DUMP_FILE = dumpFile;
    process.env.SQUAD_COPILOT_TOKEN = 'github_pat_parentSecret';
    process.env.GITHUB_TOKEN = 'github_pat_githubSecret';
    process.env.GH_TOKEN = 'ghs_secret';
    process.env.COPILOT_GITHUB_TOKEN = 'github_pat_copilotSecret';
    process.env.GITHUB_PAT = 'github_pat_patSecret';
    process.env.TEST_PASSWORD = 'secret-password';
    process.env.AZURE_CLIENT_SECRET = 'azure-secret';
    process.env.AZURE_CLIENT_ID = 'azure-client-id';
    const client = new AcaCliSandboxClient({
      acaBin: process.execPath,
      acaBinArgs: [stub],
      image: `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`,
      group: 'test-group',
      resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6'
    });
    const sandboxId = 'cac12585-a69b-40e7-b0b7-a6a076fdce88';
    client.activeSandboxIds.add(sandboxId);
    await client.exec({ id: sandboxId }, ['true']);
    const env = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
    for (const key of ['SQUAD_COPILOT_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GITHUB_PAT', 'TEST_PASSWORD', 'AZURE_CLIENT_SECRET']) {
      assert.equal(Object.hasOwn(env, key), false, `${key} leaked to aca process`);
    }
    assert.equal(env.AZURE_CLIENT_ID, 'azure-client-id');
    assert.equal(env.SQUAD_ENABLE_ACA_SANDBOX, '1');
  } finally {
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('SQUAD_ENABLE_ACA_SANDBOX', oldEnable);
    restore('SQUAD_SANDBOX_GROUP_NAME', oldGroup);
    restore('ACA_ENV_DUMP_FILE', oldDump);
    restore('SQUAD_COPILOT_TOKEN', oldSquadToken);
    restore('GITHUB_TOKEN', oldGitHubToken);
    restore('GH_TOKEN', oldGhToken);
    restore('COPILOT_GITHUB_TOKEN', oldCopilotGithub);
    restore('GITHUB_PAT', oldPat);
    restore('TEST_PASSWORD', oldPassword);
    restore('AZURE_CLIENT_SECRET', oldAzureSecret);
    restore('AZURE_CLIENT_ID', oldAzureClient);
  }
});

test('live disk-image contract submits registry source, polls operation, and validates the returned id', async () => {
  const requests = [];
  const calls = [
    { status: 202, headers: { get: name => name === 'operation-location' ? '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/sandbox-rg/sandboxGroups/sandbox-group/diskimages/operations/op-123?api-version=2026-02-01-preview' : null } },
    { status: 202, json: async () => ({ status: 'Running' }) },
    { status: 200, json: async () => ({ status: 'Succeeded', diskImage: { id: '63561979-2a62-4cb9-bb0e-fdf96a8adad4' } }) }
  ];
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const diskId = await createDiskImage({
    imageUrl: image,
    managedIdentityClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
    subscriptionId: '00000000-0000-4000-8000-000000000001',
    resourceGroup: 'sandbox-rg',
    groupName: 'sandbox-group',
    name: 'disk-probe',
    getToken: async audience => {
      assert.equal(audience, TOKEN_AUDIENCE);
      return 'mocked-access-token-1234567890';
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return calls.shift();
    },
    pollIntervalMs: 0,
    sleep: async () => {}
  });
  assert.equal(diskId, '63561979-2a62-4cb9-bb0e-fdf96a8adad4');
  assert.equal(requests.length, 3);
  assert.match(requests[0].url, /^https:\/\/management\.swedencentral\.azuredevcompute\.io\/subscriptions\/00000000-0000-4000-8000-000000000001\/resourceGroups\/sandbox-rg\/sandboxGroups\/sandbox-group\/diskimages\/v2\/async\?api-version=2026-02-01-preview$/);
  assert.equal(requests[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    labels: { name: 'disk-probe' },
    source: { kind: 'registry', imageUrl: image, managedIdentityClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6' }
  });
  assert.ok(requests[0].options.headers.authorization.startsWith('Bearer '));
  assert.equal(requests[0].options.headers.authorization, 'Bearer mocked-access-token-1234567890');
  assert.equal(requests[1].options.method, 'GET');
});

test('sandbox image references stay inside the approved ACR repository and contain no credentials', () => {
  const digest = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  assert.equal(validateSandboxImageRef(digest), digest);
  for (const image of [
    'crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox:e5e721a',
    'https://crsquadacaa6b49feb.azurecr.io/squad/image:tag',
    'user:password@crsquadacaa6b49feb.azurecr.io/squad/image:tag',
    'other.azurecr.io/squad/image:tag',
    'crsquadacaa6b49feb.azurecr.io/other/image:tag',
    'crsquadacaa6b49feb.azurecr.io/squad/../image:tag',
    'crsquadacaa6b49feb.azurecr.io/squad/image:tag?query=1'
  ]) {
    assert.throws(() => validateSandboxImageRef(image), /immutable sha256 digest/);
  }
});

test('disk-image polling fails closed on operation failures, malformed responses, unsafe URLs, and timeout', async t => {
  const base = {
    imageUrl: `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`,
    managedIdentityClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
    subscriptionId: '00000000-0000-4000-8000-000000000001',
    resourceGroup: 'sandbox-rg',
    groupName: 'sandbox-group',
    name: 'disk-probe',
    getToken: async () => 'mocked-access-token-1234567890',
    pollIntervalMs: 0,
    sleep: async () => {}
  };
  const accepted = location => ({ status: 202, headers: { get: () => location } });
  const scopedOperationPath = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/sandbox-rg/sandboxGroups/sandbox-group/diskimages/operations/op';
  const operation = body => ({ status: 200, json: async () => body });
  const useFetch = (...responses) => async () => responses.shift();

  await t.test('terminal failure', async () => {
    await assert.rejects(createDiskImage({ ...base, fetchImpl: useFetch(
      accepted(scopedOperationPath),
      operation({ status: 'Failed' })
    ) }), /operation failed/);
  });
  await t.test('malformed success id', async () => {
    await assert.rejects(createDiskImage({ ...base, fetchImpl: useFetch(
      accepted(scopedOperationPath),
      operation({ status: 'Succeeded', diskImage: { id: 'not-a-uuid' } })
    ) }), /without a valid diskImage.id/);
  });
  await t.test('missing operation location', async () => {
    await assert.rejects(createDiskImage({ ...base, fetchImpl: useFetch({ status: 202, headers: { get: () => null } }) }), /missing operation-location/);
  });
  await t.test('cross-origin operation location', async () => {
    await assert.rejects(createDiskImage({ ...base, fetchImpl: useFetch(accepted(`https://evil.invalid${scopedOperationPath}`)) }), /outside the expected endpoint/);
  });
  await t.test('wrong resource scope', async () => {
    await assert.rejects(createDiskImage({
      ...base,
      fetchImpl: useFetch(accepted('/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/other-rg/sandboxGroups/sandbox-group/diskimages/operations/op'))
    }), /outside the expected endpoint/);
  });
  await t.test('wrong sandbox group scope', async () => {
    await assert.rejects(createDiskImage({
      ...base,
      fetchImpl: useFetch(accepted('/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/sandbox-rg/sandboxGroups/other-group/diskimages/operations/op'))
    }), /outside the expected endpoint/);
  });
  await t.test('malformed operation json', async () => {
    await assert.rejects(createDiskImage({ ...base, fetchImpl: useFetch(
      accepted(scopedOperationPath),
      { status: 200, json: async () => { throw new Error('bad json'); } }
    ) }), /malformed JSON/);
  });
  await t.test('timeout', async () => {
    await assert.rejects(createDiskImage({
      ...base,
      timeoutMs: 0,
      fetchImpl: useFetch(accepted(scopedOperationPath))
    }), /operation timed out/);
  });
  await t.test('poll request timeout', async () => {
    let pollCount = 0;
    await assert.rejects(createDiskImage({
      ...base,
      timeoutMs: 1000,
      requestTimeoutMs: 5,
      fetchImpl: async () => {
        if (pollCount++ === 0) return accepted(scopedOperationPath);
        return new Promise(() => {});
      }
    }), /polling request timed out/);
  });
  await t.test('invalid create status', async () => {
    await assert.rejects(createDiskImage({ ...base, fetchImpl: useFetch({ status: 401 }) }), /unexpected HTTP status 401/);
  });
});

test('Azure token acquisition uses the ACA audience without logging or forwarding the token', async () => {
  let captured;
  const token = await getAzureAccessToken({
    azBin: 'az-test',
    subscriptionId: 'sub-test',
    run: async (command, args) => {
      captured = { command, args };
      return { exitCode: 0, stdout: JSON.stringify({ accessToken: 'mocked-access-token-1234567890' }) };
    }
  });
  assert.equal(token, 'mocked-access-token-1234567890');
  assert.equal(captured.command, 'az-test');
  assert.deepEqual(captured.args, ['account', 'get-access-token', '--resource', TOKEN_AUDIENCE, '--subscription', 'sub-test', '--output', 'json']);
  await assert.rejects(getAzureAccessToken({ subscriptionId: 'sub-test', run: async () => ({ exitCode: 1, stdout: '', stderr: 'token leaked?' }) }), /acquisition failed/);
});

test('sandbox UUID output parsing fails closed and POSIX command quoting preserves argument boundaries', () => {
  const id = 'cac12585-a69b-40e7-b0b7-a6a076fdce88';
  const other = '63561979-2a62-4cb9-bb0e-fdf96a8adad4';
  const progress = `Creating sandbox ${id}...\n`;
  const created = `Created sandbox: ${id}\n`;
  assert.equal(parseCreatedSandboxId(created, progress), id);
  assert.equal(parseCreatedSandboxId(`Created sandbox: ${id}\r\n`, `Creating sandbox ${id}...\r\n`), id);
  assert.equal(parseCreatedSandboxId(`Created sandbox: ${id.toUpperCase()}`, `Creating sandbox ${id}...`), id);
  for (const [stdout, stderr] of [
    [`Creating sandbox ${id}...\nCreated sandbox: ${id}\n`, ''],
    [created, ''],
    ['', progress],
    [progress, created],
    [created, progress + progress],
    [created + created, progress],
    [created, `${progress}WARNING: something\n`],
    [`${created}extra\n`, progress],
    [`\n${created}`, progress],
    [created, `\n${progress}`],
    [`Created sandbox: ${other}\n`, progress],
    [`Created sandbox: not-a-uuid\n`, `Creating sandbox not-a-uuid...\n`],
    [`Created sandbox: ${id} \n`, progress],
    [` Created sandbox: ${id}\n`, progress],
    [`Created sandbox: ${id}\n`, `Creating sandbox ${id}\n`],
    [`\u001b[32mCreated sandbox: ${id}\u001b[0m\n`, progress],
    [`Created sandbox: 00000000-0000-0000-0000-000000000000\n`, `Creating sandbox 00000000-0000-0000-0000-000000000000...\n`],
    [undefined, progress]
  ]) {
    assert.throws(() => parseCreatedSandboxId(stdout, stderr), /output|UUID/, JSON.stringify([stdout, stderr]));
  }
  assert.equal(commandFromArgv(['printf', '%s', "x; $(touch SHOULD_NOT_EXIST) 'quoted'"]), "'printf' '%s' 'x; $(touch SHOULD_NOT_EXIST) '\\''quoted'\\'''");
  assert.throws(() => commandFromArgv(['printf', 'x\0y']), /NUL-free/);
});

test('ACA sandbox exec uses the actual ID and command-string CLI contract without stdin', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  try {
    const calls = [];
    const client = new AcaCliSandboxClient({
      image, group: 'test-group', resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      runProcess: async (command, args, options) => {
        calls.push({ command, args, options });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    const id = 'cac12585-a69b-40e7-b0b7-a6a076fdce88';
    client.activeSandboxIds.add(id);
    await client.exec({ id }, ['sh', '-lc', 'printf "%s" "$1"', 'sh', "a'b; echo not-injected"]);
    assert.deepEqual(calls[0].args, [
      '--region', 'swedencentral', '--subscription', '00000000-0000-4000-8000-000000000001', '--resource-group', 'test-rg',
      'sandbox', 'exec', '--group', 'test-group',
      '--id', id, '-c', "'sh' '-lc' 'printf \"%s\" \"$1\"' 'sh' 'a'\\''b; echo not-injected'"
    ]);
    assert.equal(Object.hasOwn(calls[0].options, 'stdin'), false);
    await assert.rejects(client.exec({ id }, ['cat'], { stdin: 'not forwarded' }), /stdin is unsupported/);
    await assert.rejects(client.exec({ id: 'persona-label' }, ['true']), /valid sandbox UUID/);
    await assert.rejects(client.delete({ id: '63561979-2a62-4cb9-bb0e-fdf96a8adad4' }), /not created by this ACA client/);
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});

test('ACA file transfer uses native fs cp in both directions and privately stages local files', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  const sandboxId = 'cac12585-a69b-40e7-b0b7-a6a076fdce88';
  const bytes = Buffer.from('harmless-transfer-probe');
  const localStagePaths = [];
  const calls = [];
  try {
    const client = new AcaCliSandboxClient({
      image, group: 'test-group', resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      runProcess: async (command, args, options) => {
        calls.push({ args, options });
        const cp = args.indexOf('cp');
        if (cp !== -1) {
          const source = args[cp + 3];
          const destination = args[cp + 4];
          if (source.startsWith(`${sandboxId}:`)) {
            fs.writeFileSync(destination, bytes);
          } else {
            localStagePaths.push(source);
            const stat = fs.statSync(source);
            if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0);
            assert.deepEqual(fs.readFileSync(source), bytes);
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    client.activeSandboxIds.add(sandboxId);
    await client.putFile({ id: sandboxId }, '/workspace/probe.bin', bytes);
    assert.deepEqual(await client.readFile({ id: sandboxId }, '/workspace/probe.bin'), bytes);
    const transfers = calls.filter(call => call.args.includes('cp'));
    assert.equal(transfers.length, 2);
    for (const call of transfers) {
      assert.deepEqual(call.args.slice(0, 11), ['--region', 'swedencentral', '--subscription', '00000000-0000-4000-8000-000000000001', '--resource-group', 'test-rg', 'sandbox', 'fs', 'cp', '--group', 'test-group']);
    }
    assert.equal(transfers[0].args.at(-1), `${sandboxId}:/workspace/probe.bin`);
    assert.equal(transfers[1].args.at(-2), `${sandboxId}:/workspace/probe.bin`);
    for (const call of transfers) {
      assert.equal(call.options.stdin, undefined);
      assert.equal(call.args.join(' ').includes(bytes.toString()), false);
    }
    assert.equal(localStagePaths.length, 1);
    assert.equal(fs.existsSync(localStagePaths[0]), false, 'staged upload file should be removed after transfer');
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});

test('runner environment is staged privately on verified tmpfs and removed without entering argv, env, or stdin', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  const sandboxId = 'cac12585-a69b-40e7-b0b7-a6a076fdce88';
  const token = 'github_pat_secret_only_in_staged_file';
  const calls = [];
  const stagedPaths = [];
  try {
    const client = new AcaCliSandboxClient({
      image, group: 'test-group', resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      runProcess: async (command, args, options) => {
        calls.push({ args, options });
        const cp = args.indexOf('cp');
        if (cp !== -1) {
          const localPath = args[cp + 3];
          stagedPaths.push(localPath);
          const contents = fs.readFileSync(localPath, 'utf8');
          assert.equal(JSON.parse(contents).SQUAD_COPILOT_TOKEN, token);
          if (process.platform !== 'win32') assert.equal(fs.statSync(localPath).mode & 0o077, 0);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    client.activeSandboxIds.add(sandboxId);
    const result = await client.execWithEnvironment(
      { id: sandboxId },
      ['node', '/opt/squad-sandbox/runner/exec-with-env.js', '/persona-run.sh'],
      { SQUAD_COPILOT_TOKEN: token, SQUAD_SOURCE_REPO_PATH: '/workspace/source', SQUAD_OUTPUT_DIR: '/workspace/output' },
      { timeoutMs: 30000 }
    );
    assert.equal(result.exitCode, 0);
    assert.equal(stagedPaths.length, 1);
    assert.equal(fs.existsSync(stagedPaths[0]), false, 'local secret staging file should be removed');
    const commandLines = calls.filter(call => call.args.includes('exec')).map(call => call.args.join(' '));
    assert(commandLines.some(line => line.includes('/dev/shm') && line.includes('tmpfs')));
    const runnerCommand = commandLines.find(line => line.includes('exec-with-env.js'));
    assert(runnerCommand && runnerCommand.includes('< "$env_file"'));
    assert(runnerCommand.includes('rm -f -- "$env_file"'));
    assert.equal(calls.some(call => call.args.join(' ').includes(token)), false);
    for (const call of calls) {
      assert.equal(call.options.stdin, undefined);
      assert.equal(call.options.env, undefined);
    }
    assert(commandLines.some(line => line.includes('rmdir --')));
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});

test('runner environment staging fails closed when tmpfs cannot be verified and still attempts cleanup', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  const calls = [];
  try {
    const client = new AcaCliSandboxClient({
      image, group: 'test-group', resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      runProcess: async (command, args, options) => {
        calls.push({ args, options });
        const shell = args[args.indexOf('-c') + 1] || '';
        if (shell.includes('/proc/mounts')) return { exitCode: 1, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    client.activeSandboxIds.add('cac12585-a69b-40e7-b0b7-a6a076fdce88');
    await assert.rejects(client.execWithEnvironment(
      { id: 'cac12585-a69b-40e7-b0b7-a6a076fdce88' },
      ['node', '/opt/squad-sandbox/runner/exec-with-env.js', 'runner.sh'],
      { SQUAD_COPILOT_TOKEN: 'github_pat_never_logged' }
    ), /verified \/dev\/shm tmpfs/);
    assert.equal(calls.some(call => call.args.includes('cp')), false);
    assert(calls.some(call => (call.args[call.args.indexOf('-c') + 1] || '').includes('rmdir --')));
    assert.equal(calls.some(call => call.args.join(' ').includes('github_pat_never_logged')), false);
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});

test('runner failure still triggers tmpfs cleanup and leaves the payload out of CLI arguments', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  const calls = [];
  const token = 'github_pat_runner_failure_secret';
  try {
    const client = new AcaCliSandboxClient({
      image, group: 'test-group', resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      runProcess: async (command, args, options) => {
        calls.push({ args, options });
        const shell = args[args.indexOf('-c') + 1] || '';
        if (shell.includes('exec-with-env.js')) return { exitCode: 23, stdout: '', stderr: '', timedOut: false };
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }
    });
    const id = 'cac12585-a69b-40e7-b0b7-a6a076fdce88';
    client.activeSandboxIds.add(id);
    const result = await client.execWithEnvironment(
      { id }, ['node', '/opt/squad-sandbox/runner/exec-with-env.js', '/persona-run.sh'],
      { SQUAD_COPILOT_TOKEN: token }
    );
    assert.equal(result.exitCode, 23);
    assert(calls.some(call => (call.args[call.args.indexOf('-c') + 1] || '').includes('trap')));
    assert(calls.some(call => (call.args[call.args.indexOf('-c') + 1] || '').includes('rmdir --')));
    assert.equal(calls.some(call => call.args.join(' ').includes(token)), false);
    assert.equal(calls.some(call => call.options.stdin !== undefined || call.options.env !== undefined), false);
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});

test('remote env cleanup failure after a failed fs cp is surfaced with the primary failure and no secret data', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  const calls = [];
  const token = 'github_pat_cp_then_cleanup_failure';
  try {
    const client = new AcaCliSandboxClient({
      image, group: 'test-group', resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      runProcess: async (command, args, options) => {
        calls.push({ args, options });
        if (args.includes('cp')) throw new Error(`transfer interrupted after partial write of ${token}`);
        const shell = args[args.indexOf('-c') + 1] || '';
        if (shell.includes('rm -f --') && !shell.includes('exec-with-env.js')) return { exitCode: 1, stdout: '', stderr: token, timedOut: false };
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }
    });
    const id = 'cac12585-a69b-40e7-b0b7-a6a076fdce88';
    client.activeSandboxIds.add(id);
    let caught;
    try {
      await client.execWithEnvironment(
        { id }, ['node', '/opt/squad-sandbox/runner/exec-with-env.js', '/persona-run.sh'],
        { SQUAD_COPILOT_TOKEN: token }
      );
    } catch (error) {
      caught = error;
    }
    assert(caught, 'execWithEnvironment should reject');
    assert.equal(caught.code, 'ACA_RUNNER_ENV_CLEANUP_FAILED');
    assert.match(caught.message, /runner environment cleanup failed/);
    assert.match(caught.message, /secret staging may remain in sandbox tmpfs/);
    assert.match(caught.message, /Primary failure: transfer interrupted/);
    assert.equal(caught.message.includes(token), false);
    assert(caught.primaryError, 'primary failure should stay attached');
    assert(calls.some(call => call.args.includes('cp')), 'staging copy should have been attempted');
    assert(calls.some(call => (call.args[call.args.indexOf('-c') + 1] || '').includes('rmdir --')), 'remote cleanup should be attempted');
    assert.equal(calls.some(call => (call.args[call.args.indexOf('-c') + 1] || '').includes('exec-with-env.js')), false);
    assert.equal(calls.some(call => call.args.join(' ').includes(token)), false);
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});

test('remote env cleanup failure after a successful runner is still reported', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  try {
    const client = new AcaCliSandboxClient({
      image, group: 'test-group', resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      runProcess: async (command, args) => {
        const shell = args[args.indexOf('-c') + 1] || '';
        if (shell.startsWith('rm -f --')) return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }
    });
    const id = 'cac12585-a69b-40e7-b0b7-a6a076fdce88';
    client.activeSandboxIds.add(id);
    await assert.rejects(client.execWithEnvironment(
      { id }, ['node', '/opt/squad-sandbox/runner/exec-with-env.js', '/persona-run.sh'],
      { SQUAD_COPILOT_TOKEN: 'github_pat_success_cleanup_failure' }
    ), error => error.code === 'ACA_RUNNER_ENV_CLEANUP_FAILED' && !error.message.includes('Primary failure') &&
      !error.message.includes('github_pat_success_cleanup_failure'));
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});

test('task and integration summaries report runner environment cleanup failures and still delete sandboxes', async () => {
  const cleanupMessage = 'ACA Sandbox runner environment cleanup failed; secret staging may remain in sandbox tmpfs until the sandbox is deleted. Primary failure: aca sandbox fs cp failed.';
  for (const target of ['persona-run.sh', 'integrate-run.sh']) {
    const owner = member('test-alpha');
    const name = `env-cleanup-${target.replace(/\W/g, '-')}`;
    const client = new FakeSandboxClient({ root: path.join(workRoot, name, 'sandboxes') });
    client.execWithEnvironment = async (handle, argv, env, options) => {
      if (argv.some(arg => String(arg).endsWith(target))) {
        const error = new Error(cleanupMessage);
        error.code = 'ACA_RUNNER_ENV_CLEANUP_FAILED';
        throw error;
      }
      return client.exec(handle, argv, { ...options, stdin: `${JSON.stringify(env)}\n` });
    };
    const { summary } = await dispatchCase(name, [
      { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
    ], { client });
    assert.equal(summary.status, 'failed');
    if (target === 'persona-run.sh') {
      assert.equal(summary.tasks[0].status, 'failed');
      assert.equal(summary.tasks[0].reason, cleanupMessage);
      assert.equal(summary.integration.status, 'skipped');
      assert.equal(client.deleted.length, 1);
    } else {
      assert.equal(summary.tasks[0].status, 'succeeded');
      assert.equal(summary.integration.status, 'failed');
      assert.equal(summary.integration.reason, cleanupMessage);
      assert.equal(summary.integration.failed_task_id || '', '');
      assert.equal(client.deleted.length, 2);
    }
  }
});
test('Windows staging ACL failure is fatal before any secret file is uploaded', async () => {
  await assert.rejects(setAndVerifyWindowsAcl('C:\\restricted\\payload', false, async () => ({
    exitCode: 1, stdout: '', stderr: 'access denied'
  })), /Unable to establish and verify a private Windows ACL/);
});

test('sandbox create parses the generated UUID and uses the real CLI create, exec, transfer, and delete APIs', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  try {
    process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
    const createCalls = [];
    let diskCreates = 0;
    const client = new AcaCliSandboxClient({
      image,
      group: 'test-group',
      resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      createDiskImage: async () => { diskCreates += 1; return '63561979-2a62-4cb9-bb0e-fdf96a8adad4'; },
      runProcess: async (command, args, options) => {
        createCalls.push({ command, args, options });
        return {
          exitCode: 0,
          stdout: 'Created sandbox: cac12585-a69b-40e7-b0b7-a6a076fdce88\n',
          stderr: 'Creating sandbox cac12585-a69b-40e7-b0b7-a6a076fdce88...\n'
        };
      }
    });

    const handle = await client.create({ name: 'persona-sandbox', image, cpu: '1000m', memory: '2048Mi', labels: { task_id: 'task-1' } });
    assert.equal(handle.diskId, '63561979-2a62-4cb9-bb0e-fdf96a8adad4');
    assert.equal(diskCreates, 1);
    assert.equal(createCalls.length, 1);
    assert.equal(handle.id, 'cac12585-a69b-40e7-b0b7-a6a076fdce88');
    assert.equal(handle.name, handle.id);
    assert.deepEqual(createCalls[0].args, [
      '--region', 'swedencentral', '--subscription', '00000000-0000-4000-8000-000000000001', '--resource-group', 'test-rg',
      'sandbox', 'create', '--group', 'test-group',
      '--disk-id', '63561979-2a62-4cb9-bb0e-fdf96a8adad4',
      '--cpu', '1000m', '--memory', '2048Mi', '--label', 'task_id=task-1',
      '--label', `squad_name=persona-sandbox-${require('node:crypto').createHash('sha256').update('persona-sandbox').digest('hex').slice(0, 16)}`
    ]);
    assert.equal(createCalls[0].args.includes('--name'), false);
    assert.equal(createCalls[0].args.includes('--disk'), false);
    await client.delete(handle);
    assert.deepEqual(createCalls[1].args, [
      '--region', 'swedencentral', '--subscription', '00000000-0000-4000-8000-000000000001', '--resource-group', 'test-rg',
      'sandbox', 'delete',
      '--group', 'test-group', '--id', handle.id, '--yes'
    ]);
    await assert.rejects(client.create({
      name: 'wrong-image',
      image: `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'b'.repeat(64)}`
    }), /does not match/);
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});

test('every ACA CLI command is pinned to subscription and resource group, and failures carry redacted diagnostics', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  const base = {
    image, group: 'sbg-squad-aca-sandbox-lab', resourceGroup: 'rg-squad-aca-sandbox-lab',
    subscriptionId: 'e69b8a95-fe38-42da-b5e6-e3e0a833cf9e',
    imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
    createDiskImage: async () => '63561979-2a62-4cb9-bb0e-fdf96a8adad4'
  };
  const pinned = ['--region', 'swedencentral', '--subscription', 'e69b8a95-fe38-42da-b5e6-e3e0a833cf9e', '--resource-group', 'rg-squad-aca-sandbox-lab'];
  try {
    const calls = [];
    const id = 'cac12585-a69b-40e7-b0b7-a6a076fdce88';
    const client = new AcaCliSandboxClient({
      ...base,
      runProcess: async (command, args) => {
        calls.push(args);
        if (args.includes('cp')) {
          const destination = args.at(-1);
          if (!destination.startsWith(`${id}:`)) fs.writeFileSync(destination, 'x');
        }
        if (args.includes('create')) return { exitCode: 0, stdout: `Created sandbox: ${id}\n`, stderr: `Creating sandbox ${id}...\n` };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    const handle = await client.create({ name: 'pin-check', image });
    await client.exec(handle, ['true']);
    await client.putFile(handle, '/workspace/pin.txt', Buffer.from('x'));
    await client.readFile(handle, '/workspace/pin.txt');
    await client.delete(handle);
    await client.deleteDiskImage();
    for (const verb of ['create', 'exec', 'cp', 'delete']) assert(calls.some(args => args.includes(verb)), `${verb} should run`);
    assert(calls.some(args => args.includes('sandboxgroup')));
    for (const args of calls) assert.deepEqual(args.slice(0, 6), pinned);

    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
    const failing = new AcaCliSandboxClient({
      ...base,
      runProcess: async () => ({
        exitCode: 3, stdout: '',
        stderr: `ERROR: (AuthorizationFailed) no access to resource group\nAuthorization: Bearer ${jwt} github_pat_abc123 https://x/?sig=abcdef`
      })
    });
    let caught;
    try { await failing.create({ name: 'fail-check', image }); } catch (error) { caught = error; }
    assert(caught);
    assert.match(caught.message, /^aca sandbox create failed \(exit code 3\): ERROR: \(AuthorizationFailed\) no access to resource group/);
    for (const secret of [jwt, 'github_pat_abc123', 'sig=abcdef']) assert.equal(caught.message.includes(secret), false, secret);
    assert(caught.message.length < 500);

    for (const bad of [
      { subscriptionId: 'sub-test' },
      { resourceGroup: 'bad rg' },
      { resourceGroup: 'ends-with-dot.' },
      { group: '--subscription' }
    ]) {
      assert.throws(() => new AcaCliSandboxClient({ ...base, ...bad, runProcess: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), /SQUAD_SANDBOX_/);
    }
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});
test('sandbox create rejects reserved or malformed labels before any disk or CLI call', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  let diskCalls = 0;
  const calls = [];
  try {
    const client = new AcaCliSandboxClient({
      image, group: 'test-group', resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      createDiskImage: async () => { diskCalls += 1; return '63561979-2a62-4cb9-bb0e-fdf96a8adad4'; },
      runProcess: async (command, args) => { calls.push(args); return { exitCode: 1, stdout: '', stderr: '' }; }
    });
    for (const labels of [
      { squad_name: 'override' },
      { 'bad key': 'x' },
      { task_id: 'a,b' },
      { task_id: 'a=b' },
      { task_id: 'line\nbreak' },
      { task_id: 'x'.repeat(257) }
    ]) {
      await assert.rejects(client.create({ name: 'label-check', image, labels }), /Sandbox label/);
    }
    assert.equal(diskCalls, 0);
    assert.equal(calls.length, 0);
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});
test('malformed create output blocks disk deletion because sandbox creation is uncertain', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  const calls = [];
  try {
    const client = new AcaCliSandboxClient({
      image, group: 'test-group', resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      createDiskImage: async () => '63561979-2a62-4cb9-bb0e-fdf96a8adad4',
      runProcess: async (command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: 'Created sandbox: not-a-uuid\n', stderr: '' };
      }
    });
    await assert.rejects(client.create({ name: 'uncertain-create', image }), /(malformed output|invalid.*UUID).*may have been created in group test-group/);
    await assert.rejects(client.deleteDiskImage(), /cleanup is incomplete/);
    assert.equal(calls.some(args => args.includes('sandboxgroup')), false);
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});

test('disk-image deletion targets only the returned UUID and waits for CLI completion', async () => {
  const image = `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:${'a'.repeat(64)}`;
  const commands = [];
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
  try {
    const client = new AcaCliSandboxClient({
      image,
      group: 'test-group',
      resourceGroup: 'test-rg',
      subscriptionId: '00000000-0000-4000-8000-000000000001',
      imagePullClientId: '44b56c1f-08c0-4223-9c9e-398cc9267fb6',
      createDiskImage: async () => '63561979-2a62-4cb9-bb0e-fdf96a8adad4',
      runProcess: async (command, args, options) => {
        commands.push({ command, args, options });
        return {
          exitCode: 0,
          stdout: 'Created sandbox: cac12585-a69b-40e7-b0b7-a6a076fdce88\n',
          stderr: 'Creating sandbox cac12585-a69b-40e7-b0b7-a6a076fdce88...\n'
        };
      }
    });
    const sandbox = await client.create({ name: 'sandbox-1', image });
    await assert.rejects(client.deleteDiskImage(), /sandbox cleanup is incomplete/);
    await client.delete(sandbox);
    await client.deleteDiskImage();
    const deleteCalls = commands.filter(call => call.args.includes('sandboxgroup') && call.args.includes('delete'));
    assert.equal(deleteCalls.length, 1);
    assert.deepEqual(deleteCalls[0].args, [
      '--region', 'swedencentral',
      '--subscription', '00000000-0000-4000-8000-000000000001', '--resource-group', 'test-rg',
      'sandboxgroup', 'disk', 'delete', '--group', 'test-group',
      '--id', '63561979-2a62-4cb9-bb0e-fdf96a8adad4',
      '--wait-timeout', '180'
    ]);
    assert.equal(deleteCalls[0].options.timeoutMs, 210000);
    assert.equal(client.diskImageId, null);
    await client.deleteDiskImage();
    assert.equal(commands.filter(call => call.args.includes('sandboxgroup') && call.args.includes('delete')).length, 1);
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
  }
});

test('dispatcher reports disk-image cleanup failures after all sandbox deletions', async () => {
  const name = 'disk-image-cleanup-failure';
  const client = new FakeSandboxClient({ root: path.join(workRoot, name, 'sandboxes') });
  client.deleteDiskImage = async () => {
    assert.equal(client.deleted.length, client.created.length);
    throw new Error('disk image cleanup failed');
  };
  const owner = member('test-alpha');
  const { summary } = await dispatchCase(name, [
    { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
  ], { client });
  assert.equal(summary.status, 'failed');
  assert.equal(summary.disk_image_deletion_error, 'disk image cleanup failed');
  assert.equal(client.deleted.length, client.created.length);
});

test('dispatcher retains disk-image when sandbox deletion fails', async () => {
  const name = 'retain-disk-on-sandbox-delete-failure';
  const client = new FakeSandboxClient({ root: path.join(workRoot, name, 'sandboxes') });
  client.delete = async handle => {
    client.deleted.push(handle.id);
    throw new Error('sandbox delete failed');
  };
  let diskDeleteCalled = false;
  client.deleteDiskImage = async () => { diskDeleteCalled = true; };
  const owner = member('test-alpha');
  const { summary } = await dispatchCase(name, [
    { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
  ], { client });
  assert.equal(diskDeleteCalled, false);
  assert.equal(summary.status, 'failed');
  assert.match(summary.disk_image_deletion_error, /retained because one or more sandbox deletions failed/);
  assert.match(summary.tasks[0].deletion_error, /sandbox delete failed/);
});

test('dispatcher rejects unsafe artifact manifest paths', async () => {
  const cases = [
    ['artifact-traversal', '../escape.txt', /artifact-manifest validation failed|unsafe artifact path/],
    ['artifact-absolute', '/escape.txt', /artifact-manifest validation failed|unsafe artifact path/],
    ['artifact-backslash', 'logs\\escape.txt', /artifact-manifest validation failed|unsafe artifact path/],
    ['artifact-reserved-name', 'logs/CON.txt', /artifact-manifest validation failed|reserved device/i],
    ['artifact-superscript-reserved-name', 'logs/COM¹.txt', /artifact-manifest validation failed|reserved device/i],
    ['artifact-trailing-dot', 'logs/name.', /artifact-manifest validation failed|dot or space/i],
    ['artifact-colon', 'logs/name:stream.txt', /artifact-manifest validation failed|colon|invalid format/i],
    ['artifact-control', 'logs/name\u0001.txt', /artifact-manifest validation failed|control|invalid format/i]
  ];
  for (const [name, badPath, expected] of cases) {
    const hook = async (handle, remotePath, client) => {
      if (!remotePath.endsWith('artifact-manifest.json')) return;
      const manifestPath = client.remoteToHost(handle, remotePath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.artifacts.push({
        artifact_id: `bad-${name}`,
        kind: 'log',
        path: badPath,
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        size_bytes: 1
      });
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    };
    const owner = member('test-alpha');
    const { summary } = await dispatchCase(name, [
      { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
    ], { onBeforeReadFile: hook });
    assert.equal(summary.status, 'failed');
    assert.match(summary.tasks[0].reason, expected);
  }
});

test('dispatcher rejects case-insensitive artifact path collisions', async () => {
  const hook = async (handle, remotePath, client) => {
    if (!remotePath.endsWith('artifact-manifest.json')) return;
    const manifestPath = client.remoteToHost(handle, remotePath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.push({
      artifact_id: 'colliding-log',
      kind: 'log',
      path: 'PATCHES/TASK-ALPHA.PATCH',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      size_bytes: 1
    });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const owner = member('test-alpha');
  const { summary } = await dispatchCase('artifact-case-collision', [
    { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
  ], { onBeforeReadFile: hook });
  assert.equal(summary.status, 'failed');
  assert.match(summary.tasks[0].reason, /path collision|collides/i);
});

test('dispatcher refuses to write artifacts through pre-planted symlink directories', async () => {
  const owner = member('test-alpha');
  const outDirHolder = {};
  const hook = async (handle, remotePath) => {
    if (!remotePath.endsWith('artifact-manifest.json')) return;
    const taskOut = path.join(outDirHolder.outDir, 'tasks', 'task-alpha');
    fs.mkdirSync(taskOut, { recursive: true });
    const external = path.join(workRoot, 'artifact-symlink', 'external');
    fs.mkdirSync(external, { recursive: true });
    const link = path.join(taskOut, 'patches');
    if (!fs.existsSync(link)) fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  };
  const caseDir = path.join(workRoot, 'artifact-symlink');
  outDirHolder.outDir = path.join(caseDir, 'out');
  const { summary } = await dispatchCase('artifact-symlink', [
    { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
  ], { onBeforeReadFile: hook });
  assert.equal(summary.status, 'failed');
  assert.match(summary.tasks[0].reason, /symlink|file already exists/i);
});

test('dispatcher rejects oversized artifacts declared by the manifest', async () => {
  const hook = async (handle, remotePath, client) => {
    if (!remotePath.endsWith('artifact-manifest.json')) return;
    const manifestPath = client.remoteToHost(handle, remotePath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const patchArtifact = manifest.artifacts.find(artifact => artifact.kind === 'patch');
    patchArtifact.size_bytes = 10 * 1024 * 1024 + 1;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const owner = member('test-alpha');
  const { summary } = await dispatchCase('artifact-oversize', [
    { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
  ], { onBeforeReadFile: hook });
  assert.equal(summary.status, 'failed');
  assert.match(summary.tasks[0].reason, /size limit/);
});

test('ghp token is rejected up front', async () => {
  const owner = member('test-alpha');
  await assert.rejects(
    dispatchCase('ghp-reject', [{ task_id: 'task-alpha', owner, owned_paths: ['alpha'] }], { token: 'ghp_classicbad' }),
    /Classic GitHub PAT \(ghp_\) is not supported/
  );
});

test('sandbox delete is called on timeout', async () => {
  const owner = member('test-slow');
  const { summary, client } = await dispatchCase('timeout-delete', [
    { task_id: 'task-slow', owner, owned_paths: ['slow'] }
  ], { timeoutMs: 200 });
  assert.equal(summary.status, 'failed');
  assert.match(summary.tasks[0].reason, /timed out|persona-result|terminated/i);
  assert.equal(client.deleted.length, 1);
});

test('aca client refuses without the enable flag', () => {
  const result = spawnSync('node', ['dispatcher/cli.js', '--plan', 'missing.json', '--repo', '.', '--out', 'out', '--client', 'aca'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, SQUAD_ENABLE_ACA_SANDBOX: '' }
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /SQUAD_ENABLE_ACA_SANDBOX=1/);
});

test('direct ACA dispatch rejects missing or mismatched plan issue bindings before client calls', async () => {
  const caseDir = path.join(workRoot, 'aca-binding');
  resetDir(caseDir);
  const { repo, baseline } = createRepo('aca-binding');
  const plan = planFor(baseline, [{ task_id: 'task-alpha', owner: member('test-alpha'), owned_paths: ['alpha'] }]);
  const planPath = writePlan(caseDir, plan);
  let clientCalls = 0;
  const options = {
    planPath, repoPath: repo, outDir: path.join(caseDir, 'out'), clientKind: 'aca',
    repoFullName: 'example/repo', issueNumber: '42', copilotToken: 'github_pat_testdispatcher',
    clientInstance: { createSandbox() { clientCalls += 1; throw new Error('client was reached'); } }
  };
  await assert.rejects(runDispatcher(options), /requires a plan issue binding/);
  for (const [binding, override] of [
    [{ repo: 'other/repo', issue_number: 42 }, {}],
    [{ repo: 'example/repo', issue_number: 43 }, {}],
    [{ repo: 'example/repo', issue_number: 42 }, { issueNumber: '4e1' }]
  ]) {
    fs.writeFileSync(planPath, JSON.stringify({ ...plan, issue: binding }));
    await assert.rejects(runDispatcher({ ...options, ...override }), /does not match|decimal integer/);
  }
  assert.equal(clientCalls, 0);
});

test('concurrency limit is honored', async () => {
  const owner = member('test-alpha');
  const client = new FakeSandboxClient({ root: path.join(workRoot, 'concurrency', 'sandboxes') });
  const { summary } = await dispatchCase('concurrency', [
    { task_id: 'task-alpha', owner, owned_paths: ['alpha'] },
    { task_id: 'task-beta', owner, owned_paths: ['beta'] },
    { task_id: 'task-violate', owner, owned_paths: ['violate'] },
    { task_id: 'task-mismatch', owner, owned_paths: ['mismatch'] }
  ], { client, concurrency: 2, timeoutMs: 120000 });
  assert.equal(summary.status, 'succeeded');
  assert(client.maxActiveExecs <= 2, `max active execs ${client.maxActiveExecs} exceeded concurrency 2`);
});


test('integration failing check fails execution, captures output, and deletes sandbox', async () => {
  const owner = member('test-alpha');
  const client = new FakeSandboxClient({ root: path.join(workRoot, 'integration-check-fail', 'sandboxes') });
  const { summary } = await dispatchCase('integration-check-fail', [
    { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
  ], {
    client,
    planPatch(plan) {
      plan.integration = {
        check_commands: [{ name: 'failing-check', argv: [process.execPath, '-e', 'console.log("integration stdout"); console.error("integration stderr"); process.exit(9)'] }]
      };
    }
  });
  assert.equal(summary.status, 'failed');
  assert.equal(summary.integration.status, 'failed');
  assert.match(summary.integration.reason, /failing-check|exit code 9/);
  assert.equal(client.deleted.length, 2);
});

test('integration sandbox is deleted on timeout', async () => {
  const owner = member('test-alpha');
  const client = new FakeSandboxClient({ root: path.join(workRoot, 'integration-timeout', 'sandboxes') });
  const originalExec = client.exec.bind(client);
  client.exec = async (handle, argv, options) => {
    if (argv.some(arg => String(arg).includes('integrate-run.sh'))) {
      client.execCalls.push({ argv, env: { ...(options?.env || {}) }, stdin: options?.stdin || '' });
      return { exitCode: 124, stdout: '', stderr: 'timed out', timedOut: true };
    }
    return originalExec(handle, argv, options);
  };
  const { summary } = await dispatchCase('integration-timeout', [
    { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
  ], { client });
  assert.equal(summary.status, 'failed');
  assert.match(summary.integration.reason, /timed out/);
  assert.equal(client.deleted.length, 2);
});

test('integration output tamper fails dispatcher verification and deletes sandbox', async () => {
  let tampered = false;
  const hook = async (handle, remotePath, client) => {
    if (tampered || !remotePath.endsWith('patches/integrated.patch')) return;
    tampered = true;
    fs.appendFileSync(client.remoteToHost(handle, remotePath), '\ntampered\n');
  };
  const owner = member('test-alpha');
  const client = new FakeSandboxClient({ root: path.join(workRoot, 'integration-tamper', 'sandboxes'), onBeforeReadFile: hook });
  const { summary } = await dispatchCase('integration-tamper', [
    { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
  ], { client });
  assert.equal(summary.status, 'failed');
  assert.match(summary.integration.reason, /sha256 mismatch/);
  assert.equal(client.deleted.length, 2);
});

test('dispatcher rejects integrated patch content drift with the same path set', async () => {
  let tampered = false;
  const hook = async (handle, remotePath, client) => {
    if (tampered || !remotePath.endsWith('integration-result.json')) return;
    const patchPath = client.remoteToHost(handle, '/workspace/output/patches/integrated.patch');
    if (!fs.existsSync(patchPath)) return;
    tampered = true;
    const patch = fs.readFileSync(patchPath, 'utf8').replace('alpha changed', 'alpha tampered');
    fs.writeFileSync(patchPath, patch);
    const patchBytes = Buffer.from(patch);
    const patchSha = sha256Bytes(patchBytes);
    const manifestPath = client.remoteToHost(handle, '/workspace/output/artifact-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifestPatch = manifest.artifacts.find(artifact => artifact.kind === 'patch');
    manifestPatch.sha256 = patchSha;
    manifestPatch.size_bytes = patchBytes.length;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const resultPath = client.remoteToHost(handle, '/workspace/output/integration-result.json');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const resultPatch = result.artifacts.find(artifact => artifact.kind === 'patch');
    resultPatch.sha256 = patchSha;
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  };
  const owner = member('test-alpha');
  const client = new FakeSandboxClient({ root: path.join(workRoot, 'integration-content-drift', 'sandboxes'), onBeforeReadFile: hook });
  const { summary } = await dispatchCase('integration-content-drift', [
    { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
  ], { client });
  assert.equal(summary.status, 'failed');
  assert.match(summary.integration.reason, /content .* differs/i);
  assert.equal(client.deleted.length, 2);
});

test('dispatcher rejects integrated patch delta policy violations', async () => {
  const cases = [
    ['integrated-symlink', 'diff --git a/alpha/result.txt b/alpha/result.txt\nnew file mode 120000\nindex 0000000..e69de29\n--- /dev/null\n+++ b/alpha/result.txt\n@@ -0,0 +1 @@\n+base.txt\n'],
    ['integrated-gitlink', 'diff --git a/alpha/result.txt b/alpha/result.txt\nnew file mode 160000\nindex 0000000..0123456\n--- /dev/null\n+++ b/alpha/result.txt\n@@ -0,0 +1 @@\n+Subproject commit 0123456789012345678901234567890123456789\n'],
    ['integrated-executable', 'diff --git a/alpha/result.txt b/alpha/result.txt\nnew file mode 100755\nindex 0000000..bf0d87a\n--- /dev/null\n+++ b/alpha/result.txt\n@@ -0,0 +1 @@\n+alpha changed\n'],
    ['integrated-gitdir', 'diff --git a/.git/config b/.git/config\nnew file mode 100644\nindex 0000000..257cc56\n--- /dev/null\n+++ b/.git/config\n@@ -0,0 +1 @@\n+unsafe\n'],
    ['integrated-protected', 'diff --git a/.squad/state.txt b/.squad/state.txt\nnew file mode 100644\nindex 0000000..257cc56\n--- /dev/null\n+++ b/.squad/state.txt\n@@ -0,0 +1 @@\n+unsafe\n'],
    ['integrated-outside-union', 'diff --git a/beta/evil.txt b/beta/evil.txt\nnew file mode 100644\nindex 0000000..257cc56\n--- /dev/null\n+++ b/beta/evil.txt\n@@ -0,0 +1 @@\n+unsafe\n']
  ];
  for (const [name, patchText] of cases) {
    let tampered = false;
    const hook = async (handle, remotePath, client) => {
      if (tampered || !remotePath.endsWith('integration-result.json')) return;
      const patchPath = client.remoteToHost(handle, '/workspace/output/patches/integrated.patch');
      if (!fs.existsSync(patchPath)) return;
      tampered = true;
      const patch = patchText.endsWith('\n') ? patchText : `${patchText}\n`;
      fs.writeFileSync(patchPath, patch);
      const patchBytes = Buffer.from(patch);
      const patchSha = sha256Bytes(patchBytes);
      const manifestPath = client.remoteToHost(handle, '/workspace/output/artifact-manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const manifestPatch = manifest.artifacts.find(artifact => artifact.kind === 'patch');
      manifestPatch.sha256 = patchSha;
      manifestPatch.size_bytes = patchBytes.length;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const resultPath = client.remoteToHost(handle, '/workspace/output/integration-result.json');
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      const resultPatch = result.artifacts.find(artifact => artifact.kind === 'patch');
      resultPatch.sha256 = patchSha;
      fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    };
    const owner = member('test-alpha');
    const client = new FakeSandboxClient({ root: path.join(workRoot, name, 'sandboxes'), onBeforeReadFile: hook });
    const { summary } = await dispatchCase(name, [
      { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
    ], { client });
    assert.equal(summary.status, 'failed', name);
    assert.match(summary.integration.reason, /policy|path set|paths .* do not match|violates|outside/i, name);
  }
});

test('dispatcher verification does not run filter-capable git commands', async () => {
  const caseDir = path.join(workRoot, 'filter-hardening');
  const globalConfig = path.join(caseDir, 'global.gitconfig');
  const marker = path.join(caseDir, 'filter-ran.marker');
  const filterScript = path.join(caseDir, 'filter.js');
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(filterScript, `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, 'filter ran');
process.stdin.pipe(process.stdout);
`, 'utf8');
  const filterCommand = `"${process.execPath.replace(/\\/g, '/')}" "${filterScript.replace(/\\/g, '/')}"`;
  git(['config', '--file', globalConfig, 'filter.fake.clean', filterCommand], repoRoot);
  git(['config', '--file', globalConfig, 'filter.fake.smudge', filterCommand], repoRoot);
  git(['config', '--file', globalConfig, 'filter.fake.required', 'true'], repoRoot);

  const rawRepo = path.join(caseDir, 'raw');
  fs.mkdirSync(path.join(rawRepo, 'alpha'), { recursive: true });
  git(['init'], rawRepo);
  fs.writeFileSync(path.join(rawRepo, '.gitattributes'), 'alpha/*.txt filter=fake\n');
  const rawEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
  const raw = gitResult(['hash-object', '--path=alpha/result.txt', '--stdin'], { cwd: rawRepo, env: rawEnv, encoding: 'utf8', input: 'alpha changed\n' });
  if (raw.status !== 0 && !fs.existsSync(marker)) {
    assert.fail(`negative control did not execute the configured clean filter\nstdout:\n${raw.stdout}\nstderr:\n${raw.stderr}`);
  }
  assert.equal(fs.existsSync(marker), true, 'negative control must prove a clean filter can run when a filter-running command is used');
  fs.rmSync(marker, { force: true });

  const invocations = [];
  let tampered = false;
  const hook = async (handle, remotePath, client) => {
    if (tampered || !remotePath.endsWith('integration-result.json')) return;
    const patchPath = client.remoteToHost(handle, '/workspace/output/patches/integrated.patch');
    if (!fs.existsSync(patchPath)) return;
    tampered = true;
    const patch = fs.readFileSync(patchPath, 'utf8').replace('alpha changed', 'alpha drifted');
    fs.writeFileSync(patchPath, patch);
    const patchBytes = Buffer.from(patch);
    const patchSha = sha256Bytes(patchBytes);
    const manifestPath = client.remoteToHost(handle, '/workspace/output/artifact-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifestPatch = manifest.artifacts.find(artifact => artifact.kind === 'patch');
    manifestPatch.sha256 = patchSha;
    manifestPatch.size_bytes = patchBytes.length;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const resultPath = client.remoteToHost(handle, '/workspace/output/integration-result.json');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const resultPatch = result.artifacts.find(artifact => artifact.kind === 'patch');
    resultPatch.sha256 = patchSha;
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
  };
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    const owner = member('test-alpha');
    const client = new FakeSandboxClient({ root: path.join(workRoot, 'filter-hardening-sandboxes'), onBeforeReadFile: hook });
    const { summary } = await dispatchCase('filter-hardening', [
      { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
    ], {
      client,
      config: {
        onVerificationGitSpawn(invocation) {
          invocations.push(invocation);
        }
      },
      repoPatch(repo) {
        fs.writeFileSync(path.join(repo, '.gitattributes'), 'alpha/*.txt filter=fake\n');
        git(['add', '.gitattributes'], repo);
        git(['commit', '-m', 'add attributes'], repo);
      }
    });
    assert.equal(fs.existsSync(marker), false, 'verification must not execute configured filters');
    assert.equal(summary.status, 'failed');
    assert.match(summary.integration.reason, /content .* differs/i);
    const spawned = invocations.map(item => item.args.join(' ')).join('\n');
    assert.doesNotMatch(spawned, /\b(?:add|hash-object|checkout|checkout-index)\b/, 'verification git command set must not include commands that run clean or smudge filters');
  } finally {
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
  }
});

test('dispatcher verification disables global reference hooks during fetch', async () => {
  const caseDir = path.join(workRoot, 'hook-hardening');
  const globalConfig = path.join(caseDir, 'global.gitconfig');
  const hooksDir = path.join(caseDir, 'global-hooks');
  const marker = path.join(caseDir, 'hook-ran.marker');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'reference-transaction');
  fs.writeFileSync(hookPath, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'hook ran');
`, 'utf8');
  fs.chmodSync(hookPath, 0o755);
  git(['config', '--file', globalConfig, 'core.hooksPath', hooksDir], repoRoot);

  const { baseline, bundle } = createBaselineBundle('hook-hardening-negative');
  const rawRepo = path.join(caseDir, 'raw.git');
  const rawEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
  assertGitOk(['init', '--bare', rawRepo], { cwd: caseDir, env: rawEnv });
  assertGitOk([`--git-dir=${rawRepo}`, 'fetch', bundle, `${baseline}:refs/heads/baseline`], { cwd: caseDir, env: rawEnv });
  assert.equal(fs.existsSync(marker), true, 'negative control must prove the global reference hook can run during fetch');
  fs.rmSync(marker, { force: true });

  const invocations = [];
  let globalSet = false;
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
  const hook = async (handle, remotePath) => {
    if (globalSet || !remotePath.endsWith('integration-result.json')) return;
    globalSet = true;
    fs.rmSync(marker, { force: true });
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
  };
  try {
    const owner = member('test-alpha');
    const client = new FakeSandboxClient({ root: path.join(workRoot, 'hook-hardening-sandboxes'), onBeforeReadFile: hook });
    const { summary } = await dispatchCase('hook-hardening', [
      { task_id: 'task-alpha', owner, owned_paths: ['alpha'] }
    ], {
      client,
      config: {
        onVerificationGitSpawn(invocation) {
          invocations.push(invocation);
        }
      }
    });
    assert.equal(summary.status, 'succeeded');
    assert.equal(fs.existsSync(marker), false, 'verification must not execute global hooks');
    assert(invocations.length > 0, 'verification git invocations should be intercepted');
    for (const invocation of invocations) {
      const args = invocation.args;
      assert(args.includes('-c') && args.includes('core.hooksPath=' + path.join(path.dirname(invocation.env.GIT_CONFIG_GLOBAL), 'hooks')), `missing hardened hooksPath in ${args.join(' ')}`);
      assert(args.includes('-c') && args.includes('filter.lfs.clean='), `missing hardened filter flags in ${args.join(' ')}`);
      assert.equal(invocation.env.GIT_CONFIG_NOSYSTEM, '1');
      assert.notEqual(invocation.env.GIT_CONFIG_GLOBAL, globalConfig);
      assert.equal(invocation.env.GIT_CONFIG_COUNT, '0');
      assert.equal(invocation.env.GIT_CONFIG_PARAMETERS, '');
    }
  } finally {
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
  }
});
