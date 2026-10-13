const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const runner = path.join(repoRoot, 'agents', 'sandbox', 'runner', 'persona-run.sh');
const validate = path.join(repoRoot, 'contracts', 'aca-sandbox', 'v1', 'tools', 'validate.js');
const sandboxDockerfile = path.join(repoRoot, 'agents', 'sandbox', 'Dockerfile');
const workRoot = path.join(__dirname, '.work');

function findBash() {
  const candidates = [
    process.env.BASH,
    'bash',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  return null;
}

const bash = findBash();
const allowSkipBashTests = process.env.SQUAD_ALLOW_SKIP_BASH_TESTS === '1';
const hasTmpfsShm = (() => {
  try {
    return fs.readFileSync('/proc/mounts', 'utf8').split(/\r?\n/).some(line => {
      const fields = line.split(/\s+/);
      return fields[1] === '/dev/shm' && fields[2] === 'tmpfs';
    });
  } catch {
    return false;
  }
})();
const runnerSkip = !bash ? 'Git Bash is not available' : !hasTmpfsShm ? '/dev/shm tmpfs is required' : false;

if (!bash && !allowSkipBashTests) {
  throw new Error('Git Bash is required for persona-run tests. Set SQUAD_ALLOW_SKIP_BASH_TESTS=1 to opt out explicitly.');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

function bashPath(windowsPath) {
  if (!bash) return windowsPath;
  const script = 'if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf "%s" "$1"; fi';
  return run(bash, ['-lc', script, 'bash', windowsPath]);
}

function isDockerAvailable() {
  try {
    const res = spawnSync('docker', ['info'], { encoding: 'utf8', shell: false, timeout: 5000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

let cachedLinuxRoot = undefined;
function isLinuxRootAvailable() {
  if (cachedLinuxRoot !== undefined) return cachedLinuxRoot;
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
    cachedLinuxRoot = { kind: 'native' };
    return cachedLinuxRoot;
  }
  if (process.platform === 'win32') {
    const probePath = path.join(workRoot, 'linux-root-capability');
    try {
      fs.mkdirSync(probePath, { recursive: true });
      const linuxProbePath = bashPath(probePath).replace(/^\/([a-z])\//i, '/mnt/$1/');
      const probe = spawnSync('wsl', [
        '-u', 'root', '-e', 'bash', '-c',
        'set -euo pipefail; cd "$1"; git init >/dev/null 2>&1; git config user.name "Sandbox Test"',
        'bash', linuxProbePath
      ], { encoding: 'utf8', shell: false, timeout: 15000 });
      if (probe.status === 0) {
        cachedLinuxRoot = { kind: 'wsl' };
        return cachedLinuxRoot;
      }
    } catch {
      // ignore
    } finally {
      fs.rmSync(probePath, { recursive: true, force: true });
    }
  }
  cachedLinuxRoot = false;
  return cachedLinuxRoot;
}

function hasProcArgvEvidence() {
  if (!bash) return false;
  const result = spawnSync(bash, ['-lc', '[[ -r /proc/self/cmdline && -r /proc/$$/stat ]]'], { encoding: 'utf8' });
  return result.status === 0;
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function git(args, cwd) {
  return run('git', args, { cwd });
}

function createRepo(name) {
  const repo = path.join(workRoot, name, 'source');
  fs.mkdirSync(repo, { recursive: true });
  git(['init'], repo);
  git(['config', 'user.name', 'Sandbox Test'], repo);
  git(['config', 'user.email', 'sandbox-test@example.invalid'], repo);
  fs.mkdirSync(path.join(repo, 'allowed'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'baseline\n');
  fs.writeFileSync(path.join(repo, 'allowed', 'old.txt'), 'old baseline\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored*\nallowed/ignored*\n');
  git(['add', 'README.md', 'allowed/old.txt', '.gitignore'], repo);
  git(['commit', '-m', 'baseline'], repo);
  const baseline = git(['rev-parse', 'HEAD'], repo);
  return { repo, baseline };
}

function createFakeCopilot(dir) {
  const fake = path.join(dir, 'fake-copilot.sh');
  fs.writeFileSync(fake, `#!/usr/bin/env bash
set -euo pipefail
node -e 'const assert=require("node:assert/strict"); assert.deepEqual(process.argv.slice(1), ["--yolo","--agent","squad","--max-ai-credits",process.env.FAKE_EXPECT_CREDITS || "30"])' -- "$@"
cat >/dev/null
: "\${GITHUB_TOKEN:?GITHUB_TOKEN must be present for Copilot}"
if [[ -n "\${FAKE_COPILOT_ENV_FILE:-}" ]]; then
  env | sort > "\${FAKE_COPILOT_ENV_FILE}"
fi
case "\${FAKE_COPILOT_ACTION:-happy}" in
  happy|credential)
    mkdir -p allowed
    printf 'changed by fake copilot\\n' > allowed/result.txt
    ;;
  outside)
    mkdir -p other
    printf 'outside ownership\\n' > other/result.txt
    ;;
  protected)
    mkdir -p .github/workflows
    printf 'name: forbidden\\n' > .github/workflows/ci.yml
    ;;
  rename-outside)
    mkdir -p other
    git mv allowed/old.txt other/renamed.txt
    ;;
  ignored-outside)
    printf 'ignored outside ownership\\n' > ignored-outside.txt
    ;;
  ignored-token-inside)
    mkdir -p allowed
    printf 'ignored inside ownership\\n' > "allowed/ignored-\${GITHUB_TOKEN}.txt"
    ;;
  ignored-token-outside)
    printf 'ignored outside ownership\\n' > "ignored-\${GITHUB_TOKEN}.txt"
    ;;
  violation-path-token)
    mkdir -p other
    printf 'outside ownership\\n' > "other/\${GITHUB_TOKEN}-result.txt"
    ;;
  symlink-escape)
    mkdir -p allowed
    node -e "const fs=require('node:fs'); fs.symlinkSync(process.env.FAKE_SYMLINK_TARGET, 'allowed/escape-link', process.platform === 'win32' ? 'junction' : 'dir')"
    ;;
  symlink-target-token)
    mkdir -p allowed
    node -e "const fs=require('node:fs'); fs.mkdirSync(process.env.FAKE_SYMLINK_TOKEN_TARGET, { recursive: true }); fs.symlinkSync(process.env.FAKE_SYMLINK_TOKEN_TARGET, 'allowed/ignored-link', process.platform === 'win32' ? 'junction' : 'dir')"
    ;;
  prefix-boundary)
    mkdir -p src-other
    printf 'outside segment-aware prefix\\n' > src-other/file.txt
    ;;
  leak-patch)
    mkdir -p allowed
    printf 'leaked token %s\\n' "\${GITHUB_TOKEN}" > allowed/leak.txt
    ;;
  output-tamper)
    mkdir -p allowed
    printf 'changed by fake copilot\\n' > allowed/result.txt
    printf 'direct output write\\n' > "\${FAKE_OUTPUT_TAMPER_PATH}"
    ;;
  *)
    echo "unknown fake action: \${FAKE_COPILOT_ACTION}" >&2
    exit 2
    ;;
esac
`, 'utf8');
  fs.chmodSync(fake, 0o755);
  return fake;
}

function dispatchFor(baseline, ownedPaths = ['allowed/']) {
  const owner = {
    logical_member_id: 'test-persona',
    resolved_persistent_name: 'Test Persona',
    charter_ref: '.squad/agents/test-persona/charter.md',
    membership: 'persona',
    capabilities: ['container']
  };
  return {
    schema_version: 'aca-sandbox/v1',
    message_type: 'persona.dispatch',
    run_id: 'run-test-001',
    task_id: 'task-test-sandbox',
    owner,
    objective: 'Write a test artifact in the owned path.',
    required_capabilities: ['container'],
    dependencies: [],
    baseline_sha: baseline,
    roster: {
      revision: 'test-roster-1',
      hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      members: [owner]
    },
    provider: {
      id: 'test-provider',
      kind: 'aca-sandbox',
      contract_version: 'aca-sandbox-provider/v1'
    },
    owned_paths: ownedPaths
  };
}

function runRunner({ name, baseline, sourceRepo, fakeCopilot, action = 'happy', ownedPaths = ['allowed/'], maxAiCredits, injectedCredits }) {
  const caseDir = path.join(workRoot, name);
  const outputDir = path.join(caseDir, 'output');
  const fakeEnvFile = path.join(caseDir, 'fake-copilot-env.txt');
  const externalTarget = path.join(caseDir, 'external-target');
  const externalTokenTarget = path.join(caseDir, 'external-test-copilot-token-target');
  const outputTamperPath = path.join(outputDir, 'persona-direct.txt');
  fs.mkdirSync(externalTarget, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const dispatchPath = path.join(caseDir, 'dispatch.json');
  const dispatch = dispatchFor(baseline, ownedPaths);
  if (maxAiCredits !== undefined) dispatch.max_ai_credits = maxAiCredits;
  fs.writeFileSync(dispatchPath, `${JSON.stringify(dispatch, null, 2)}\n`);

  const env = {
    ...process.env,
    SQUAD_SOURCE_REPO_PATH: bashPath(sourceRepo),
    SQUAD_OUTPUT_DIR: bashPath(outputDir),
    SQUAD_COPILOT_BIN: bashPath(fakeCopilot),
    SQUAD_COPILOT_TOKEN: 'test-copilot-token',
    PATH_SCOPE_TOOL: bashPath(path.join(repoRoot, 'contracts', 'aca-sandbox', 'v1', 'tools', 'path-scope.js')),
    SQUAD_FAKE_COPILOT_ENV_ALLOWLIST: [
      'FAKE_COPILOT_ACTION',
      'FAKE_EXPECT_CREDITS',
      'FAKE_COPILOT_ENV_FILE',
      'FAKE_SYMLINK_TARGET',
      'FAKE_SYMLINK_TOKEN_TARGET',
      'FAKE_OUTPUT_TAMPER_PATH',
      'FAKE_ARGV_DUMP_FILE'
    ].join(','),
    FAKE_COPILOT_ACTION: action,
    FAKE_EXPECT_CREDITS: String(maxAiCredits ?? injectedCredits ?? 30),
    FAKE_COPILOT_ENV_FILE: bashPath(fakeEnvFile),
    FAKE_SYMLINK_TARGET: bashPath(externalTarget),
    FAKE_SYMLINK_TOKEN_TARGET: bashPath(externalTokenTarget),
    FAKE_OUTPUT_TAMPER_PATH: bashPath(outputTamperPath),
    FAKE_ARGV_DUMP_FILE: process.env.FAKE_ARGV_DUMP_FILE || ''
  };
  delete env.GITHUB_TOKEN;
  delete env.COPILOT_TOKEN;
  delete env.SQUAD_COPILOT_MAX_AI_CREDITS;
  if (injectedCredits !== undefined) env.SQUAD_COPILOT_MAX_AI_CREDITS = String(injectedCredits);

  const result = spawnSync(bash, [bashPath(runner), bashPath(dispatchPath)], { encoding: 'utf8', env });
  return { result, outputDir, fakeEnvFile };
}

function validateOutput(outputDir) {
  run('node', [validate, 'persona-result.schema.json', path.join(outputDir, 'persona-result.json')], { cwd: repoRoot });
  run('node', [validate, 'artifact-manifest.schema.json', path.join(outputDir, 'artifact-manifest.json')], { cwd: repoRoot });
}

test.beforeEach(() => resetDir(workRoot));

test('explicit per-persona credit limit is passed as exactly two argv entries', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('credit-limit');
  const fakeCopilot = createFakeCopilot(path.join(workRoot, 'credit-limit'));
  const { result, outputDir, fakeEnvFile } = runRunner({
    name: 'credit-limit', baseline, sourceRepo: repo, fakeCopilot, maxAiCredits: 30, injectedCredits: 30
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readResult(outputDir).status, 'succeeded');
  assert.doesNotMatch(fs.readFileSync(fakeEnvFile, 'utf8'), /SQUAD_COPILOT_MAX_AI_CREDITS/);
});

test('explicit supported credit limit is not replaced by the default', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('credit-opt-in');
  const fakeCopilot = createFakeCopilot(path.join(workRoot, 'credit-opt-in'));
  const { result } = runRunner({
    name: 'credit-opt-in', baseline, sourceRepo: repo, fakeCopilot, maxAiCredits: 31
  });
  assert.equal(result.status, 0, result.stderr);
});

test('invalid or conflicting credit limits fail before persona invocation and repository clone', { skip: runnerSkip }, () => {
  for (const [index, values] of [
    { maxAiCredits: 29 }, { maxAiCredits: null }, { injectedCredits: '30 --yolo' },
    { injectedCredits: '' }, { maxAiCredits: 30, injectedCredits: 31 }
  ].entries()) {
    const name = `bad-credit-${index}`;
    const { repo, baseline } = createRepo(name);
    const fakeCopilot = createFakeCopilot(path.join(workRoot, name));
    const { result, outputDir, fakeEnvFile } = runRunner({ name, baseline, sourceRepo: repo, fakeCopilot, ...values });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /credit/);
    assert.equal(fs.existsSync(fakeEnvFile), false);
    assert.deepEqual(fs.readdirSync(outputDir), []);
  }
});

function readResult(outputDir) {
  return JSON.parse(fs.readFileSync(path.join(outputDir, 'persona-result.json'), 'utf8'));
}

function outputFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...outputFiles(fullPath));
    else results.push(fullPath);
  }
  return results;
}

function assertOutputDoesNotContain(outputDir, text) {
  for (const file of outputFiles(outputDir)) {
    assert.equal(fs.readFileSync(file, 'utf8').includes(text), false, `${file} contains ${text}`);
  }
}

function assertMinimalCredentialLeakOutput(outputDir) {
  const files = outputFiles(outputDir).map(file => path.relative(outputDir, file).split(path.sep).join('/')).sort();
  assert.deepEqual(files, ['artifact-manifest.json', 'persona-result.json']);
  validateOutput(outputDir);
  const personaResult = readResult(outputDir);
  assert.equal(personaResult.status, 'failed');
  assert.equal(personaResult.error.code, 'credential_leak');
  assertOutputDoesNotContain(outputDir, 'test-copilot-token');
}

function assertMinimalFailureOutput(outputDir, code) {
  const files = outputFiles(outputDir).map(file => path.relative(outputDir, file).split(path.sep).join('/')).sort();
  assert.deepEqual(files, ['artifact-manifest.json', 'persona-result.json']);
  validateOutput(outputDir);
  const personaResult = readResult(outputDir);
  assert.equal(personaResult.status, 'failed');
  assert.equal(personaResult.error.code, code);
  assertOutputDoesNotContain(outputDir, 'test-copilot-token');
}

function assertIsolationMode(outputDir) {
  const marker = fs.readFileSync(path.join(outputDir, 'logs', 'isolation-mode.txt'), 'utf8').trim();
  assert.match(marker, /^copilot_isolation_mode=(same-user|separate-user)$/);
  if (process.getuid && process.getuid() === 0) {
    assert.equal(marker, 'copilot_isolation_mode=separate-user');
  } else {
    assert.equal(marker, 'copilot_isolation_mode=same-user');
  }
}

test('Dockerfile copies sandbox runtime dependencies and pins the CLI release', () => {
  const dockerfile = fs.readFileSync(sandboxDockerfile, 'utf8');
  const runnerSource = fs.readdirSync(path.join(repoRoot, 'agents', 'sandbox', 'runner'))
    .filter(file => file.endsWith('.js') || file.endsWith('.sh'))
    .map(file => fs.readFileSync(path.join(repoRoot, 'agents', 'sandbox', 'runner', file), 'utf8'))
    .join('\n');
  const writeResultSource = fs.readFileSync(path.join(repoRoot, 'agents', 'sandbox', 'runner', 'write-result.js'), 'utf8');
  const copiedSources = [...dockerfile.matchAll(/^\s*COPY(?:\s+--[^\s]+)*\s+([^\s]+)\s+/gm)].map(match => match[1]);
  assert(copiedSources.includes('agents/sandbox/lib'), 'Dockerfile must copy sandbox lib from repo-root context');
  assert(copiedSources.includes('agents/sandbox/runner'), 'Dockerfile must copy sandbox runner from repo-root context');
  assert.match(dockerfile, /^COPY agents\/sandbox\/runner /m, 'runner files should be copied root-owned');
  assert.match(dockerfile, /chmod \+x \/opt\/squad-sandbox\/runner\/integrate-run\.sh/, 'integration runner must be executable in the image');
  assert.match(dockerfile, /releases\/download\/v1\.0\.96\/copilot-linux-x64\.tar\.gz/);
  assert.match(dockerfile, /66b60b58b14d72390f30d6d7f8480d18a0f05c111d132e4ff8f92ae637d413f8/);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /copilot --version/);
  assert.doesNotMatch(dockerfile, /npm install|npx /);
  assert.doesNotMatch(dockerfile, /\/tmp\/|mktemp/);

  const contractRefs = new Set();
  for (const source of [runnerSource, writeResultSource]) {
    for (const match of source.matchAll(/contracts\/aca-sandbox\/v1\/[A-Za-z0-9_./-]+/g)) {
      contractRefs.add(match[0].replace(/^.*contracts\/aca-sandbox\/v1\//, 'contracts/aca-sandbox/v1/'));
    }
  }
  assert(contractRefs.has('contracts/aca-sandbox/v1/tools/path-scope.js'));
  assert(contractRefs.has('contracts/aca-sandbox/v1/tools/validate.js'));
  assert(copiedSources.includes('contracts/aca-sandbox/v1/schemas'), 'Dockerfile must copy schemas for integration validation');
  for (const contractRef of contractRefs) {
    assert(
      copiedSources.some(source => contractRef === source || contractRef.startsWith(`${source.replace(/\/$/, '')}/`)),
      `${contractRef} is referenced at runtime but not covered by Dockerfile COPY`
    );
  }

  const createdUsers = new Set(['root']);
  const createdGroups = new Set(['root']);
  const flattenedDockerfile = dockerfile.replace(/\\\r?\n/g, ' ');
  for (const command of flattenedDockerfile.split(/&&|;/).filter(part => /\buseradd\b/.test(part))) {
    const parts = command.trim().split(/\s+/);
    const user = parts[parts.length - 1];
    if (user && !user.startsWith('-')) {
      createdUsers.add(user);
      createdGroups.add(user);
    }
  }
  for (const match of dockerfile.matchAll(/--chown=([^\s]+)/g)) {
    const [user, group = user] = match[1].split(':');
    assert(createdUsers.has(user), `COPY --chown references unknown user ${user}`);
    assert(createdGroups.has(group), `COPY --chown references unknown group ${group}`);
  }
  for (const match of dockerfile.matchAll(/^\s*USER\s+([^\s]+)/gm)) {
    const [user, group = user] = match[1].split(':');
    assert(createdUsers.has(user), `USER references unknown user ${user}`);
    assert(createdGroups.has(group), `USER references unknown group ${group}`);
  }
});

test('happy path produces valid result, manifest, and patch', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('happy');
  const fake = createFakeCopilot(path.join(workRoot, 'happy'));
  const { result, outputDir } = runRunner({ name: 'happy', baseline, sourceRepo: repo, fakeCopilot: fake });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  validateOutput(outputDir);
  const personaResult = readResult(outputDir);
  assert.equal(personaResult.status, 'succeeded');
  assertIsolationMode(outputDir);
  assert.match(fs.readFileSync(path.join(outputDir, 'patches', 'task-test-sandbox.patch'), 'utf8'), /allowed\/result\.txt/);
});

test('baseline SHA mismatch fails closed', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('baseline-mismatch');
  fs.writeFileSync(path.join(repo, 'README.md'), 'new head\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-m', 'move head'], repo);
  const fake = createFakeCopilot(path.join(workRoot, 'baseline-mismatch'));
  const { result, outputDir } = runRunner({ name: 'baseline-mismatch', baseline, sourceRepo: repo, fakeCopilot: fake });
  assert.notEqual(result.status, 0);
  validateOutput(outputDir);
  const personaResult = readResult(outputDir);
  assert.equal(personaResult.status, 'failed');
  assert.equal(personaResult.error.code, 'BASELINE_SHA_MISMATCH');
});

test('ownership violation fails closed and writes audit patch', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('ownership');
  const fake = createFakeCopilot(path.join(workRoot, 'ownership'));
  const { result, outputDir } = runRunner({ name: 'ownership', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'outside' });
  assert.notEqual(result.status, 0);
  validateOutput(outputDir);
  const personaResult = readResult(outputDir);
  assert.equal(personaResult.status, 'failed');
  assert.equal(personaResult.error.code, 'PATH_OWNERSHIP_VIOLATION');
  assert.match(fs.readFileSync(path.join(outputDir, 'patches', 'task-test-sandbox.patch'), 'utf8'), /other\/result\.txt/);
});

test('protected path violation fails closed even when owned', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('protected');
  const fake = createFakeCopilot(path.join(workRoot, 'protected'));
  const { result, outputDir } = runRunner({
    name: 'protected',
    baseline,
    sourceRepo: repo,
    fakeCopilot: fake,
    action: 'protected',
    ownedPaths: ['.github/workflows/']
  });
  assert.notEqual(result.status, 0);
  validateOutput(outputDir);
  const personaResult = readResult(outputDir);
  assert.equal(personaResult.status, 'failed');
  assert.equal(personaResult.error.code, 'OWNED_PATHS_INVALID');
  assert.match(personaResult.error.message, /\.github\/workflows/);
});

