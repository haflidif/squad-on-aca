const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const runner = path.join(repoRoot, 'agents', 'sandbox', 'runner', 'integrate-run.sh');
const validate = path.join(repoRoot, 'contracts', 'aca-sandbox', 'v1', 'tools', 'validate.js');
const workRoot = path.join(__dirname, '.work-integration');

function findBash() {
  for (const candidate of [process.env.BASH, 'bash', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].filter(Boolean)) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  return null;
}
const bash = findBash();
const allowSkipBashTests = process.env.SQUAD_ALLOW_SKIP_BASH_TESTS === '1';
if (!bash && !allowSkipBashTests) throw new Error('Git Bash is required for integration-run tests.');
function processTreeKillSkipReason() {
  if (!bash) return 'Git Bash is not available';
  if (process.platform !== 'win32') return false;
  const result = spawnSync('taskkill', ['/?'], { encoding: 'utf8' });
  if (!result.error) return false;
  if (process.env.SQUAD_REQUIRE_PROCESS_TREE_KILL_TEST === '1') throw result.error;
  return `taskkill is not available: ${result.error.message}`;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}
function bashPath(windowsPath) {
  if (!bash) return windowsPath;
  return run(bash, ['-lc', 'if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf "%s" "$1"; fi', 'bash', windowsPath]);
}
function git(args, cwd) { return run('git', args, { cwd }); }
function resetDir(dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
function member(id) { return { logical_member_id: id, resolved_persistent_name: `Test ${id}`, charter_ref: `.squad/agents/${id}/charter.md`, membership: 'persona', capabilities: ['container'] }; }
function createRepo(name) {
  const repo = path.join(workRoot, name, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init'], repo); git(['config', 'user.name', 'Integration Test'], repo); git(['config', 'user.email', 'integration-test@example.invalid'], repo);
  for (const dir of ['alpha', 'beta', 'shared', '.github/workflows']) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.writeFileSync(path.join(repo, 'alpha', 'base.txt'), 'alpha baseline\n');
  fs.writeFileSync(path.join(repo, 'beta', 'base.txt'), 'beta baseline\n');
  fs.writeFileSync(path.join(repo, 'shared', 'base.txt'), 'shared baseline\n');
  git(['add', '.'], repo); git(['commit', '-m', 'baseline'], repo);
  const baseline = git(['rev-parse', 'HEAD'], repo);
  const bundle = path.join(workRoot, name, 'baseline.bundle');
  git(['bundle', 'create', bundle, 'HEAD'], repo);
  return { repo, baseline, bundle };
}
function addBaselineSymlink(repo) {
  const targetFile = path.join(repo, '.symlink-target.txt');
  fs.writeFileSync(targetFile, '..\n');
  const oid = git(['hash-object', '-w', targetFile], repo);
  fs.rmSync(targetFile, { force: true });
  git(['update-index', '--add', '--cacheinfo', `120000,${oid},shared/baseline-link`], repo);
  git(['commit', '-m', 'baseline symlink'], repo);
  return git(['rev-parse', 'HEAD'], repo);
}
function patchFor(repo, baseline, rel, content, patchFile) {
  const file = path.join(repo, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  spawnSync('git', ['add', '-N', '--', '.'], { cwd: repo, encoding: 'utf8' });
  const patch = spawnSync('git', ['diff', '--binary', baseline, '--', '.'], { cwd: repo, encoding: 'utf8' });
  assert.equal(patch.status, 0, patch.stderr);
  fs.writeFileSync(patchFile, patch.stdout.endsWith('\n') ? patch.stdout : `${patch.stdout}\n`);
  git(['reset', '--hard', baseline], repo);
  git(['clean', '-fd'], repo);
}
function writeAddFilePatch(repo, rel, content, patchFile) {
  const temp = path.join(repo, '.patch-content.tmp');
  fs.writeFileSync(temp, content);
  const oid = git(['hash-object', temp], repo).slice(0, 7);
  fs.rmSync(temp, { force: true });
  fs.writeFileSync(patchFile, `diff --git a/${rel} b/${rel}\nnew file mode 100644\nindex 0000000..${oid}\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1 @@\n+${content.replace(/\n$/, '')}\n`);
}
function sha256(file) { return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function envelope(caseDir, baseline, tasks, checks = undefined) {
  const members = [...new Map(tasks.map(task => [task.owner.logical_member_id, task.owner])).values()];
  const value = { schema_version: 'aca-sandbox/v1', message_type: 'integration.dispatch', run_id: `run-${path.basename(caseDir)}`, provider: { id: 'test-provider', kind: 'aca-sandbox', contract_version: 'aca-sandbox-provider/v1' }, baseline_sha: baseline, roster: { revision: 'test-roster-1', hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', members }, allow_3way: 'false', tasks };
  if (checks !== undefined) value.check_commands = checks;
  return value;
}
function runIntegration(name, configure, options = {}) {
  const caseDir = path.join(workRoot, name); resetDir(caseDir);
  const repoInfo = createRepo(name);
  const repo = repoInfo.repo;
  let baseline = repoInfo.baseline;
  let bundle = repoInfo.bundle;
  if (options.repoPatch) {
    baseline = options.repoPatch(repo, baseline) || git(['rev-parse', 'HEAD'], repo);
    bundle = path.join(workRoot, name, 'baseline.bundle');
    fs.rmSync(bundle, { force: true });
    git(['bundle', 'create', bundle, 'HEAD'], repo);
  }
  const inputDir = path.join(caseDir, 'input'); fs.mkdirSync(path.join(inputDir, 'patches'), { recursive: true });
  const ownerA = member('test-alpha'); const ownerB = member('test-beta');
  const ctx = { caseDir, inputDir, repo, baseline, bundle, ownerA, ownerB };
  const spec = configure(ctx);
  const dispatch = envelope(caseDir, baseline, spec.tasks, spec.checks);
  const dispatchPath = path.join(inputDir, 'integration-dispatch.json');
  fs.writeFileSync(dispatchPath, `${JSON.stringify(dispatch, null, 2)}\n`);
  const outputDir = path.join(caseDir, 'output'); fs.mkdirSync(outputDir, { recursive: true });
  const result = spawnSync(bash, [bashPath(runner), bashPath(dispatchPath), bashPath(bundle), bashPath(outputDir)], { encoding: 'utf8', env: options.env || {} });
  return { result, outputDir, repo, baseline };
}
function readResult(outputDir) { return JSON.parse(fs.readFileSync(path.join(outputDir, 'integration-result.json'), 'utf8')); }
function assertValid(outputDir) {
  run('node', [validate, 'integration-result.schema.json', path.join(outputDir, 'integration-result.json')], { cwd: repoRoot });
  run('node', [validate, 'artifact-manifest.schema.json', path.join(outputDir, 'artifact-manifest.json')], { cwd: repoRoot });
}

test.beforeEach(() => resetDir(workRoot));

test('integration runner combines two disjoint patches into one patch that applies', { skip: !bash && 'Git Bash is not available' }, () => {
  const { result, outputDir, repo, baseline } = runIntegration('happy', ({ repo, baseline, inputDir, ownerA, ownerB }) => {
    patchFor(repo, baseline, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    patchFor(repo, baseline, 'beta/result.txt', 'beta changed\n', path.join(inputDir, 'patches', 'task-beta.patch'));
    return { tasks: [
      { task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } },
      { task_id: 'task-beta', owner: ownerB, dependencies: [{ task_id: 'task-alpha' }], owned_paths: ['beta'], patch_ref: { path: 'patches/task-beta.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-beta.patch')) } }
    ] };
  });
  assert.equal(result.status, 0, result.stderr);
  assertValid(outputDir);
  const patch = path.join(outputDir, 'patches', 'integrated.patch');
  assert.equal(spawnSync('git', ['apply', '--check', patch], { cwd: repo }).status, 0);
  assert.match(fs.readFileSync(patch, 'utf8'), /alpha\/result\.txt/);
  assert.match(fs.readFileSync(patch, 'utf8'), /beta\/result\.txt/);
});

test('integration runner fails on apply conflict and identifies the task', { skip: !bash && 'Git Bash is not available' }, () => {
  const { result, outputDir } = runIntegration('conflict', ({ repo, baseline, inputDir, ownerA, ownerB }) => {
    patchFor(repo, baseline, 'shared/base.txt', 'first change\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    patchFor(repo, baseline, 'shared/base.txt', 'second change\n', path.join(inputDir, 'patches', 'task-beta.patch'));
    return { tasks: [
      { task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['shared'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } },
      { task_id: 'task-beta', owner: ownerB, dependencies: [], owned_paths: ['shared'], patch_ref: { path: 'patches/task-beta.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-beta.patch')) } }
    ] };
  });
  assert.notEqual(result.status, 0);
  assertValid(outputDir);
  const integration = readResult(outputDir);
  assert.equal(integration.status, 'failed');
  assert.equal(integration.failed_task_id, 'task-beta');
  assert.equal(fs.existsSync(path.join(outputDir, 'patches', 'integrated.patch')), false);
});

test('integration runner rejects overlapping changed paths before applying the second patch', { skip: !bash && 'Git Bash is not available' }, () => {
  const { outputDir } = runIntegration('overlap', ({ repo, baseline, inputDir, ownerA, ownerB }) => {
    patchFor(repo, baseline, 'shared/base.txt', 'first change\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    patchFor(repo, baseline, 'shared/base.txt', 'second change\n', path.join(inputDir, 'patches', 'task-beta.patch'));
    return { tasks: [
      { task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['shared'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } },
      { task_id: 'task-beta', owner: ownerB, dependencies: [{ task_id: 'task-alpha' }], owned_paths: ['shared'], patch_ref: { path: 'patches/task-beta.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-beta.patch')) } }
    ] };
  });
  const integration = readResult(outputDir);
  assert.equal(integration.error.code, 'OVERLAPPING_PATCH_PATH');
  assert.equal(integration.failed_task_id, 'task-beta');
});

test('integration runner rejects protected path changes', { skip: !bash && 'Git Bash is not available' }, () => {
  const { outputDir } = runIntegration('protected', ({ repo, baseline, inputDir, ownerA }) => {
    patchFor(repo, baseline, '.github/workflows/ci.yml', 'name: forbidden\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['.github/workflows'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }] };
  });
  const integration = readResult(outputDir);
  assert.equal(integration.status, 'failed');
  assert.match(integration.error.code, /DISPATCH_INVALID|PATH_OWNERSHIP/);
});

test('integration runner fails check commands and captures output', { skip: !bash && 'Git Bash is not available' }, () => {
  const { outputDir } = runIntegration('check-fail', ({ repo, baseline, inputDir, ownerA }) => {
    patchFor(repo, baseline, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }], checks: [{ name: 'failing-check', argv: [process.execPath, '-e', 'console.log("check stdout"); console.error("check stderr"); process.exit(5)'] }] };
  });
  const integration = readResult(outputDir);
  assert.equal(integration.error.code, 'CHECK_COMMAND_FAILED');
  assert.match(integration.check_results[0].stdout, /check stdout/);
  assert.match(integration.check_results[0].stderr, /check stderr/);
});

test('integration runner runs checks in an isolated copy', { skip: !bash && 'Git Bash is not available' }, () => {
  const { result, outputDir, repo } = runIntegration('check-edits-copy', ({ repo, baseline, inputDir, ownerA }) => {
    patchFor(repo, baseline, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }], checks: [{ name: 'isolated-mutating-check', argv: [process.execPath, '-e', 'const fs=require("fs"); fs.writeFileSync("alpha/result.txt", "mutated by check\\n"); fs.writeFileSync("ignored.tmp", "ignored mutation\\n");'] }] };
  });
  assert.equal(result.status, 0, result.stderr);
  assertValid(outputDir);
  const integration = readResult(outputDir);
  assert.equal(integration.status, 'succeeded');
  assert.equal(fs.existsSync(path.join(repo, 'ignored.tmp')), false);
});

test('integration runner detects a check writing to the source repository', { skip: !bash && 'Git Bash is not available' }, () => {
  const { result, outputDir } = runIntegration('check-source-write', ({ repo, baseline, inputDir, ownerA }) => {
    patchFor(repo, baseline, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }], checks: [{ name: 'source-mutating-check', argv: [process.execPath, '-e', 'const fs=require("fs"); const path=require("path"); fs.writeFileSync(path.join(process.env.SQUAD_INTEGRATION_TEST_SOURCE_REPO_PATH, "alpha", "result.txt"), "mutated source\\n");'] }] };
  }, { env: { ...process.env, SQUAD_INTEGRATION_TEST_EXPOSE_SOURCE_REPO: '1' } });
  assert.notEqual(result.status, 0);
  const integration = readResult(outputDir);
  assert.equal(integration.error.code, 'checks_mutated_tree');
});

test('integration runner detects a check changing git config', { skip: !bash && 'Git Bash is not available' }, () => {
  const { result, outputDir } = runIntegration('check-git-config-write', ({ repo, baseline, inputDir, ownerA }) => {
    patchFor(repo, baseline, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }], checks: [{ name: 'git-config-mutating-check', argv: [process.execPath, '-e', 'const fs=require("fs"); const path=require("path"); fs.appendFileSync(path.join(process.env.SQUAD_INTEGRATION_TEST_SOURCE_REPO_PATH, ".git", "config"), "\\n[core]\\n\\tfileMode = false\\n");'] }] };
  }, { env: { ...process.env, SQUAD_INTEGRATION_TEST_EXPOSE_SOURCE_REPO: '1' } });
  assert.notEqual(result.status, 0);
  const integration = readResult(outputDir);
  assert.equal(integration.error.code, 'checks_mutated_tree');
});

test('integration runner kills check process descendants on timeout', { skip: processTreeKillSkipReason() }, () => {
  let pidFile = '';
  const started = Date.now();
  const { result, outputDir } = runIntegration('check-timeout-descendant', ({ caseDir, repo, baseline, inputDir, ownerA }) => {
    pidFile = path.join(caseDir, 'descendant.pid');
    patchFor(repo, baseline, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    const script = `const cp=require("child_process"); const fs=require("fs"); const child=cp.spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {stdio:"ignore"}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setTimeout(()=>{}, 60000);`;
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }], checks: [{ name: 'timeout-with-child', argv: [process.execPath, '-e', script], timeout_ms: 500 }] };
  });
  assert.notEqual(result.status, 0);
  assert(Date.now() - started < 20000, 'runner should return promptly after timeout');
  const integration = readResult(outputDir);
  assert.equal(integration.error.code, 'CHECK_COMMAND_FAILED');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0));
});

test('integration runner rejects string check commands', { skip: !bash && 'Git Bash is not available' }, () => {
  const { outputDir } = runIntegration('check-string', ({ repo, baseline, inputDir, ownerA }) => {
    patchFor(repo, baseline, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }], checks: [{ name: 'bad-check', argv: 'node -v' }] };
  });
  const integration = readResult(outputDir);
  assert.equal(integration.error.code, 'INTEGRATION_DISPATCH_INVALID');
});

test('integration runner validates both sides of a rename against ownership', { skip: !bash && 'Git Bash is not available' }, () => {
  const { outputDir } = runIntegration('rename-source', ({ repo, baseline, inputDir, ownerA }) => {
    git(['mv', 'beta/base.txt', 'alpha/stolen.txt'], repo);
    const patch = spawnSync('git', ['diff', '--binary', baseline, '--', '.'], { cwd: repo, encoding: 'utf8' });
    assert.equal(patch.status, 0, patch.stderr);
    const patchPath = path.join(inputDir, 'patches', 'task-alpha.patch');
    fs.writeFileSync(patchPath, patch.stdout.endsWith('\n') ? patch.stdout : `${patch.stdout}\n`);
    git(['reset', '--hard', baseline], repo);
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(patchPath) } }] };
  });
  const integration = readResult(outputDir);
  assert.equal(integration.error.code, 'PATH_OWNERSHIP_VIOLATION');
});

test('integration runner rejects symlink patches', { skip: !bash && 'Git Bash is not available' }, () => {
  const { outputDir } = runIntegration('symlink-reject', ({ inputDir, ownerA }) => {
    const patchPath = path.join(inputDir, 'patches', 'task-alpha.patch');
    fs.writeFileSync(patchPath, 'diff --git a/alpha/link.txt b/alpha/link.txt\nnew file mode 120000\nindex 0000000..e69de29\n--- /dev/null\n+++ b/alpha/link.txt\n@@ -0,0 +1 @@\n+base.txt\n');
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(patchPath) } }] };
  });
  const integration = readResult(outputDir);
  assert.notEqual(integration.status, 'succeeded');
  assert.match(integration.error.code, /PATCH_CONTENT_POLICY_VIOLATION|PATCH_APPLY_CHECK_FAILED|PATCH_APPLY_FAILED/);
});

test('integration runner rejects baseline symlinks before running configured checks', { skip: !bash && 'Git Bash is not available' }, () => {
  let marker = '';
  const { result, outputDir } = runIntegration('baseline-symlink-check-fail', ({ caseDir, repo, baseline, inputDir, ownerA }) => {
    marker = path.join(caseDir, 'check-ran.marker');
    writeAddFilePatch(repo, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "check ran");`;
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }], checks: [{ name: 'must-not-run', argv: [process.execPath, '-e', script] }] };
  }, { repoPatch: repo => addBaselineSymlink(repo) });
  assert.notEqual(result.status, 0);
  const integration = readResult(outputDir);
  assert.equal(integration.error.code, 'check_tree_contains_symlink');
  assert.equal(fs.existsSync(marker), false, 'check command must not run after a baseline symlink is found');
});

test('integration runner allows baseline symlinks when no checks are configured', { skip: !bash && 'Git Bash is not available' }, () => {
  const { result, outputDir } = runIntegration('baseline-symlink-no-checks', ({ repo, baseline, inputDir, ownerA }) => {
    writeAddFilePatch(repo, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }] };
  }, { repoPatch: repo => addBaselineSymlink(repo) });
  assert.equal(result.status, 0, result.stderr);
  const integration = readResult(outputDir);
  assert.equal(integration.status, 'succeeded');
});

test('integration runner rejects gitlink patches', { skip: !bash && 'Git Bash is not available' }, () => {
  const { outputDir } = runIntegration('gitlink-reject', ({ inputDir, ownerA }) => {
    const patchPath = path.join(inputDir, 'patches', 'task-alpha.patch');
    fs.writeFileSync(patchPath, 'diff --git a/alpha/submodule b/alpha/submodule\nnew file mode 160000\nindex 0000000..0123456\n--- /dev/null\n+++ b/alpha/submodule\n@@ -0,0 +1 @@\n+Subproject commit 0123456789012345678901234567890123456789\n');
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(patchPath) } }] };
  });
  const integration = readResult(outputDir);
  assert.notEqual(integration.status, 'succeeded');
  assert.match(integration.error.code, /PATCH_CONTENT_POLICY_VIOLATION|PATCH_APPLY_CHECK_FAILED|PATCH_APPLY_FAILED/);
});

test('integration runner rejects .git path patches', { skip: !bash && 'Git Bash is not available' }, () => {
  const { outputDir } = runIntegration('gitdir-reject', ({ inputDir, ownerA }) => {
    const patchPath = path.join(inputDir, 'patches', 'task-alpha.patch');
    fs.writeFileSync(patchPath, 'diff --git a/.git/config b/.git/config\nnew file mode 100644\nindex 0000000..257cc56\n--- /dev/null\n+++ b/.git/config\n@@ -0,0 +1 @@\n+unsafe\n');
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['.'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(patchPath) } }] };
  });
  const integration = readResult(outputDir);
  assert.notEqual(integration.status, 'succeeded');
});

test('integration runner rejects executable mode additions by default', { skip: !bash && 'Git Bash is not available' }, () => {
  const { outputDir } = runIntegration('exec-reject', ({ repo, baseline, inputDir, ownerA }) => {
    fs.writeFileSync(path.join(repo, 'alpha', 'script.sh'), '#!/usr/bin/env bash\necho hi\n');
    git(['add', 'alpha/script.sh'], repo);
    git(['update-index', '--chmod=+x', 'alpha/script.sh'], repo);
    const patch = spawnSync('git', ['diff', '--binary', '--cached', baseline, '--', '.'], { cwd: repo, encoding: 'utf8' });
    const patchPath = path.join(inputDir, 'patches', 'task-alpha.patch');
    fs.writeFileSync(patchPath, patch.stdout.endsWith('\n') ? patch.stdout : `${patch.stdout}\n`);
    git(['reset', '--hard', baseline], repo);
    git(['clean', '-fd'], repo);
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(patchPath) } }] };
  });
  const integration = readResult(outputDir);
  assert.equal(integration.error.code, 'PATCH_CONTENT_POLICY_VIOLATION');
});

test('integration runner supports patches larger than the old capture limit', { skip: !bash && 'Git Bash is not available' }, () => {
  const { result, outputDir } = runIntegration('large-patch', ({ repo, baseline, inputDir, ownerA, ownerB }) => {
    patchFor(repo, baseline, 'alpha/large.txt', `${'a'.repeat(100 * 1024)}\n`, path.join(inputDir, 'patches', 'task-alpha.patch'));
    patchFor(repo, baseline, 'beta/large.txt', `${'b'.repeat(100 * 1024)}\n`, path.join(inputDir, 'patches', 'task-beta.patch'));
    return { tasks: [
      { task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } },
      { task_id: 'task-beta', owner: ownerB, dependencies: [], owned_paths: ['beta'], patch_ref: { path: 'patches/task-beta.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-beta.patch')) } }
    ] };
  });
  assert.equal(result.status, 0, result.stderr);
  assertValid(outputDir);
  assert(fs.statSync(path.join(outputDir, 'patches', 'integrated.patch')).size > 64 * 1024);
});

test('integration runner fails closed when plumbing output exceeds the configured limit', { skip: !bash && 'Git Bash is not available' }, () => {
  const { outputDir } = runIntegration('tiny-output-cap', ({ repo, baseline, inputDir, ownerA }) => {
    patchFor(repo, baseline, 'alpha/large.txt', `${'a'.repeat(4096)}\n`, path.join(inputDir, 'patches', 'task-alpha.patch'));
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches/task-alpha.patch')) } }] };
  }, { env: { SQUAD_INTEGRATION_MAX_PLUMBING_BYTES: '256' } });
  const integration = readResult(outputDir);
  assert.equal(integration.error.code, 'output_limit_exceeded');
});

test('integration runner rejects invalid plumbing limits before reading inputs', { skip: !bash && 'Git Bash is not available' }, () => {
  for (const [name, value] of [['above-ceiling', String(256 * 1024 * 1024 + 1)], ['garbage', '12garbage']]) {
    const caseDir = path.join(workRoot, `bad-plumbing-${name}`);
    resetDir(caseDir);
    const outputDir = path.join(caseDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const result = spawnSync(bash, [bashPath(runner), bashPath(path.join(caseDir, 'missing-dispatch.json')), bashPath(path.join(caseDir, 'missing.bundle')), bashPath(outputDir)], {
      encoding: 'utf8',
      env: { ...process.env, SQUAD_INTEGRATION_MAX_PLUMBING_BYTES: value }
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /SQUAD_INTEGRATION_MAX_PLUMBING_BYTES/);
    assert.equal(fs.existsSync(path.join(outputDir, 'integration-result.json')), false);
  }
});

test('integration runner cleanup preserves unrelated integration siblings on success and failure', { skip: !bash && 'Git Bash is not available' }, () => {
  for (const name of ['cleanup-success', 'cleanup-failure']) {
    let sibling = '';
    const { result } = runIntegration(name, ({ caseDir, repo, baseline, inputDir, ownerA }) => {
      sibling = path.join(caseDir, '.integration-foo');
      fs.mkdirSync(sibling, { recursive: true });
      patchFor(repo, baseline, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
      const checks = name.endsWith('failure') ? [{ name: 'fail', argv: [process.execPath, '-e', 'process.exit(2)'] }] : undefined;
      return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }], checks };
    });
    assert.equal(name.endsWith('failure') ? result.status !== 0 : result.status === 0, true);
    assert.equal(fs.existsSync(sibling), true);
  }
});

test('integration runner removes partial check materialization after read-tree failure', { skip: !bash && 'Git Bash is not available' }, () => {
  let caseDir = '';
  const { result } = runIntegration('check-materialize-cleanup', (ctx) => {
    caseDir = ctx.caseDir;
    const { repo, baseline, inputDir, ownerA } = ctx;
    patchFor(repo, baseline, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
    return { tasks: [{ task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }], checks: [{ name: 'cleanup-check', argv: [process.execPath, '-e', 'process.exit(0)'] }] };
  }, { env: { ...process.env, SQUAD_INTEGRATION_TEST_MATERIALIZE_TREE: 'not-a-tree' } });
  assert.notEqual(result.status, 0);
  const leftovers = fs.readdirSync(caseDir).filter(name => name.startsWith('.integration-check-cleanup-check.'));
  assert.deepEqual(leftovers, []);
});

test('integration runner is deterministic for identical inputs', { skip: !bash && 'Git Bash is not available' }, () => {
  function runCase(name) {
    return runIntegration(name, ({ repo, baseline, inputDir, ownerA, ownerB }) => {
      patchFor(repo, baseline, 'beta/result.txt', 'beta changed\n', path.join(inputDir, 'patches', 'task-beta.patch'));
      patchFor(repo, baseline, 'alpha/result.txt', 'alpha changed\n', path.join(inputDir, 'patches', 'task-alpha.patch'));
      return { tasks: [
        { task_id: 'task-beta', owner: ownerB, dependencies: [], owned_paths: ['beta'], patch_ref: { path: 'patches/task-beta.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-beta.patch')) } },
        { task_id: 'task-alpha', owner: ownerA, dependencies: [], owned_paths: ['alpha'], patch_ref: { path: 'patches/task-alpha.patch', sha256: sha256(path.join(inputDir, 'patches', 'task-alpha.patch')) } }
      ] };
    });
  }
  const first = runCase('deterministic-one');
  const second = runCase('deterministic-two');
  assert.equal(sha256(path.join(first.outputDir, 'patches', 'integrated.patch')), sha256(path.join(second.outputDir, 'patches', 'integrated.patch')));
  assert.equal(fs.readFileSync(path.join(first.outputDir, 'patches', 'integrated.patch'), 'utf8'), fs.readFileSync(path.join(second.outputDir, 'patches', 'integrated.patch'), 'utf8'));
});
