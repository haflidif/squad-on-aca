#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function artifactKind(relativePath) {
  if (relativePath.endsWith('.patch')) return 'patch';
  if (relativePath.endsWith('.log')) return 'log';
  if (relativePath.endsWith('.txt')) return 'report';
  return 'other';
}

const [dispatchPath, outputDir, status, summary, errorCode, errorMessage] = process.argv.slice(2);
if (!dispatchPath || !outputDir || !status || !summary) {
  console.error('Usage: write-result.js <dispatch> <output-dir> <status> <summary> [error-code] [error-message]');
  process.exit(2);
}

const dispatch = readJson(dispatchPath);
const minimalResult = process.env.SQUAD_RESULT_MODE === 'minimal'
  || process.env.SQUAD_RESULT_MODE === 'credential-leak-minimal';
let artifactFiles = [];

if (!minimalResult) {
  artifactFiles = [
    path.join(outputDir, 'patches', `${dispatch.task_id}.patch`),
    path.join(outputDir, 'logs', 'copilot-output.log'),
    path.join(outputDir, 'logs', 'isolation-mode.txt'),
    path.join(outputDir, 'logs', 'credential-env-cleared.txt'),
    path.join(outputDir, 'logs', 'ignored-untracked.txt')
  ].filter(file => fs.existsSync(file));
}

let artifacts = artifactFiles.map(file => {
  const relativePath = toPosix(path.relative(outputDir, file));
  return {
    artifact_id: `${dispatch.task_id}-${relativePath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    kind: artifactKind(relativePath),
    path: relativePath,
    uri: relativePath,
    sha256: sha256(file),
    size_bytes: fs.statSync(file).size
  };
});

const manifestArtifacts = artifacts.map(({ uri, ...artifact }) => artifact);
const resultArtifacts = artifacts.map(({ path: _path, size_bytes: _size, ...artifact }) => artifact);

const manifest = {
  schema_version: dispatch.schema_version,
  run_id: dispatch.run_id,
  task_id: dispatch.task_id,
  baseline_sha: dispatch.baseline_sha,
  roster: dispatch.roster,
  provider: dispatch.provider,
  artifacts: manifestArtifacts
};

const result = {
  schema_version: dispatch.schema_version,
  message_type: 'persona.result',
  run_id: dispatch.run_id,
  task_id: dispatch.task_id,
  owner: dispatch.owner,
  status,
  summary,
  baseline_sha: dispatch.baseline_sha,
  roster: dispatch.roster,
  provider: dispatch.provider,
  artifacts: resultArtifacts
};

if (status === 'failed') {
  result.error = {
    code: errorCode || 'SANDBOX_RUNNER_FAILED',
    message: errorMessage || summary
  };
}

fs.mkdirSync(outputDir, { recursive: true });
const resultPath = path.join(outputDir, 'persona-result.json');
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

if (minimalResult) {
  const resultArtifact = {
    artifact_id: `${dispatch.task_id}-persona-result`,
    kind: 'other',
    path: 'persona-result.json',
    uri: 'persona-result.json',
    sha256: sha256(resultPath),
    size_bytes: fs.statSync(resultPath).size
  };
  artifacts = [resultArtifact];
  manifest.artifacts = artifacts.map(({ uri, ...artifact }) => artifact);
}

fs.writeFileSync(path.join(outputDir, 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