test('credential environment is cleared after Copilot exits', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('credential');
  const fake = createFakeCopilot(path.join(workRoot, 'credential'));
  const { result, outputDir, fakeEnvFile } = runRunner({ name: 'credential', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'credential' });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(fs.readFileSync(fakeEnvFile, 'utf8'), /^GITHUB_TOKEN=test-copilot-token$/m);
  assert.doesNotMatch(fs.readFileSync(fakeEnvFile, 'utf8'), /^SQUAD_OUTPUT_DIR=/m);
  assert.doesNotMatch(fs.readFileSync(fakeEnvFile, 'utf8'), /^STAGING_DIR=/m);
  assert.doesNotMatch(fs.readFileSync(fakeEnvFile, 'utf8'), /^SQUAD_SOURCE_REPO_PATH=/m);
  const copilotEnv = fs.readFileSync(fakeEnvFile, 'utf8');
  assert.match(copilotEnv, /^HOME=\/dev\/shm\/\.persona-home\./m);
  assert.match(copilotEnv, /^XDG_CONFIG_HOME=\/dev\/shm\/\.persona-home\./m);
  assert.match(copilotEnv, /^COPILOT_PKG_CACHE_HOME=.+\.copilot-package-cache$/m);
  assert.doesNotMatch(copilotEnv, /^COPILOT_PKG_CACHE_HOME=\/dev\/shm/m);
  assert.match(copilotEnv, /^COPILOT_AUTO_UPDATE=false$/m);
  assertIsolationMode(outputDir);
  assert.equal(fs.readFileSync(path.join(outputDir, 'logs', 'credential-env-cleared.txt'), 'utf8').trim(), 'credential_env_cleared=true');
  assertOutputDoesNotContain(outputDir, 'test-copilot-token');
});

