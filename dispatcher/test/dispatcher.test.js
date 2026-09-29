const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { runDispatcher } = require('../dispatcher');
const { AcaCliSandboxClient } = require('../clients/aca-cli-client');
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
    assert.equal(stdinPayload.SQUAD_SOURCE_REPO_PATH.length > 0, true);
    const fakeEnv = fs.readFileSync(fakeEnvFile, 'utf8');
    assert.match(fakeEnv, /^GITHUB_TOKEN=github_pat_stdinOnlySecret$/m);
    assert.doesNotMatch(fakeEnv, /^SQUAD_SOURCE_REPO_PATH=/m);
    assert.doesNotMatch(fakeEnv, /^SQUAD_OUTPUT_DIR=/m);
    const integrationExec = client.execCalls.find(call => call.argv.some(arg => String(arg).includes('integrate-run.sh')));
    assert(integrationExec, 'integration exec should use the env bootstrap');
    assert.deepEqual(integrationExec.env, {});
    assert.equal(integrationExec.stdin.includes('SQUAD_COPILOT_TOKEN'), false);
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
    const client = new AcaCliSandboxClient({ acaBin: process.execPath, acaBinArgs: [stub], image: `crsquadacaa6b49feb.azurecr.io/squad-sandbox-lab/persona@sha256:${'a'.repeat(64)}` });
    await client.exec({ name: 'stub-sandbox' }, ['true']);
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

test('live client requires immutable lab image and refuses unverified create without spawning aca', async () => {
  const digest = `crsquadacaa6b49feb.azurecr.io/squad-sandbox-lab/persona@sha256:${'a'.repeat(64)}`;
  for (const ref of ['', 'crsquadacaa6b49feb.azurecr.io/squad-sandbox-lab/persona:latest',
    `other.azurecr.io/squad-sandbox-lab/persona@sha256:${'a'.repeat(64)}`,
    `crsquadacaa6b49feb.azurecr.io/legacy/persona@sha256:${'a'.repeat(64)}`,
    `${digest}extra`]) {
    assert.throws(() => validateSandboxImageRef(ref), /immutable sha256 digest/);
  }
  assert.equal(validateSandboxImageRef(digest), digest);
  const oldEnable = process.env.SQUAD_ENABLE_ACA_SANDBOX;
  const oldGroup = process.env.SQUAD_SANDBOX_GROUP_NAME;
  try {
    process.env.SQUAD_ENABLE_ACA_SANDBOX = '1';
    process.env.SQUAD_SANDBOX_GROUP_NAME = 'test-group';
    const client = new AcaCliSandboxClient({ image: digest, acaBin: 'nonexistent-aca-binary' });
    await assert.rejects(client.create({ name: 'persona', image: digest }), /unverified_image_contract/);
    await assert.rejects(client.create({ name: 'integration', image: digest }), /unverified_image_contract/);
    await assert.rejects(client.create({ name: 'persona', image: `${digest.slice(0, -1)}b` }), /does not match/);
  } finally {
    if (oldEnable === undefined) delete process.env.SQUAD_ENABLE_ACA_SANDBOX;
    else process.env.SQUAD_ENABLE_ACA_SANDBOX = oldEnable;
    if (oldGroup === undefined) delete process.env.SQUAD_SANDBOX_GROUP_NAME;
    else process.env.SQUAD_SANDBOX_GROUP_NAME = oldGroup;
  }
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
    /fine-grained github_pat_ tokens/
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
  ], { client, concurrency: 2 });
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
