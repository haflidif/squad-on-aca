#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be present for the offline stub}"
owned_paths="$(printf '%s\n' "$prompt" | sed -n 's/^Owned paths JSON: //p')"
test -n "$owned_paths" || { echo "The dispatch prompt did not include owned paths." >&2; exit 2; }
node - "$owned_paths" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const paths = JSON.parse(process.argv[2]);
if (!Array.isArray(paths) || paths.length === 0 || typeof paths[0] !== 'string') {
  throw new Error('The dispatch prompt has no valid owned path.');
}
const owned = paths[0].replace(/\/\*\*$/, '').replace(/\/+$/, '');
const parts = owned.split('/');
if (!owned || owned === '.' || owned.startsWith('/') || parts.some(part => !part || part === '.' || part === '..') ||
    parts.some(part => part === '.squad' || part === '.github')) {
  throw new Error('The first owned path is not safe for the offline fixture.');
}
const root = path.resolve(process.cwd());
const target = path.resolve(root, ...parts);
const relative = path.relative(root, target);
if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error('The first owned path escapes the worktree.');
}
let current = root;
for (const part of relative.split(path.sep)) {
  current = path.join(current, part);
  if (!fs.existsSync(current)) continue;
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error('The first owned path traverses a symlink.');
}
const marker = Buffer.from('Offline workflow smoke patch.\n');
if (fs.existsSync(target) && fs.statSync(target).isFile()) {
  fs.appendFileSync(target, marker);
} else {
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'offline-smoke.txt'), marker);
}
NODE