test('Copilot token is delivered through fd and absent from process argv', { skip: runnerSkip }, (t) => {
  if (!hasProcArgvEvidence()) {
    const reason = '/proc cmdline evidence is unavailable for argv inspection';
    if (process.env.SQUAD_REQUIRE_PROC_ARGV_TEST === '1') assert.fail(reason);
    t.skip(reason);
    return;
  }
  const { repo, baseline } = createRepo('fd-token');
  const fake = path.join(workRoot, 'fd-token', 'fake-copilot-argv.sh');
  fs.writeFileSync(fake, `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
: "\${GITHUB_TOKEN:?GITHUB_TOKEN must be present for Copilot}"
mkdir -p allowed
printf 'changed by fake copilot\\n' > allowed/result.txt
{
  printf 'self:'
  if [[ -r /proc/self/cmdline ]]; then tr '\\0' ' ' < /proc/self/cmdline; else echo "/proc/self/cmdline unavailable" >&2; exit 86; fi
  printf '\\n'
  pid=$$
  depth=0
  while [[ -r "/proc/$pid/stat" && "$depth" -lt 8 ]]; do
    ppid=$(awk '{print $4}' "/proc/$pid/stat")
    [[ "$ppid" == "0" || "$ppid" == "$pid" ]] && break
    if [[ -r "/proc/$ppid/cmdline" ]]; then
      printf 'parent-%s:' "$depth"
      tr '\\0' ' ' < "/proc/$ppid/cmdline"
      printf '\\n'
    fi
    pid="$ppid"
    depth=$((depth + 1))
  done
} > "\${FAKE_ARGV_DUMP_FILE}"
`, 'utf8');
  fs.chmodSync(fake, 0o755);
  const argvDump = path.join(workRoot, 'fd-token', 'argv-dump.txt');
  const oldAllowlist = process.env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST;
  const oldDump = process.env.FAKE_ARGV_DUMP_FILE;
  process.env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST = 'FAKE_ARGV_DUMP_FILE';
  process.env.FAKE_ARGV_DUMP_FILE = bashPath(argvDump);
  try {
    const { result, outputDir } = runRunner({ name: 'fd-token', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'happy' });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    validateOutput(outputDir);
    const argvEvidence = fs.readFileSync(argvDump, 'utf8');
    assert.match(argvEvidence, /^self:/m);
    assert.match(argvEvidence, /^parent-0:/m);
    assert.equal(argvEvidence.includes('test-copilot-token'), false);
    assertOutputDoesNotContain(outputDir, 'test-copilot-token');
  } finally {
    if (oldAllowlist === undefined) delete process.env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST;
    else process.env.SQUAD_FAKE_COPILOT_ENV_ALLOWLIST = oldAllowlist;
    if (oldDump === undefined) delete process.env.FAKE_ARGV_DUMP_FILE;
    else process.env.FAKE_ARGV_DUMP_FILE = oldDump;
  }
});

