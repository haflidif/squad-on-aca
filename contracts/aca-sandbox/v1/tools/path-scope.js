const fs = require('node:fs');
const path = require('node:path');

const PROTECTED_PATHS = ['.squad', '.github/workflows'];

function normalizePathScope(value) {
  let normalized = String(value).replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, '');
  normalized = normalized.replace(/\/\*\*$/, '');
  normalized = normalized.replace(/\/+$/, '');
  return normalized || '.';
}

function hasTraversalOrAbsolutePath(value) {
  const raw = String(value).replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return true;
  return raw.split('/').some(segment => segment === '..');
}

function pathContains(scope, candidate) {
  const normalizedScope = normalizePathScope(scope);
  const normalizedCandidate = normalizePathScope(candidate);
  return normalizedScope === '.'
    || normalizedCandidate === normalizedScope
    || normalizedCandidate.startsWith(`${normalizedScope}/`);
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

function validateOwnedPathList(paths, location = 'owned_paths') {
  const errors = [];
  for (const ownedPath of paths || []) {
    if (hasTraversalOrAbsolutePath(ownedPath)) {
      errors.push(`${location} contains absolute or parent traversal path: ${ownedPath}`);
      continue;
    }
    if (PROTECTED_PATHS.some(protectedPath => pathsOverlap(ownedPath, protectedPath))) {
      errors.push(`${location} covers protected path: ${ownedPath}`);
    }
  }
  return errors;
}

function findOverlappingOwnedPaths(tasks) {
  const errors = [];
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex++) {
      for (const leftPath of tasks[leftIndex].owned_paths || []) {
        for (const rightPath of tasks[rightIndex].owned_paths || []) {
          if (pathsOverlap(leftPath, rightPath)) {
            errors.push(`task ${tasks[leftIndex].task_id} owned path ${leftPath} overlaps task ${tasks[rightIndex].task_id} owned path ${rightPath}`);
          }
        }
      }
    }
  }
  return errors;
}

function isSubsetOfOwnedPaths(candidate, parentPaths) {
  return (parentPaths || []).some(parentPath => pathContains(parentPath, candidate));
}

function validateChangedPaths(paths, ownedPaths) {
  const violations = [];
  const protectedPaths = [];
  for (const changedPath of paths) {
    if (!changedPath) continue;
    if (PROTECTED_PATHS.some(protectedPath => pathContains(protectedPath, changedPath))) {
      protectedPaths.push(normalizePathScope(changedPath));
      violations.push(normalizePathScope(changedPath));
    } else if (!isSubsetOfOwnedPaths(changedPath, ownedPaths)) {
      violations.push(normalizePathScope(changedPath));
    }
  }
  return { violations: [...new Set(violations)], protected: [...new Set(protectedPaths)] };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toRepoRelative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function resolveSymlinkTarget(root, symlinkPath) {
  const absolutePath = path.resolve(root, symlinkPath);
  let target;
  try {
    target = fs.realpathSync(absolutePath);
  } catch (error) {
    return { ok: false, path: normalizePathScope(symlinkPath), reason: `broken symlink: ${error.code || error.message}` };
  }
  if (!isInside(root, target)) {
    return { ok: false, path: normalizePathScope(symlinkPath), reason: `symlink target escapes repository: ${toRepoRelative(root, target)}` };
  }
  return { ok: true, path: normalizePathScope(symlinkPath), target: toRepoRelative(root, target) };
}

function scanSymlinks(root, dir = root, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolutePath = path.join(dir, entry.name);
    const relativePath = toRepoRelative(root, absolutePath);
    if (entry.isSymbolicLink()) {
      const resolved = resolveSymlinkTarget(root, relativePath);
      if (!resolved.ok) results.push(resolved);
    } else if (entry.isDirectory()) {
      scanSymlinks(root, absolutePath, results);
    }
  }
  return results;
}

function readStdinBuffer() {
  return fs.readFileSync(0);
}

function parseNulPaths(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'check-paths-nul') {
    const dispatch = readJson(args[0]);
    process.stdout.write(`${JSON.stringify(validateChangedPaths(parseNulPaths(readStdinBuffer()), dispatch.owned_paths || []))}\n`);
    return;
  }
  if (command === 'validate-owned') {
    const dispatch = readJson(args[0]);
    const errors = validateOwnedPathList(dispatch.owned_paths || []);
    process.stdout.write(`${JSON.stringify({ valid: errors.length === 0, errors })}\n`);
    process.exitCode = errors.length === 0 ? 0 : 1;
    return;
  }
  if (command === 'scan-symlinks') {
    const root = fs.realpathSync(args[0]);
    process.stdout.write(`${JSON.stringify({ violations: scanSymlinks(root) })}\n`);
    return;
  }
  if (command === 'check-changed-symlinks-nul') {
    const dispatch = readJson(args[0]);
    const root = fs.realpathSync(args[1]);
    const violations = [];
    for (const changedPath of parseNulPaths(readStdinBuffer())) {
      const absolutePath = path.resolve(root, changedPath);
      if (!fs.existsSync(absolutePath)) continue;
      if (!fs.lstatSync(absolutePath).isSymbolicLink()) continue;
      const resolved = resolveSymlinkTarget(root, changedPath);
      if (!resolved.ok) {
        violations.push(resolved);
      } else if (!isSubsetOfOwnedPaths(resolved.target, dispatch.owned_paths || [])) {
        violations.push({
          ok: false,
          path: normalizePathScope(changedPath),
          reason: `symlink target is outside owned paths: ${resolved.target}`
        });
      }
    }
    process.stdout.write(`${JSON.stringify({ violations })}\n`);
    return;
  }
  throw new Error(`Unknown path-scope command: ${command}`);
}

module.exports = {
  PROTECTED_PATHS,
  normalizePathScope,
  hasTraversalOrAbsolutePath,
  pathContains,
  pathsOverlap,
  validateOwnedPathList,
  findOverlappingOwnedPaths,
  isSubsetOfOwnedPaths,
  validateChangedPaths
};

if (require.main === module) cli();
