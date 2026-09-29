'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const validatorPath = path.join(root, 'agents', 'sandbox', 'build', 'validate-npm-registry.js');
const { validateNpmRegistry } = require(validatorPath);
const dockerfile = fs.readFileSync(path.join(root, 'agents', 'sandbox', 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(root, 'agents', 'sandbox', 'Dockerfile.dockerignore'), 'utf8');
const ciWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'squad-ci.yml'), 'utf8');

// Placeholder values only; none of these are real credentials.
const VALID = [
  ['public default', 'https://registry.npmjs.org/'],
  ['explicit internal feed route', 'https://packagefeedproxy.microsoft.io/npm/'],
  ['host with port and path', 'https://mirror.example.test:8443/npm/'],
];

const INVALID = [
  ['plain http', 'http://registry.npmjs.org/'],
  ['userinfo user and password', 'https://user:placeholder@mirror.example.test/npm/'],
  ['userinfo user only', 'https://user@mirror.example.test/npm/'],
  ['query token', 'https://mirror.example.test/npm?token=placeholder'],
  ['empty query', 'https://mirror.example.test/npm/?'],
  ['fragment', 'https://mirror.example.test/npm/#anchor1'],
  ['malformed host', 'https://exa mple.test/npm/'],
  ['malformed port', 'https://mirror.example.test:99999/npm/'],
  ['missing host', 'https:///npm/'],
  ['scheme only', 'https://'],
  ['no scheme', 'mirror.example.test/npm/'],
  ['other scheme', 'file:///etc/passwd'],
  ['backslash host trick', 'https:\\\\mirror.example.test\\npm\\'],
  ['newline injection', 'https://mirror.example.test/npm/\n--strict-ssl=false'],
  ['empty', ''],
];

function runCli(value) {
  const env = { ...process.env };
  if (value === undefined) delete env.NPM_REGISTRY;
  else env.NPM_REGISTRY = value;
  return spawnSync(process.execPath, [validatorPath], { env, encoding: 'utf8' });
}

for (const [name, value] of VALID) {
  test(`validator accepts ${name}`, () => {
    assert.deepEqual(validateNpmRegistry(value), { ok: true });
    const result = runCli(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });
}

for (const [name, value] of INVALID) {
  test(`validator rejects ${name} without echoing it`, () => {
    const verdict = validateNpmRegistry(value);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /^NPM_REGISTRY /);

    const result = runCli(value);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^NPM_REGISTRY [^\n]+\n$/);
    for (const secretish of ['placeholder', 'anchor1', 'mirror.example.test', 'registry.npmjs.org', 'token']) {
      if (value.includes(secretish)) assert.ok(!result.stderr.includes(secretish), `stderr leaked ${secretish}`);
    }
  });
}

for (const codePoint of [0x80, 0x85, 0x9f]) {
  test(`validator CLI rejects U+${codePoint.toString(16).padStart(4, '0')} without leaking input`, () => {
    const control = String.fromCodePoint(codePoint);
    const marker = 'secret-like-marker';
    const value = `https://mirror.example.test/npm/${marker}${control}`;

    const transport = spawnSync(process.execPath, [
      '-e',
      'const c = String.fromCodePoint(Number(process.argv[1])); if (process.argv[2] !== c || process.env.NPM_REGISTRY !== c) process.exit(1)',
      String(codePoint),
      control,
    ], { env: { ...process.env, NPM_REGISTRY: control }, encoding: 'utf8' });
    assert.equal(transport.status, 0, `Node argv/env did not preserve U+${codePoint.toString(16)}: ${transport.stderr}`);

    assert.equal(validateNpmRegistry(value).ok, false);
    const result = runCli(value);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^NPM_REGISTRY [^\n]+\n$/);
    const output = result.stdout + result.stderr;
    assert.ok(!output.includes(value), 'CLI echoed the input');
    assert.ok(!output.includes(marker), 'CLI leaked the secret-like marker');
    assert.ok(!output.includes(control), 'CLI echoed the control character');
  });
}