test('non-empty output directory fails closed before persona execution', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('preexisting-output');
  const fake = createFakeCopilot(path.join(workRoot, 'preexisting-output'));
  const caseDir = path.join(workRoot, 'preexisting-output');
  const outputDir = path.join(caseDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'preexisting.txt'), 'tampered test-copilot-token\n');
  const dispatchPath = path.join(caseDir, 'dispatch.json');
  fs.writeFileSync(dispatchPath, `${JSON.stringify(dispatchFor(baseline), null, 2)}\n`);
  const env = {
    ...process.env,
    SQUAD_SOURCE_REPO_PATH: bashPath(repo),
    SQUAD_OUTPUT_DIR: bashPath(outputDir),
    SQUAD_COPILOT_BIN: bashPath(fake),
    SQUAD_COPILOT_TOKEN: 'test-copilot-token',
    PATH_SCOPE_TOOL: bashPath(path.join(repoRoot, 'contracts', 'aca-sandbox', 'v1', 'tools', 'path-scope.js'))
  };
  delete env.GITHUB_TOKEN;
  delete env.COPILOT_TOKEN;
  const result = spawnSync(bash, [bashPath(runner), bashPath(dispatchPath)], { encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
  assertMinimalFailureOutput(outputDir, 'output_tampered');
});

