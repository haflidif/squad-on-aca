#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { hash, WORKFLOWS } = require('./install.cjs');
const ROOT = path.resolve(__dirname, '..');
function git(args, encoding = 'utf8') {
  const result = spawnSync('git', args, { cwd: ROOT, encoding, maxBuffer: 128 * 1024 * 1024, shell: false });
  if (result.error || result.status !== 0) throw new Error(`git failed: ${result.error?.message || result.stderr.toString().trim()}`);
  return encoding ? result.stdout.trim() : result.stdout;
}
function included(file) {
  if (/(?:^|\/)(?:\.env(?:\..*)?|terraform\.tfstate(?:\..*)?|[^/]*\.tfvars(?:\.json)?|[^/]*\.pem|[^/]*\.key)$/.test(file)) return false;
  return ['install.ps1', 'install.sh', 'azure.yaml', 'LICENSE', 'docs/install.md', 'docs/backend-contract.md', 'docs/adoption-guide.md'].includes(file)
    || WORKFLOWS.some(name => file === `.github/workflows/${name}`)
    || /^\.github\/actions\/sandbox-engine\//.test(file)
    || /^(?:scripts|dispatcher|contracts|agents\/(?:base|sandbox)|infra\/(?:terraform|bicep|hooks))\//.test(file);
}
function packageRelease({ version, ref, output }) {
  if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version)) throw new Error('--version must be a release tag or full SHA');
  if (!ref || !/^(?:[0-9a-f]{40}|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.test(ref)) throw new Error('--ref must be a full SHA or tag');
  const sha = git(['rev-parse', '--verify', `${/^[0-9a-f]{40}$/.test(ref) ? ref : `refs/tags/${ref}`}^{commit}`]);
  const files = git(['ls-tree', '-r', '--name-only', sha]).split('\n').filter(included).sort();
  for (const required of ['install.ps1', 'install.sh', 'scripts/install.cjs', 'azure.yaml', '.github/actions/sandbox-engine/action.yml', ...WORKFLOWS.map(name => `.github/workflows/${name}`)]) {
    if (!files.includes(required)) throw new Error(`Revision is missing ${required}; commit the installer and router before packaging`);
  }
  // git archive uses committed bytes only. Append metadata without touching the checkout.
  const archive = git(['archive', '--format=tar', '--prefix=squad-on-aca/', sha, '--', ...files], null);
  const metadata = Buffer.from(`${JSON.stringify({ repository: 'haflidif/squad-on-aca', release_version: version, action_sha: sha }, null, 2)}\n`);
  const header = Buffer.alloc(512);
  header.write('squad-on-aca/release.json');
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(`${metadata.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write('0', 156);
  header.write('ustar\0', 257); header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  // Trim the tar end-of-archive blocks; git may pad the archive to a larger record.
  let offset = 0;
  while (offset + 512 <= archive.length && archive.subarray(offset, offset + 512).some(byte => byte !== 0)) {
    const size = parseInt(archive.toString('ascii', offset + 124, offset + 136).replace(/\0.*$/, '').trim(), 8) || 0;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const bytes = zlib.gzipSync(Buffer.concat([archive.subarray(0, offset), header, metadata, Buffer.alloc((512 - metadata.length % 512) % 512 + 1024)]), { level: 9 });
  const directory = path.resolve(output || 'release');
  if (directory === ROOT) throw new Error('Choose a separate output directory');
  fs.mkdirSync(directory, { recursive: true });
  const name = `squad-on-aca-${version}.tar.gz`;
  const destination = path.join(directory, name);
  fs.writeFileSync(destination, bytes, { flag: 'wx' });
  fs.writeFileSync(`${destination}.sha256`, `${hash(bytes)}  ${name}\n`, { flag: 'wx' });
  console.log(`${destination}\nSHA256 ${hash(bytes)}\nSource commit ${sha}`);
  return { destination, sha };
}
if (require.main === module) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const name = { '--version': 'version', '--ref': 'ref', '--output': 'output' }[process.argv[i]];
      if (!name || !process.argv[i + 1]) throw new Error('Usage: node scripts/package-release.cjs --version <tag> --ref <SHA|tag> [--output <directory>]');
      options[name] = process.argv[i + 1];
    }
    packageRelease(options);
  } catch (error) { console.error(`PACKAGE_FAILED: ${error.message}`); process.exitCode = 1; }
}
module.exports = { included, packageRelease };
