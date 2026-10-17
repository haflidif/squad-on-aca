'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runPostprocess } = require('./issue-postprocess.cjs');
const { validateConfig, validPathPattern, pathMatches, selectSteps, findScopeViolations } = require('./issue-postprocess.cjs');

function config(steps = [{ name: 'fmt', run: ['terraform', 'fmt'], paths: ['examples/terraform/**'] }]) {
  return { version: 1, tools: { terraform: '1.9.8' }, steps };
}

test('validates allowlisted argv executables and required tool pins', () => {
  assert.equal(validateConfig(config()).steps.length, 1);
  for (const command of ['bash', 'sh', 'npm', '../node']) {
    assert.throws(() => validateConfig(config([{ name: 'bad-tool', run: [command], paths: ['examples/**'] }])), /executable/);
  }
  assert.throws(() => validateConfig({ ...config(), tools: { terraform: 'latest' } }), /tool terraform/);
  assert.throws(() => validateConfig({ version: 1, tools: {}, steps: [{ name: 'tf', run: ['terraform', 'fmt'], paths: ['examples/**'] }] }), /terraform version/);
  assert.throws(() => validateConfig(config([{ name: 'escape', run: ['terraform', 'fmt', '../README.md'], paths: ['examples/**'] }])), /path traversal/);
});

test('rejects protected, absolute, and traversal paths', () => {
  for (const pattern of ['../outside/**', 'examples/../../secrets', '/tmp/**', 'C:\\repo\\**', '.github/**', '.squad/**', 'dispatcher/**', 'scripts/**', 'infra/**', '**/.github/**', '*/terraform/**']) {
    assert.equal(validPathPattern(pattern), false, pattern);
    assert.throws(() => validateConfig(config([{ name: 'bad-path', run: ['node', 'fmt.js'], paths: [pattern] }])), /paths/);
  }
});

test('enforces the maximum step count and timeout bounds', () => {
  const steps = Array.from({ length: 11 }, (_, i) => ({ name: `step-${i}`, run: ['node', 'tool.js'], paths: ['examples/**'] }));
  assert.throws(() => validateConfig(config(steps)), /steps/);
  assert.throws(() => validateConfig(config([{ name: 'slow', run: ['node', 'tool.js'], paths: ['examples/**'], timeout_ms: 600001 }])), /timeout/);
});

test('matches globs and selects only steps matching combined-patch paths', () => {
  const value = validateConfig({ version: 1, tools: {}, steps: [
    { name: 'terraform-fmt', run: ['node', 'fmt.js'], paths: ['examples/terraform/**'] },
    { name: 'docs', run: ['node', 'docs.js'], paths: ['docs/**/*.md'] }
  ] });
  assert.equal(pathMatches('examples/terraform/**', 'examples/terraform/module/main.tf'), true);
  assert.deepEqual(selectSteps(value, ['README.md', 'examples/terraform/module/main.tf']), [value.steps[0]]);
  assert.deepEqual(selectSteps(value, ['README.md']), []);
});