test('direct writes to output directory are discarded at publish', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('output-tamper');
  const fake = createFakeCopilot(path.join(workRoot, 'output-tamper'));
  const { result, outputDir } = runRunner({ name: 'output-tamper', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'output-tamper' });
  assert.notEqual(result.status, 0);
  assertMinimalFailureOutput(outputDir, 'output_tampered');
  assert.equal(fs.existsSync(path.join(outputDir, 'persona-direct.txt')), false);
});

test('early staging failure uses unified cleanup trap', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('early-staging-failure');
  const fake = createFakeCopilot(path.join(workRoot, 'early-staging-failure'));
  const caseDir = path.join(workRoot, 'early-staging-failure');
  const outputDir = path.join(caseDir, 'output');
  const badStagingParent = path.join(caseDir, 'not-a-directory');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(badStagingParent, 'not a directory\n');
  const dispatchPath = path.join(caseDir, 'dispatch.json');
  fs.writeFileSync(dispatchPath, `${JSON.stringify(dispatchFor(baseline), null, 2)}\n`);
  const env = {
    ...process.env,
    SQUAD_SOURCE_REPO_PATH: bashPath(repo),
    SQUAD_OUTPUT_DIR: bashPath(outputDir),
    SQUAD_STAGING_PARENT: bashPath(badStagingParent),
    SQUAD_COPILOT_BIN: bashPath(fake),
    SQUAD_COPILOT_TOKEN: 'test-copilot-token',
    PATH_SCOPE_TOOL: bashPath(path.join(repoRoot, 'contracts', 'aca-sandbox', 'v1', 'tools', 'path-scope.js'))
  };
  delete env.GITHUB_TOKEN;
  delete env.COPILOT_TOKEN;
  const result = spawnSync(bash, [bashPath(runner), bashPath(dispatchPath)], { encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
  assert.deepEqual(outputFiles(outputDir), []);
  assert.equal(
    fs.readdirSync(caseDir).some(name => name.startsWith('.persona-artifacts.') || name.startsWith('.persona-home.') || name.startsWith('.persona-worktree.')),
    false
  );
  assert.equal(`${result.stdout}\n${result.stderr}`.includes('test-copilot-token'), false);
});

test('rename out of owned path fails closed', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('rename-outside');
  const fake = createFakeCopilot(path.join(workRoot, 'rename-outside'));
  const { result, outputDir } = runRunner({ name: 'rename-outside', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'rename-outside' });
  assert.notEqual(result.status, 0);
  validateOutput(outputDir);
  const personaResult = readResult(outputDir);
  assert.equal(personaResult.status, 'failed');
  assert.equal(personaResult.error.code, 'PATH_OWNERSHIP_VIOLATION');
  assert.match(personaResult.error.message, /other\/renamed\.txt/);
});

