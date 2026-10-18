const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function stagePem(env = process.env) {
  const pem = env.SQUAD_GITHUB_APP_PRIVATE_KEY_PEM;
  delete env.SQUAD_GITHUB_APP_PRIVATE_KEY_PEM;
  if (typeof pem !== 'string' || pem.length === 0) throw new Error('SQUAD_GITHUB_APP_PRIVATE_KEY_PEM is required in the protected publish environment.');

  try {
    crypto.createPrivateKey(pem);
  } catch {
    throw new Error('SQUAD_GITHUB_APP_PRIVATE_KEY_PEM is not a valid private key.');
  }

  const tempRoot = path.resolve(requiredTempDir(env.RUNNER_TEMP));
  const rootStat = fs.lstatSync(tempRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('RUNNER_TEMP must be a real directory.');
  const keyPath = path.join(tempRoot, 'squad-github-app.pem');
  let fd;
  try {
    fd = fs.openSync(keyPath, 'wx', 0o600);
    fs.writeFileSync(fd, pem, { encoding: 'utf8' });
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw new Error(`Could not securely stage GitHub App PEM: ${error.message}`);
  }
  fs.closeSync(fd);
  const stat = fs.lstatSync(keyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    fs.rmSync(keyPath, { force: true });
    throw new Error('Staged GitHub App PEM does not have a private regular-file mode.');
  }
  return keyPath;
}

function requiredTempDir(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('RUNNER_TEMP is required.');
  return value;
}

if (require.main === module) {
  try {
    stagePem();
    console.log('GitHub App PEM staged in the protected runner temp directory.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { stagePem };