test('reports files changed outside the step scope', () => {
  const step = { paths: ['examples/terraform/**'] };
  assert.deepEqual(findScopeViolations(new Map([['examples/terraform/main.tf', 'a']]), new Map([['examples/terraform/main.tf', 'b']]), step), []);
  assert.deepEqual(findScopeViolations(new Map(), new Map([['README.md', 'new']]), step), ['README.md']);
  assert.deepEqual(findScopeViolations(new Map([['examples/terraform/main.tf', 'a']]), new Map(), step), []);
  assert.equal(step.paths.length, 1);
});
test('postprocess applies selected formatter and emits a bound baseline-relative patch', () => {
  const scratch = fs.mkdtempSync(path.join(__dirname, '.issue-postprocess-fixture-'));
  const repo = path.join(scratch, 'repo');
  const artifact = path.join(scratch, 'input');
  const output = path.join(scratch, 'output');
  const runGit = (args, cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const digest = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  try {
    fs.mkdirSync(path.join(repo, '.squad'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'examples', 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.squad', 'sandbox-postprocess.json'), JSON.stringify({
      version: 1, tools: {}, steps: [{ name: 'format', run: ['node', '-e', 'require("node:fs").writeFileSync("examples/terraform/main.tf", "formatted\\n")'], paths: ['examples/terraform/**'] }]
    }));
    fs.writeFileSync(path.join(repo, 'examples', 'terraform', 'main.tf'), 'resource "x" "y" {}\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'baseline\n');
    runGit(['init', '--quiet']);
    runGit(['config', 'user.name', 'Postprocess Test']);
    runGit(['config', 'user.email', 'postprocess@example.invalid']);
    runGit(['add', '.']);
    runGit(['commit', '--quiet', '-m', 'baseline']);
    const baseline = runGit(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repo, 'examples', 'terraform', 'main.tf'), 'resource "x" "y" { # member change\n}\n');
    const patch = runGit(['diff', '--binary', '--full-index', '--no-renames']);
    const patchBytes = Buffer.from(patch);
    const patchRel = 'integration/patches/combined.patch';
    const patchFile = path.join(artifact, ...patchRel.split('/'));
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, patchBytes);
    const summary = { run_id: 'execution-1', baseline_sha: baseline, integration: { integrated_patch_path: patchRel, sha256: digest(patchBytes) } };
    const manifest = { task_id: 'integration', run_id: 'execution-1', baseline_sha: baseline, artifacts: [{ kind: 'patch', path: 'patches/combined.patch', sha256: digest(patchBytes), size_bytes: patchBytes.length }] };
    fs.writeFileSync(path.join(artifact, 'dispatcher-summary.json'), JSON.stringify(summary));
    fs.mkdirSync(path.join(artifact, 'integration'), { recursive: true });
    fs.writeFileSync(path.join(artifact, 'integration', 'artifact-manifest.json'), JSON.stringify(manifest));
    runGit(['checkout', '--quiet', '--', '.']);
    runPostprocess({ artifactDir: artifact, repo, outputDir: output, runId: '42', runAttempt: '3' });
    const resultPatch = fs.readFileSync(path.join(output, ...patchRel.split('/')));
    assert.notEqual(digest(resultPatch), digest(patchBytes));
    assert.match(resultPatch.toString(), /formatted/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'postprocess-binding.json'), 'utf8')).patch_sha256, digest(resultPatch));
    const resultSummary = JSON.parse(fs.readFileSync(path.join(output, 'dispatcher-summary.json'), 'utf8'));
    const resultManifest = JSON.parse(fs.readFileSync(path.join(output, 'integration', 'artifact-manifest.json'), 'utf8'));
    assert.equal(resultSummary.integration.sha256, digest(resultPatch));
    assert.equal(resultManifest.artifacts[0].sha256, digest(resultPatch));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('workflow CLI arguments validate and run passthrough with an exact run binding', () => {
  const scratch = fs.mkdtempSync(path.join(__dirname, '.issue-postprocess-cli-'));
  const repo = path.join(scratch, 'repo');
  const artifact = path.join(scratch, 'input');
  const output = path.join(scratch, 'output');
  const script = path.join(__dirname, 'issue-postprocess.cjs');
  const patch = Buffer.from('passthrough patch\n');
  const sha = require('node:crypto').createHash('sha256').update(patch).digest('hex');
  const baseline = 'a'.repeat(40);
  try {
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(artifact, 'integration', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(artifact, 'integration', 'patches', 'combined.patch'), patch);
    fs.writeFileSync(path.join(artifact, 'dispatcher-summary.json'), JSON.stringify({
      run_id: 'execution-cli', baseline_sha: baseline,
      integration: { integrated_patch_path: 'integration/patches/combined.patch', sha256: sha }
    }));
    fs.writeFileSync(path.join(artifact, 'integration', 'artifact-manifest.json'), JSON.stringify({
      task_id: 'integration', run_id: 'execution-cli', baseline_sha: baseline,
      artifacts: [{ kind: 'patch', path: 'patches/combined.patch', sha256: sha, size_bytes: patch.length }]
    }));
    const validation = spawnSync(process.execPath, [script, 'validate', '--repo', repo], {
      encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' }
    });
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /terraform=\r?\nterraform_docs=\r?\n/);
    const result = spawnSync(process.execPath, [script, 'run', '--artifact', artifact, '--repo', repo,
      '--output', output, '--run-id', '39019327207', '--run-attempt', '2'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /POSTPROCESS_RESULT selected=none/);
    assert.deepEqual(fs.readFileSync(path.join(output, 'integration', 'patches', 'combined.patch')), patch);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'postprocess-binding.json'), 'utf8')), {
      schema_version: 1, run_id: '39019327207', run_attempt: '2', execution_id: 'execution-cli',
      baseline_sha: baseline, patch_sha256: sha
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