test('ignored untracked file outside owned paths fails closed', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('ignored-outside');
  const fake = createFakeCopilot(path.join(workRoot, 'ignored-outside'));
  const { result, outputDir } = runRunner({ name: 'ignored-outside', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'ignored-outside' });
  assert.notEqual(result.status, 0);
  validateOutput(outputDir);
  const personaResult = readResult(outputDir);
  assert.equal(personaResult.status, 'failed');
  assert.equal(personaResult.error.code, 'PATH_OWNERSHIP_VIOLATION');
  assert.match(personaResult.error.message, /ignored-outside\.txt/);
});

test('symlink escaping repository fails closed', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('symlink-escape');
  const fake = createFakeCopilot(path.join(workRoot, 'symlink-escape'));
  const { result, outputDir } = runRunner({ name: 'symlink-escape', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'symlink-escape' });
  assert.notEqual(result.status, 0);
  validateOutput(outputDir);
  const personaResult = readResult(outputDir);
  assert.equal(personaResult.status, 'failed');
  assert.match(personaResult.error.code, /^SYMLINK_/);
});

test('segment-aware prefix rejects src-other when owned path is src', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('prefix-boundary');
  const fake = createFakeCopilot(path.join(workRoot, 'prefix-boundary'));
  const { result, outputDir } = runRunner({
    name: 'prefix-boundary',
    baseline,
    sourceRepo: repo,
    fakeCopilot: fake,
    action: 'prefix-boundary',
    ownedPaths: ['src']
  });
  assert.notEqual(result.status, 0);
  validateOutput(outputDir);
  const personaResult = readResult(outputDir);
  assert.equal(personaResult.status, 'failed');
  assert.equal(personaResult.error.code, 'PATH_OWNERSHIP_VIOLATION');
  assert.match(personaResult.error.message, /src-other\/file\.txt/);
});

test('leaked token in patch fails closed without unredacted patch', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('leak-patch');
  const fake = createFakeCopilot(path.join(workRoot, 'leak-patch'));
  const { result, outputDir } = runRunner({ name: 'leak-patch', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'leak-patch' });
  assert.notEqual(result.status, 0);
  assertMinimalCredentialLeakOutput(outputDir);
});

test('ignored untracked file with token in name inside owned paths fails closed', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('ignored-token-inside');
  const fake = createFakeCopilot(path.join(workRoot, 'ignored-token-inside'));
  const { result, outputDir } = runRunner({ name: 'ignored-token-inside', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'ignored-token-inside' });
  assert.notEqual(result.status, 0);
  assertMinimalCredentialLeakOutput(outputDir);
});

test('ignored untracked file with token in name outside owned paths fails closed', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('ignored-token-outside');
  const fake = createFakeCopilot(path.join(workRoot, 'ignored-token-outside'));
  const { result, outputDir } = runRunner({ name: 'ignored-token-outside', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'ignored-token-outside' });
  assert.notEqual(result.status, 0);
  assertMinimalCredentialLeakOutput(outputDir);
});

test('violation message path with token fails closed', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('violation-path-token');
  const fake = createFakeCopilot(path.join(workRoot, 'violation-path-token'));
  const { result, outputDir } = runRunner({ name: 'violation-path-token', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'violation-path-token' });
  assert.notEqual(result.status, 0);
  assertMinimalCredentialLeakOutput(outputDir);
});

test('symlink violation target with token fails closed', { skip: runnerSkip }, () => {
  const { repo, baseline } = createRepo('symlink-target-token');
  const fake = createFakeCopilot(path.join(workRoot, 'symlink-target-token'));
  const { result, outputDir } = runRunner({ name: 'symlink-target-token', baseline, sourceRepo: repo, fakeCopilot: fake, action: 'symlink-target-token' });
  assert.notEqual(result.status, 0);
  assertMinimalCredentialLeakOutput(outputDir);
});


