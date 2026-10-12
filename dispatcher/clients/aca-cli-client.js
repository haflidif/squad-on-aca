const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { buildSafeChildEnv } = require('../lib/util');
const { createDiskImage, DEFAULT_ENDPOINT, TOKEN_AUDIENCE } = require('../lib/aca-disk-image');
const { validateSandboxImageRef } = require('../lib/sandbox-image');

const ACA_REGION = 'swedencentral';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requireSandboxId(handle) {
  if (!handle || !isUuid(handle.id)) {
    throw new Error('ACA Sandbox handle does not contain a valid sandbox UUID.');
  }
  return handle.id.toLowerCase();
}

function quotePosixArg(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('ACA Sandbox command arguments must be NUL-free strings.');
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandFromArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('ACA Sandbox command must contain at least one argument.');
  }
  return argv.map(quotePosixArg).join(' ');
}

function validateRemotePath(remotePath) {
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || remotePath.includes('\0')) {
    throw new Error('ACA Sandbox file paths must be absolute POSIX paths.');
  }
  const normalized = path.posix.normalize(remotePath);
  if (normalized !== remotePath || normalized === '/' || normalized.startsWith('/../')) {
    throw new Error('ACA Sandbox file path is not normalized.');
  }
  return normalized;
}

function powershellQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function setAndVerifyWindowsAcl(target, directory, run) {
  const inheritance = directory ? '(OI)(CI)' : '';
  const expectedRights = directory ? '(OI)(CI)(F)' : '(F)';
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${powershellQuote(target)}`,
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$sid = $identity.User.Value',
    "$icacls = Join-Path $env:SystemRoot 'System32\\icacls.exe'",
    '& $icacls $target /setowner \"*$sid\" | Out-Null',
    'if ($LASTEXITCODE -ne 0) { exit 4 }',
    `$grant = "*\${sid}:${inheritance}F"`,
    '& $icacls $target /inheritance:r /grant:r $grant | Out-Null',
    'if ($LASTEXITCODE -ne 0) { exit 5 }',
    '$query = @(& $icacls $target)',
    'if ($LASTEXITCODE -ne 0) { exit 6 }',
    '$entries = @()',
    'foreach ($line in $query) { $entry = $line.Trim(); if ($line.StartsWith($target, [StringComparison]::OrdinalIgnoreCase)) { $entry = $line.Substring($target.Length).Trim() }; if ($entry -match \"^[^:]+:\\(\") { $entries += $entry } }',
    `$expected = "$($identity.Name):${expectedRights}"`,
    'if ($entries.Count -ne 1 -or $entries[0] -ne $expected) { exit 7 }',
    "Write-Output 'PRIVATE_ACL_OK'"
  ].join('; ');
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 15000
  });
  if (result.exitCode !== 0 || result.timedOut || result.stdout.trim() !== 'PRIVATE_ACL_OK') {
    throw new Error('Unable to establish and verify a private Windows ACL for ACA Sandbox staging.');
  }
}

async function createPrivateStagingDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-sandbox-'));
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private staging directory is not a real directory.');
    if (process.platform === 'win32') {
      await setAndVerifyWindowsAcl(directory, true, run);
    } else {
      fs.chmodSync(directory, 0o700);
      const privateStat = fs.statSync(directory);
      if ((privateStat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && privateStat.uid !== process.getuid())) {
        throw new Error('Unable to establish a private local ACA Sandbox staging directory.');
      }
    }
    return directory;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function writePrivateStagingFile(directory, bytes, run) {
  const file = path.join(directory, 'payload');
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Local ACA Sandbox staging file is not a regular file.');
    if (process.platform === 'win32') {
      await setAndVerifyWindowsAcl(file, false, run);
    } else if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('Unable to establish a private local ACA Sandbox staging file.');
    }
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

function singleOutputLine(text) {
  const normalized = text.replace(/\r?\n$/, '');
  if (normalized === '' || /[\r\n]/.test(normalized)) return null;
  return normalized;
}

function parseCreatedSandboxId(stdout, stderr) {
  if (typeof stdout !== 'string' || typeof stderr !== 'string') {
    throw new Error('aca sandbox create returned malformed output.');
  }
  const progressLine = singleOutputLine(stderr);
  const createdLine = singleOutputLine(stdout);
  if (progressLine === null || createdLine === null) {
    throw new Error('aca sandbox create returned malformed output: expected exactly one progress line on stderr and one created line on stdout.');
  }
  const creating = /^Creating sandbox ([0-9A-Fa-f-]{36})\.\.\.$/.exec(progressLine);
  const created = /^Created sandbox: ([0-9A-Fa-f-]{36})$/.exec(createdLine);
  if (!creating || !created || !isUuid(creating[1]) || !isUuid(created[1]) || creating[1].toLowerCase() !== created[1].toLowerCase()) {
    throw new Error('aca sandbox create returned an invalid or inconsistent sandbox UUID.');
  }
  return created[1].toLowerCase();
}
function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      env: buildSafeChildEnv(options.env, { secretEnvKeys: options.secretEnvKeys || [] })
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000).unref?.();
      }, options.timeoutMs);
    }
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: error.message, timedOut });
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}

async function getAzureAccessToken({ azBin, subscriptionId, run = runProcess }) {
  const result = await run(azBin, [
    'account', 'get-access-token', '--resource', TOKEN_AUDIENCE,
    '--subscription', subscriptionId, '--output', 'json'
  ], { timeoutMs: 30000 });
  if (result.exitCode !== 0 || result.timedOut) throw new Error('Azure access-token acquisition failed.');
  let accessToken;
  try {
    accessToken = JSON.parse(result.stdout).accessToken;
  } catch {
    throw new Error('Azure access-token response is malformed.');
  }
  if (typeof accessToken !== 'string' || accessToken.length < 20 || /[\r\n]/.test(accessToken)) {
    throw new Error('Azure access-token response is malformed.');
  }
  return accessToken;
}

function validateSandboxLabels(labels) {
  if (labels === undefined || labels === null) return {};
  if (typeof labels !== 'object' || Array.isArray(labels)) throw new Error('Sandbox labels must be a key/value object.');
  const result = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key === 'squad_name') throw new Error('Sandbox label squad_name is reserved for the client traceability label.');
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,62}$/.test(key)) throw new Error('Sandbox label key is invalid.');
    const text = String(value);
    if (text.length > 256 || /[\u0000-\u001f\u007f,=]/.test(text)) throw new Error(`Sandbox label ${key} has an invalid value.`);
    result[key] = text;
  }
  return result;
}
function cliDiagnostic(text) {
  return String(text || '')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[REDACTED]')
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [REDACTED]')
    .replace(/((?:sig|signature|token|secret|password|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 400);
}

function cliFailure(operation, result) {
  const status = result.timedOut ? 'timed out' : `exit code ${result.exitCode}`;
  const detail = cliDiagnostic(result.stderr) || cliDiagnostic(result.stdout);
  return new Error(`${operation} failed (${status})${detail ? `: ${detail}` : '.'}`);
}
function remoteEnvCleanupError(primaryError, env) {
  const base = 'ACA Sandbox runner environment cleanup failed; secret staging may remain in sandbox tmpfs until the sandbox is deleted.';
  const error = new Error(base);
  error.code = 'ACA_RUNNER_ENV_CLEANUP_FAILED';
  if (!primaryError) return error;
  let primaryMessage = String((primaryError && primaryError.message) || 'unknown error');
  for (const value of Object.values(env || {})) {
    if (typeof value === 'string' && value.length >= 4) primaryMessage = primaryMessage.split(value).join('[REDACTED]');
  }
  error.message = `${base} Primary failure: ${primaryMessage}`;
  error.primaryError = primaryError;
  return error;
}
class AcaCliSandboxClient {
  constructor(options = {}) {
    if (process.env.SQUAD_ENABLE_ACA_SANDBOX !== '1') {
      throw new Error('Refusing to use live ACA Sandbox client unless SQUAD_ENABLE_ACA_SANDBOX=1 is set.');
    }
    this.group = options.group || process.env.SQUAD_SANDBOX_GROUP_NAME;
    if (!this.group) throw new Error('SQUAD_SANDBOX_GROUP_NAME is required for the ACA Sandbox client.');
    this.image = validateSandboxImageRef(options.image || process.env.SQUAD_SANDBOX_IMAGE_REF);
    this.resourceGroup = options.resourceGroup || process.env.SQUAD_SANDBOX_RESOURCE_GROUP_NAME;
    this.subscriptionId = options.subscriptionId || process.env.SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID;
    this.imagePullClientId = options.imagePullClientId || process.env.SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID;
    if (!this.resourceGroup) throw new Error('SQUAD_SANDBOX_RESOURCE_GROUP_NAME is required for the ACA Sandbox client.');
    if (!this.subscriptionId) throw new Error('SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID is required for the ACA Sandbox client.');
    if (!this.imagePullClientId) throw new Error('SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID is required for the ACA Sandbox client.');
    if (!isUuid(this.subscriptionId)) throw new Error('SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID must be a subscription UUID.');
    if (!/^[-\w.()]{1,89}[-\w()]$/.test(this.resourceGroup)) throw new Error('SQUAD_SANDBOX_RESOURCE_GROUP_NAME is not a valid resource group name.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,89}$/.test(this.group)) throw new Error('SQUAD_SANDBOX_GROUP_NAME is not a valid sandbox group name.');
    this.acaBin = options.acaBin || process.env.SQUAD_ACA_BIN || process.env.ACA_BIN || 'aca';
    this.acaBinArgs = options.acaBinArgs || [];
    this.region = options.region ?? process.env.SQUAD_SANDBOX_REGION ?? ACA_REGION;
    if (this.region !== ACA_REGION) {
      throw new Error(`Unsupported ACA Sandbox region "${this.region}"; only ${ACA_REGION} is supported by the configured data plane.`);
    }
    this.azBin = options.azBin || process.env.AZ_BIN || 'az';
    this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
    this.fetch = options.fetch || globalThis.fetch;
    this.runProcess = options.runProcess || runProcess;
    this.runHostProcess = options.runHostProcess || runProcess;
    this.getToken = options.getToken || (audience => {
      if (audience !== TOKEN_AUDIENCE) throw new Error('Unexpected Azure token audience.');
      return getAzureAccessToken({ azBin: this.azBin, subscriptionId: this.subscriptionId, run: this.runProcess });
    });
    this.createDiskImage = options.createDiskImage || createDiskImage;
    this.diskImagePromise = null;
    this.secretEnvKeys = options.secretEnvKeys || [];
    this.activeSandboxIds = new Set();
    this.pendingSandboxCreations = 0;
  }

  globalArgs() {
    return [
      ...this.acaBinArgs,
      '--region', this.region,
      '--subscription', this.subscriptionId,
      '--resource-group', this.resourceGroup
    ];
  }

  requireActiveSandboxId(handle) {
    const id = requireSandboxId(handle);
    if (!this.activeSandboxIds.has(id)) {
      throw new Error('Refusing to use a sandbox UUID not created by this ACA client instance.');
    }
    return id;
  }

  async create(spec) {
    if (validateSandboxImageRef(spec.image) !== this.image) {
      throw new Error('Sandbox create image does not match the configured image reference.');
    }
    const userLabels = validateSandboxLabels(spec.labels);
    if (!this.diskImagePromise) {
      const diskName = `squad-${randomUUID()}`;
      this.diskImagePromise = this.createDiskImage({
        imageUrl: this.image,
        managedIdentityClientId: this.imagePullClientId,
        subscriptionId: this.subscriptionId,
        resourceGroup: this.resourceGroup,
        groupName: this.group,
        name: diskName,
        endpoint: this.endpoint,
        fetchImpl: this.fetch,
        getToken: this.getToken
      }).catch(error => {
        this.diskImagePromise = null;
        throw error;
      });
    }
    const diskId = await this.diskImagePromise;
    if (!isUuid(diskId)) throw new Error('ACA disk image creation returned an invalid UUID.');
    this.diskImageId = diskId.toLowerCase();
    const requestedName = String(spec.name || '');
    const namePrefix = requestedName.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 46);
    if (!namePrefix) throw new Error('Sandbox create requires a usable spec name for its traceability label.');
    const nameHash = createHash('sha256').update(requestedName).digest('hex').slice(0, 16);
    const stableName = `${namePrefix}-${nameHash}`;
    const labels = { ...userLabels, squad_name: stableName };
    const labelArgs = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    const args = [
      ...this.globalArgs(), 'sandbox', 'create', '--group', this.group,
      '--disk-id', this.diskImageId, '--cpu', spec.cpu || '1000m', '--memory', spec.memory || '2048Mi',
      ...labelArgs
    ];
    this.pendingSandboxCreations += 1;
    const result = await this.runProcess(this.acaBin, args, { timeoutMs: 120000, secretEnvKeys: this.secretEnvKeys });
    if (result.exitCode !== 0 || result.timedOut) throw cliFailure('aca sandbox create', result);
    let id;
    try {
      id = parseCreatedSandboxId(result.stdout, result.stderr);
    } catch (error) {
      throw new Error(`${error.message} A sandbox may have been created in group ${this.group}; disk-image deletion is blocked until it is checked with "aca sandbox list" and removed manually.`);
    }
    this.pendingSandboxCreations -= 1;
    this.activeSandboxIds.add(id);
    return { id, name: id, diskId: this.diskImageId, label: stableName };
  }

  async execCommand(handle, command, options = {}) {
    const id = this.requireActiveSandboxId(handle);
    const args = [
      ...this.globalArgs(), 'sandbox', 'exec', '--group', this.group,
      '--id', id, '-c', command
    ];
    return this.runProcess(this.acaBin, args, { timeoutMs: options.timeoutMs, secretEnvKeys: this.secretEnvKeys });
  }

  async exec(handle, argv, options = {}) {
    if (options.stdin !== undefined) throw new Error('ACA Sandbox exec stdin is unsupported; use execWithEnvironment for runner environment delivery.');
    return this.execCommand(handle, commandFromArgv(argv), options);
  }

  async copyFile(handle, source, destination) {
    const id = this.requireActiveSandboxId(handle);
    const result = await this.runProcess(this.acaBin, [
      ...this.globalArgs(), 'sandbox', 'fs', 'cp', '--group', this.group, source, destination
    ], { timeoutMs: 120000, secretEnvKeys: this.secretEnvKeys });
    if (result.exitCode !== 0 || result.timedOut) throw cliFailure('aca sandbox fs cp', result);
    return id;
  }

  async putFile(handle, remotePath, bytes) {
    const id = this.requireActiveSandboxId(handle);
    const remote = validateRemotePath(remotePath);
    const directory = path.posix.dirname(remote);
    const mkdir = await this.exec(handle, ['mkdir', '-p', '--', directory]);
    if (mkdir.exitCode !== 0 || mkdir.timedOut) throw new Error('Unable to prepare remote ACA Sandbox file directory.');
    const stagingDirectory = await createPrivateStagingDirectory(this.runHostProcess);
    try {
      const localPath = await writePrivateStagingFile(stagingDirectory, Buffer.from(bytes), this.runHostProcess);
      await this.copyFile(handle, localPath, `${id}:${remote}`);
    } finally {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }

  async uploadFile(handle, remotePath, bytes) {
    return this.putFile(handle, remotePath, bytes);
  }

  async readFile(handle, remotePath) {
    const id = this.requireActiveSandboxId(handle);
    const remote = validateRemotePath(remotePath);
    const stagingDirectory = await createPrivateStagingDirectory(this.runHostProcess);
    try {
      const localPath = path.join(stagingDirectory, 'download');
      await this.copyFile(handle, `${id}:${remote}`, localPath);
      const stat = fs.lstatSync(localPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ACA Sandbox download did not produce a regular file.');
      if (process.platform === 'win32') {
        await setAndVerifyWindowsAcl(localPath, false, this.runHostProcess);
      } else {
        fs.chmodSync(localPath, 0o600);
        const privateStat = fs.statSync(localPath);
        if ((privateStat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && privateStat.uid !== process.getuid())) {
          throw new Error('ACA Sandbox download is not privately staged on the host.');
        }
      }
      return fs.readFileSync(localPath);
    } finally {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }

  async downloadFile(handle, remotePath) {
    return this.readFile(handle, remotePath);
  }

  async initializeRemoteEnvDirectory(handle, directory) {
    const script = [
      "awk '$2 == \"/dev/shm\" && $3 == \"tmpfs\" { found=1 } END { exit !found }' /proc/mounts",
      'test -w /dev/shm',
      `mkdir -m 700 -- ${quotePosixArg(directory)}`,
      `test "$(stat -c %a ${quotePosixArg(directory)})" = 700`,
      `test "$(stat -c %u ${quotePosixArg(directory)})" = "$(id -u)"`
    ].join(' && ');
    const result = await this.execCommand(handle, script);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error('Runner environment staging requires a private directory on a verified /dev/shm tmpfs.');
    }
  }

  async cleanupRemoteEnvDirectory(handle, directory, file) {
    const script = `rm -f -- ${quotePosixArg(file)} && (rmdir -- ${quotePosixArg(directory)} 2>/dev/null || test ! -e ${quotePosixArg(directory)})`;
    const result = await this.execCommand(handle, script, { timeoutMs: 15000 });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error('Unable to remove runner environment staging from the ACA Sandbox tmpfs.');
    }
  }

  async execWithEnvironment(handle, argv, env, options = {}) {
    this.requireActiveSandboxId(handle);
    if (!Array.isArray(argv) || argv[0] !== 'node' || argv[1] !== '/opt/squad-sandbox/runner/exec-with-env.js') {
      throw new Error('ACA runner environment may only be delivered to the fixed exec-with-env.js bootstrap.');
    }
    if (!env || typeof env !== 'object' || Array.isArray(env) ||
        Object.entries(env).some(([key, value]) => typeof key !== 'string' || typeof value !== 'string')) {
      throw new Error('ACA runner environment payload must be a string-valued JSON object.');
    }
    const payload = Buffer.from(`${JSON.stringify(env)}\n`, 'utf8');
    if (payload.length > 1024 * 1024) throw new Error('ACA runner environment payload is too large.');
    const directory = `/dev/shm/squad-runner-${randomUUID()}`;
    const file = `${directory}/environment.json`;
    let primaryError;
    let directoryMayExist = false;
    try {
      directoryMayExist = true;
      await this.initializeRemoteEnvDirectory(handle, directory);
      await this.putFile(handle, file, payload);
      const permissions = `chmod 600 -- ${quotePosixArg(file)} && test "$(stat -c %a ${quotePosixArg(file)})" = 600 && test -f ${quotePosixArg(file)} && test "$(stat -c %u ${quotePosixArg(file)})" = "$(id -u)"`;
      const verify = await this.execCommand(handle, permissions);
      if (verify.exitCode !== 0 || verify.timedOut) {
        throw new Error('Unable to verify restrictive permissions on the ACA Sandbox runner environment file.');
      }

      const envFile = quotePosixArg(file);
      const envDirectory = quotePosixArg(directory);
      const runnerCommand = commandFromArgv(argv);
      const command = [
        'set +e',
        `env_file=${envFile}`,
        `env_dir=${envDirectory}`,
        'cleanup() { rm -f -- "$env_file" || return 1; rmdir -- "$env_dir" 2>/dev/null || test ! -e "$env_dir"; }',
        "trap 'cleanup >/dev/null 2>&1 || true' EXIT",
        "trap 'cleanup >/dev/null 2>&1; exit 128' HUP INT TERM",
        `${runnerCommand} < "$env_file"`,
        'runner_status=$?',
        'if ! cleanup; then exit 125; fi',
        'trap - EXIT HUP INT TERM',
        'exit "$runner_status"'
      ].join('; ');
      return await this.execCommand(handle, command, options);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (directoryMayExist) {
        try {
          await this.cleanupRemoteEnvDirectory(handle, directory, file);
        } catch {
          throw remoteEnvCleanupError(primaryError, env);
        }
      }
    }
  }

  async delete(handle) {
    const id = this.requireActiveSandboxId(handle);
    const result = await this.runProcess(this.acaBin, [
      ...this.globalArgs(), 'sandbox', 'delete', '--group', this.group, '--id', id, '--yes'
    ], { timeoutMs: 120000, secretEnvKeys: this.secretEnvKeys });
    if (result.exitCode !== 0 || result.timedOut) throw cliFailure('aca sandbox delete', result);
    this.activeSandboxIds.delete(id);
  }

  async deleteDiskImage() {
    if (!this.diskImageId) return;
    if (!isUuid(this.diskImageId)) throw new Error('Refusing to delete an invalid ACA disk image UUID.');
    if (this.activeSandboxIds.size > 0 || this.pendingSandboxCreations > 0) {
      throw new Error('Refusing to delete the ACA disk image while sandbox cleanup is incomplete or uncertain.');
    }
    const result = await this.runProcess(this.acaBin, [
      ...this.globalArgs(), 'sandboxgroup', 'disk', 'delete',
      '--group', this.group, '--id', this.diskImageId, '--wait-timeout', '180'
    ], { timeoutMs: 210000, secretEnvKeys: this.secretEnvKeys });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`ACA disk image deletion failed for disk ${this.diskImageId} (exit code ${result.exitCode}).`);
    }
    this.diskImageId = null;
    this.diskImagePromise = null;
  }
}

module.exports = {
  AcaCliSandboxClient,
  getAzureAccessToken,
  commandFromArgv,
  parseCreatedSandboxId,
  isUuid,
  setAndVerifyWindowsAcl
};
