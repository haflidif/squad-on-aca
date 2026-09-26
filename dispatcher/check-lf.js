const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function trackedAndUntrackedFiles(repoRoot) {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'buffer',
    windowsHide: true
  });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function checkLineEndings(repoRoot = process.cwd()) {
  const violations = [];
  const files = trackedAndUntrackedFiles(repoRoot).filter(relative => relative.toLowerCase().endsWith('.sh'));
  for (const relative of files) {
    const file = path.join(repoRoot, relative);
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch (error) {
      if (error.code === 'EISDIR') continue;
      throw error;
    }
    if (bytes.includes(0)) continue;
    if (bytes.includes(13)) violations.push(relative);
  }
  if (violations.length) throw new Error(`CR characters found in working-tree shell files: ${violations.join(', ')}`);
  return files.length;
}

if (require.main === module) {
  try {
    const count = checkLineEndings();
    console.log(`LF check passed for ${count} tracked and untracked shell files.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkLineEndings };
