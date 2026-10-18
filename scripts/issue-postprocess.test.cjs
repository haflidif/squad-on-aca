'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runPostprocess, validateConfig, validPathPattern, pathMatches, selectSteps, findScopeViolations } = require('./issue-postprocess.cjs');
const { installTools } = require('./install-sandbox-tools.cjs');

const TOOL = { node: { version: '22.14.0', url: 'https://example.invalid/node', sha256: 'a'.repeat(64) } };
function config(steps = [{ name: 'format', run: ['node', '-e', 'process.exit(0)'], paths: ['src/**'] }]) {
  return { version: 1, members: {}, postprocess: { tools: {}, steps } };
}
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function digest(bytes) { return require('node:crypto').createHash('sha256').update(bytes).digest('hex'); }

test('validates generic argv tools and strict tool pins', () => {
  assert.equal(validateConfig(config()).steps.length, 1);
  const pinned = config([{ name: 'lint', run: ['formatter', '--check', 'src'], paths: ['src/**'] }]);
  pinned.postprocess.tools = { formatter: { ...TOOL.node } };
  assert.deepEqual(validateConfig(pinned).tools, pinned.postprocess.tools);
  for (const command of ['bash', 'sh', 'npm', '../node']) {
    assert.throws(() => validateConfig(config([{ name: 'bad-tool', run: [command], paths: ['src/**'] }])), /executable/);
  }
  for (const invalid of [
    { ...TOOL.node, version: 'latest' },
    { ...TOOL.node, url: 'http://example.invalid/tool' },
    { ...TOOL.node, sha256: 'not-a-checksum' },
    { ...TOOL.node, extra: true }
  ]) {
    const value = config([{ name: 'lint', run: ['formatter'], paths: ['src/**'] }]);
    value.postprocess.tools = { formatter: invalid };
    assert.throws(() => validateConfig(value), /postprocess\.tools/);
  }
  const missingTool = config([{ name: 'lint', run: ['formatter'], paths: ['src/**'] }]);
  assert.throws(() => validateConfig(missingTool), /executable/);
  assert.throws(() => validateConfig({ version: 1, postprocess: { steps: [{ name: 'escape', run: ['node', '../outside.js'], paths: ['src/**'] }] } }), /path/);
});

test('rejects malformed, absolute, and traversal postprocess paths while allowing generic repository areas', () => {
  for (const pattern of ['../outside/**', 'src/../../secrets', '/absolute/**', 'C:\\repo\\**', 'src\\file.js', 'src//file.js']) {
    assert.equal(validPathPattern(pattern), false, pattern);
  }
  for (const pattern of ['src/**', 'docs/**', 'infra/**', 'dispatcher/**', 'scripts/**']) {
    assert.equal(validPathPattern(pattern), true, pattern);
  }
  for (const pattern of ['../outside/**', '/absolute/**']) {
    assert.throws(() => validateConfig(config([{ name: 'bad-path', run: ['node', '-e', ''], paths: [pattern] }])), /steps/);
  }
});

test('enforces bounded steps and timeout values', () => {
  const steps = Array.from({ length: 11 }, (_, i) => ({ name: `step-${i}`, run: ['node', '-e', ''], paths: ['src/**'] }));
  assert.throws(() => validateConfig(config(steps)), /steps/);
  assert.throws(() => validateConfig(config([{ name: 'slow', run: ['node', '-e', ''], paths: ['src/**'], timeout_ms: 600001 }])), /steps/);
});

test('matches generic globs and selects only steps for touched files', () => {
  const value = config([
    { name: 'source-check', run: ['node', '-e', ''], paths: ['src/**'] },
    { name: 'docs-check', run: ['node', '-e', ''], paths: ['docs/**/*.md'] }
  ]);
  assert.equal(pathMatches('src/**', 'src/module/file.js'), true);
  assert.deepEqual(selectSteps(validateConfig(value), ['README.md', 'src/file.js']), [value.postprocess.steps[0]]);
  assert.deepEqual(selectSteps(validateConfig(value), ['README.md']), []);
});

test('rejects postprocess changes outside step scope and denied engine paths', () => {
  const step = { paths: ['src/**'] };
  assert.deepEqual(findScopeViolations(new Map([['src/main.js', 'a']]), new Map([['src/main.js', 'b']]), step, 'C:\\repo'), []);
  assert.deepEqual(findScopeViolations(new Map(), new Map([['README.md', 'new']]), step, 'C:\\repo'), ['README.md']);
  assert.deepEqual(findScopeViolations(new Map(), new Map([['.github/workflows/ci.yml', 'new']]), { paths: ['**'] }, 'C:\\repo'), ['.github/workflows/ci.yml']);
  assert.deepEqual(findScopeViolations(new Map([['src/main.js', 'a']]), new Map(), step, 'C:\\repo'), []);
});

test('loads flow config from the trusted checkout and applies a configured step', () => {
  const scratch = fs.mkdtempSync(path.join(__dirname, '.issue-postprocess-fixture-'));
  const repo = path.join(scratch, 'repo');
  const artifact = path.join(scratch, 'input');
  const output = path.join(scratch, 'output');
  try {
    fs.mkdirSync(path.join(repo, '.squad'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const flowConfig = config([{ name: 'format-source', run: ['node', '-e', 'require("node:fs").writeFileSync("src/main.js", "formatted\\n")'], paths: ['src/**'] }]);
    fs.writeFileSync(path.join(repo, '.squad', 'sandbox-flow.json'), JSON.stringify(flowConfig));
    fs.writeFileSync(path.join(repo, 'src', 'main.js'), 'baseline\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'baseline\n');
    git(['init', '--quiet'], repo);
    git(['config', 'user.name', 'Postprocess Test'], repo);
    git(['config', 'user.email', 'postprocess@example.invalid'], repo);
    git(['add', '.'], repo);
    git(['commit', '--quiet', '-m', 'baseline'], repo);
    const baseline = git(['rev-parse', 'HEAD'], repo).trim();
    fs.writeFileSync(path.join(repo, 'src', 'main.js'), 'member change\n');
    const patchBytes = Buffer.from(git(['diff', '--binary', '--full-index', '--no-renames'], repo));
    const patchRel = 'integration/patches/combined.patch';
    const patchFile = path.join(artifact, ...patchRel.split('/'));
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, patchBytes);
    const sha = digest(patchBytes);
    fs.writeFileSync(path.join(artifact, 'dispatcher-summary.json'), JSON.stringify({ run_id: 'execution-1', baseline_sha: baseline, integration: { integrated_patch_path: patchRel, sha256: sha } }));
    fs.mkdirSync(path.join(artifact, 'integration'), { recursive: true });
    fs.writeFileSync(path.join(artifact, 'integration', 'artifact-manifest.json'), JSON.stringify({ task_id: 'integration', run_id: 'execution-1', baseline_sha: baseline, artifacts: [{ kind: 'patch', path: 'patches/combined.patch', sha256: sha, size_bytes: patchBytes.length }] }));
    git(['checkout', '--quiet', '--', '.'], repo);
    runPostprocess({ artifactDir: artifact, repo, outputDir: output, runId: '42', runAttempt: '3' });
    const resultPatch = fs.readFileSync(path.join(output, ...patchRel.split('/')));
    assert.notEqual(digest(resultPatch), sha);
    assert.match(resultPatch.toString(), /formatted/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'postprocess-binding.json'), 'utf8')).patch_sha256, digest(resultPatch));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});


test('generic installer verifies a pinned download before exposing its executable', async () => {
  const scratch = fs.mkdtempSync(path.join(__dirname, '.sandbox-tool-install-'));
  const repo = path.join(scratch, 'repo');
  const destination = path.join(scratch, 'bin');
  const githubPath = path.join(scratch, 'github-path');
  const bytes = Buffer.from('pinned executable fixture');
  const sha256 = digest(bytes);
  const originalFetch = global.fetch;
  const previousGithubPath = process.env.GITHUB_PATH;
  try {
    fs.mkdirSync(path.join(repo, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.squad', 'sandbox-flow.json'), JSON.stringify({ version: 1, postprocess: {
      tools: { formatter: { version: '1.2.3', url: 'https://example.invalid/formatter', sha256 } },
      steps: [{ name: 'format', run: ['formatter', '--check'], paths: ['src/**'] }]
    } }));
    process.env.GITHUB_PATH = githubPath;
    global.fetch = async () => {
      let read = false;
      return { ok: true, url: 'https://example.invalid/formatter', body: { getReader: () => ({
        read: async () => read ? { done: true } : (read = true, { done: false, value: bytes }),
        cancel: async () => {}
      }) } };
    };
    assert.deepEqual(await installTools(repo, destination), [{ name: 'formatter', version: '1.2.3' }]);
    assert.deepEqual(fs.readFileSync(path.join(destination, 'formatter')), bytes);
    assert.equal(fs.readFileSync(githubPath, 'utf8'), `${destination}\n`);
    global.fetch = async () => {
      let read = false;
      return { ok: true, url: 'https://example.invalid/formatter', body: { getReader: () => ({
        read: async () => read ? { done: true } : (read = true, { done: false, value: Buffer.from('tampered') }),
        cancel: async () => {}
      }) } };
    };
    await assert.rejects(() => installTools(repo, destination), /SANDBOX_TOOL_CHECKSUM_FAILED/);
  } finally {
    global.fetch = originalFetch;
    if (previousGithubPath === undefined) delete process.env.GITHUB_PATH; else process.env.GITHUB_PATH = previousGithubPath;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('CLI validates args and passes through unchanged when no flow config exists', () => {
  const scratch = fs.mkdtempSync(path.join(__dirname, '.issue-postprocess-cli-'));
  const repo = path.join(scratch, 'repo');
  const artifact = path.join(scratch, 'input');
  const output = path.join(scratch, 'output');
  const script = path.join(__dirname, 'issue-postprocess.cjs');
  const patch = Buffer.from('passthrough patch\n');
  const sha = digest(patch);
  const baseline = 'a'.repeat(40);
  try {
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(artifact, 'integration', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(artifact, 'integration', 'patches', 'combined.patch'), patch);
    fs.writeFileSync(path.join(artifact, 'dispatcher-summary.json'), JSON.stringify({ run_id: 'execution-cli', baseline_sha: baseline, integration: { integrated_patch_path: 'integration/patches/combined.patch', sha256: sha } }));
    fs.writeFileSync(path.join(artifact, 'integration', 'artifact-manifest.json'), JSON.stringify({ task_id: 'integration', run_id: 'execution-cli', baseline_sha: baseline, artifacts: [{ kind: 'patch', path: 'patches/combined.patch', sha256: sha, size_bytes: patch.length }] }));
    const validation = spawnSync(process.execPath, [script, 'validate', '--repo', repo], { encoding: 'utf8' });
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /tools=0/);
    const result = spawnSync(process.execPath, [script, 'run', '--artifact', artifact, '--repo', repo, '--output', output, '--run-id', '39019327207', '--run-attempt', '2'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /POSTPROCESS_RESULT selected=none/);
    assert.deepEqual(fs.readFileSync(path.join(output, 'integration', 'patches', 'combined.patch')), patch);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'postprocess-binding.json'), 'utf8')), { schema_version: 1, run_id: '39019327207', run_attempt: '2', execution_id: 'execution-cli', baseline_sha: baseline, patch_sha256: sha });
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