test('validator rejects an unset NPM_REGISTRY', () => {
  assert.equal(validateNpmRegistry(undefined).ok, false);
  assert.equal(runCli(undefined).status, 1);
});

test('validator reports the specific reason for query, fragment and userinfo', () => {
  assert.match(validateNpmRegistry('https://m.example.test/npm?token=x').reason, /query/);
  assert.match(validateNpmRegistry('https://m.example.test/npm#x').reason, /fragment/);
  assert.match(validateNpmRegistry('https://u:p@m.example.test/npm/').reason, /credentials/);
  assert.match(validateNpmRegistry('http://m.example.test/npm/').reason, /https:\/\//);
});

test('sandbox Dockerfile installs Copilot CLI through the NPM_REGISTRY build arg', () => {
  const match = dockerfile.match(/^ARG NPM_REGISTRY=(\S+)$/m);
  assert.ok(match, 'NPM_REGISTRY build arg must be declared');
  assert.equal(match[1], 'https://registry.npmjs.org/', 'default must stay the public npm registry');
  assert.deepEqual(validateNpmRegistry(match[1]), { ok: true });

  const argIndex = dockerfile.indexOf(match[0]);
  const buildStage = dockerfile.indexOf('AS build');
  const runtimeStage = dockerfile.indexOf('AS runtime');
  assert.ok(argIndex > buildStage && argIndex < runtimeStage, 'NPM_REGISTRY must be scoped to the build stage');

  assert.match(dockerfile, /npm install -g @github\/copilot --registry="\$NPM_REGISTRY"/);
  assert.doesNotMatch(dockerfile, /npm install -g @github\/copilot\s*$/m, 'no unparameterized install may remain');
});

test('sandbox Dockerfile runs the shared validator before npm install in the same RUN step', () => {
  const copyIndex = dockerfile.indexOf('COPY agents/sandbox/build/validate-npm-registry.js /tmp/squad-build/validate-npm-registry.js');
  const runtimeStage = dockerfile.indexOf('AS runtime');
  assert.ok(copyIndex > 0 && copyIndex < runtimeStage, 'validator must be copied in the build stage only');

  const runMatch = dockerfile.match(/^RUN set -eu; \\\n((?:.*\\\n)*.*)$/m);
  assert.ok(runMatch, 'validation RUN step must exist');
  const step = runMatch[1];
  const validateIndex = step.indexOf('node /tmp/squad-build/validate-npm-registry.js');
  const installIndex = step.indexOf('npm install -g @github/copilot');
  assert.ok(validateIndex >= 0 && installIndex > validateIndex, 'validator must run before npm install');

  assert.doesNotMatch(dockerfile, /echo[^\n]*\$NPM_REGISTRY/);
  assert.doesNotMatch(dockerfile, /strict-ssl|_authToken|NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.doesNotMatch(dockerfile.slice(runtimeStage), /validate-npm-registry|NPM_REGISTRY/);
});

test('Docker build context allowlist includes the validator', () => {
  const lines = dockerignore.split(/\r?\n/);
  assert.ok(lines.includes('!agents/sandbox/build/'));
  assert.ok(lines.includes('!agents/sandbox/build/validate-npm-registry.js'));
  assert.equal(lines[0], '*', 'allowlist must still deny everything by default');
});

test('repository does not hardcode an internal npm mirror and CI keeps the public default', () => {
  for (const source of [dockerfile, fs.readFileSync(validatorPath, 'utf8')]) {
    assert.doesNotMatch(source, /packagefeedproxy|pkgs\.dev\.azure\.com|\.microsoft\.io/i);
  }
  assert.doesNotMatch(ciWorkflow, /NPM_REGISTRY/, 'CI must use the Dockerfile public default');
  assert.match(ciWorkflow, /--file agents\/sandbox\/Dockerfile/);
});
