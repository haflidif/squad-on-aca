'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('./sandbox-flow-config.cjs');

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

async function installTools(repo, destination) {
  const config = loadConfig(repo);
  const tools = config.postprocess?.tools || {};
  if (!Object.keys(tools).length) return [];
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const installed = [];
  for (const [name, tool] of Object.entries(tools)) {
    const response = await fetch(tool.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.url.startsWith('https://')) throw new Error(`SANDBOX_TOOL_DOWNLOAD_FAILED ${name}`);
    if (!response.body?.getReader) throw new Error(`SANDBOX_TOOL_DOWNLOAD_FAILED ${name}`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(`SANDBOX_TOOL_DOWNLOAD_TOO_LARGE ${name}`);
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, size);
    if (bytes.length === 0 || crypto.createHash('sha256').update(bytes).digest('hex') !== tool.sha256.toLowerCase()) {
      throw new Error(`SANDBOX_TOOL_CHECKSUM_FAILED ${name}`);
    }
    let executableBytes = bytes;
    if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      const archive = path.join(destination, `${name}.download`);
      fs.writeFileSync(archive, bytes, { mode: 0o600, flag: 'wx' });
      const listing = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
      if (listing.error || listing.status !== 0) throw new Error(`SANDBOX_TOOL_ARCHIVE_INVALID ${name}`);
      const entries = listing.stdout.split(/\r?\n/u).filter(entry => path.posix.basename(entry) === name && !entry.endsWith('/'));
      if (entries.length !== 1) throw new Error(`SANDBOX_TOOL_ARCHIVE_ENTRY_INVALID ${name}`);
      const extraction = spawnSync('unzip', ['-p', archive, entries[0]], { encoding: null, timeout: 15000, maxBuffer: MAX_DOWNLOAD_BYTES + 1 });
      fs.rmSync(archive, { force: true });
      if (extraction.error || extraction.status !== 0 || !extraction.stdout?.length || extraction.stdout.length > MAX_DOWNLOAD_BYTES) throw new Error(`SANDBOX_TOOL_ARCHIVE_ENTRY_INVALID ${name}`);
      executableBytes = extraction.stdout;
    }
    const executable = path.join(destination, name);
    fs.writeFileSync(executable, executableBytes, { mode: 0o700, flag: 'wx' });
    fs.chmodSync(executable, 0o700);
    installed.push({ name, version: tool.version });
  }
  if (process.env.GITHUB_PATH) fs.appendFileSync(process.env.GITHUB_PATH, `${destination}\n`);
  return installed;
}

async function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (!key || !argv[index + 1] || args[key]) throw new Error('USAGE');
    args[key] = argv[index + 1];
  }
  const repo = path.resolve(args.repo || process.cwd());
  const destination = path.resolve(args.destination || path.join(process.env.RUNNER_TEMP || process.cwd(), 'sandbox-tools'));
  if (!destination.startsWith(`${path.resolve(process.env.RUNNER_TEMP || process.cwd())}${path.sep}`)) throw new Error('SANDBOX_TOOL_DESTINATION_INVALID');
  const installed = await installTools(repo, destination);
  console.log(`SANDBOX_TOOLS_INSTALLED count=${installed.length}`);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { installTools, MAX_DOWNLOAD_BYTES };
