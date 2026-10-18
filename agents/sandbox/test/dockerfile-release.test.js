'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const dockerfile = fs.readFileSync(path.join(root, 'agents', 'sandbox', 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(root, 'agents', 'sandbox', 'Dockerfile.dockerignore'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'agents', 'sandbox', 'README.md'), 'utf8');

test('Dockerfile pins and verifies the official Copilot CLI 1.0.96 release', () => {
  assert.match(dockerfile, /https:\/\/github\.com\/github\/copilot-cli\/releases\/download\/v1\.0\.96\/copilot-linux-x64\.tar\.gz/);
  assert.match(dockerfile, /66b60b58b14d72390f30d6d7f8480d18a0f05c111d132e4ff8f92ae637d413f8/);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /copilot_version=.*--version/);
  assert.match(dockerfile, /copilot --help \| grep -F -- '--max-ai-credits'/);
  assert.match(readme, /official\s+`github\/copilot-cli` release/);
});

test('Dockerfile copies the standalone binary and does not install from npm', () => {
  assert.match(dockerfile, /COPY --from=build \/usr\/local\/bin\/copilot \/usr\/local\/bin\/copilot/);
  assert.doesNotMatch(dockerfile, /npm install|npx /);
  assert.doesNotMatch(dockerfile, /\/tmp\/|mktemp/);
});

test('Docker build context remains an allowlist of required sandbox sources', () => {
  const lines = dockerignore.split(/\r?\n/);
  assert.equal(lines[0], '*');
  assert.ok(lines.includes('!agents/sandbox/lib/'));
  assert.ok(lines.includes('!agents/sandbox/runner/'));
  assert.ok(lines.includes('!contracts/aca-sandbox/v1/tools/'));
  assert.ok(lines.includes('!contracts/aca-sandbox/v1/schemas/'));
  assert.ok(!lines.some(line => line.includes('validate-npm-registry')));
});

test('runtime and contracts remove Windows-derived group and other write permissions', () => {
  assert.match(dockerfile, /chmod -R a\+rX,go-w \/opt\/squad-sandbox/);
  assert.match(dockerfile, /chmod -R a\+rX,go-w \/opt\/squad\/contracts/);
});