test('runner defines invocation-scoped git safe.directory for worktree and source repo without wildcards', () => {
  const runnerScript = fs.readFileSync(runner, 'utf8');
  assert.match(runnerScript, /git\(\)\s*\{/);
  assert.match(runnerScript, /-c\s*"?safe\.directory=\$\{WORK_DIR\}"?/);
  assert.match(runnerScript, /-c\s*"?safe\.directory=\$\{SOURCE_REPO_PATH\}"?/);
  assert.doesNotMatch(runnerScript, /safe\.directory=\*/);
  assert.doesNotMatch(runnerScript, /git\s+config\s+--global.*safe\.directory/);
});

test('real Linux root to UID 10001 ownership behavior verifies baseline, patch generation, and protected path detection', {
  skip: !isLinuxRootAvailable() && 'Linux root environment (native or WSL) is not available'
}, () => {
  const rootEnv = isLinuxRootAvailable();
  assert.ok(rootEnv, 'Linux root environment must be available');
  const scratchRoot = path.join(workRoot, 'linux-root');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const linuxScratchRoot = process.platform === 'win32'
    ? bashPath(scratchRoot).replace(/^\/([a-z])\//i, '/mnt/$1/')
    : scratchRoot;

  const testScript = [
    'set -euo pipefail',
    `TMPD="$(mktemp -d '${linuxScratchRoot}/squad-git-safe-test-XXXXXX')"`,
    'chmod 755 "${TMPD}"',
    'trap \'rm -rf "${TMPD}"\' EXIT',
    'cd "${TMPD}"',
    'git init src >/dev/null',
    'cd src',
    'git config user.name "Test"',
    'git config user.email "test@example.com"',
    'mkdir -p allowed .github/workflows',
    'echo "original content" > allowed/file.txt',
    'echo "workflow" > .github/workflows/ci.yml',
    'git add .',
    'git commit -m "baseline commit" >/dev/null',
    'BASELINE_SHA=$(git rev-parse HEAD)',
    'cd ..',
    'WORK_DIR="${TMPD}/work"',
    'SOURCE_REPO_PATH="${TMPD}/src"',
    'git() {',
    '  local -a safe_args=()',
    '  if [[ -n "${WORK_DIR:-}" ]]; then',
    '    safe_args+=(-c "safe.directory=${WORK_DIR}")',
    '  fi',
    '  if [[ -n "${SOURCE_REPO_PATH:-}" ]]; then',
    '    safe_args+=(-c "safe.directory=${SOURCE_REPO_PATH}")',
    '  fi',
    '  command git "${safe_args[@]}" "$@"',
    '}',
    'git clone --no-hardlinks "${SOURCE_REPO_PATH}" "${WORK_DIR}" >/dev/null 2>&1',
    'cd "${WORK_DIR}"',
    'git remote remove origin >/dev/null 2>&1 || true',
    'useradd -u 10001 copilot-agent 2>/dev/null || true',
    'chown -R 10001:10001 "${WORK_DIR}"',
    'set +e',
    'command git rev-parse HEAD >/dev/null 2>&1',
    'UNWRAPPED_EXIT=$?',
    'set -e',
    'test "${UNWRAPPED_EXIT}" -eq 128',
    'CURRENT_HEAD="$(git rev-parse HEAD)"',
    'test "${CURRENT_HEAD}" = "${BASELINE_SHA}"',
    'su -s /bin/bash copilot-agent -c "echo new content >> \'${WORK_DIR}/allowed/file.txt\'"',
    'su -s /bin/bash copilot-agent -c "echo forbidden >> \'${WORK_DIR}/.github/workflows/ci.yml\'"',
    'git add -N -- .',
    'PATCH="$(git diff --binary "${BASELINE_SHA}" -- .)"',
    'test -n "${PATCH}"',
    'mapfile -d "" -t CHANGED < <(git diff --no-renames -z --name-only "${BASELINE_SHA}" -- .)',
    'HAS_ALLOWED=false',
    'HAS_PROTECTED=false',
    'for p in "${CHANGED[@]}"; do',
    '  [[ "$p" == "allowed/file.txt" ]] && HAS_ALLOWED=true',
    '  [[ "$p" == ".github/workflows/ci.yml" ]] && HAS_PROTECTED=true',
    'done',
    'test "$HAS_ALLOWED" = "true"',
    'test "$HAS_PROTECTED" = "true"',
    'echo "ALL_LINUX_ROOT_TESTS_PASSED"'
  ].join('\n');

  const execResult = rootEnv.kind === 'native'
    ? spawnSync('bash', ['-c', testScript], { encoding: 'utf8', shell: false })
    : spawnSync('wsl', ['-u', 'root', '-e', 'bash', '-c', testScript], { encoding: 'utf8', shell: false });

  assert.equal(execResult.status, 0, `Linux root regression script failed: status=${execResult.status}\nstdout:\n${execResult.stdout}\nstderr:\n${execResult.stderr}`);
  assert.match(execResult.stdout, /ALL_LINUX_ROOT_TESTS_PASSED/);
});

test('Docker container root to UID 10001 isolation and safe.directory enforcement', {
  skip: !isDockerAvailable() && 'Docker daemon is not running'
}, () => {
  const containerScript = [
    'set -euo pipefail',
    'useradd -u 10001 copilot-agent 2>/dev/null || true',
    'TMPD="$(mktemp -d "${PWD}/docker-root-XXXXXX")"',
    'cd "$TMPD"',
    'git init src >/dev/null',
    'cd src',
    'git config user.name "Test"',
    'git config user.email "test@example.com"',
    'mkdir -p allowed .github/workflows',
    'echo "orig" > allowed/f.txt',
    'echo "wf" > .github/workflows/ci.yml',
    'git add . && git commit -m "base" >/dev/null',
    'BASE=$(git rev-parse HEAD)',
    'cd ..',
    'WORK_DIR="$TMPD/work"',
    'SOURCE_REPO_PATH="$TMPD/src"',
    'git() { command git ${WORK_DIR:+-c safe.directory="$WORK_DIR"} ${SOURCE_REPO_PATH:+-c safe.directory="$SOURCE_REPO_PATH"} "$@"; }',
    'git clone --no-hardlinks "$SOURCE_REPO_PATH" "$WORK_DIR" >/dev/null 2>&1',
    'cd "$WORK_DIR"',
    'chown -R 10001:10001 "$WORK_DIR"',
    'set +e; command git rev-parse HEAD >/dev/null 2>&1; test $? -eq 128; set -e',
    'HEAD=$(git rev-parse HEAD)',
    'test "$HEAD" = "$BASE"',
    'su -s /bin/bash copilot-agent -c "echo edit >> $WORK_DIR/allowed/f.txt"',
    'su -s /bin/bash copilot-agent -c "echo bad >> $WORK_DIR/.github/workflows/ci.yml"',
    'git add -N -- .',
    'PATCH=$(git diff --binary "$BASE" -- .)',
    'test -n "$PATCH"',
    'echo DOCKER_ROOT_REGRESSION_PASSED'
  ].join(' && ');

  fs.mkdirSync(workRoot, { recursive: true });
  const result = spawnSync('docker', [
    'run', '--rm', '--volume', `${workRoot}:/workspace/.work`, '--workdir', '/workspace/.work',
    'ubuntu:22.04', 'bash', '-c', containerScript
  ], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, `Docker container regression failed: ${result.stderr}`);
  assert.match(result.stdout, /DOCKER_ROOT_REGRESSION_PASSED/);
});
