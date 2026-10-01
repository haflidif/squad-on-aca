const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { buildSafeChildEnv } = require('../lib/util');
const { createDiskImage, DEFAULT_ENDPOINT, TOKEN_AUDIENCE } = require('../lib/aca-disk-image');
const { validateSandboxImageRef } = require('../lib/sandbox-image');

const ACA_REGION = 'swedencentral';

/*
 * Verified ACA contract: registry disk images use the regional v2 async API
 * with a managed identity client ID; sandbox boot selects the returned disk
 * image UUID through --disk-id.
 * - exec: aca sandbox exec --group <group> --name <name> -- <argv...>
 * - exec stdin forwarding to the sandbox process is UNVERIFIED. The dispatcher
 *   depends on stdin for runner environment delivery so credentials do not
 *   appear in argv or the local aca process environment.
 * - If stdin forwarding is unsupported, the fallback design is to upload a
 *   mode-600 env JSON file to a runner-only tmpfs path, execute the same
 *   bootstrap against that file, and delete it immediately after read. That
 *   fallback is also UNVERIFIED and intentionally not the default.
 * - delete: aca sandbox delete --group <group> --name <name> --yes
 * - There is no verified native file transfer contract. putFile/readFile use
 *   base64 over exec stdin/stdout as a conservative adapter.
 * - Sandbox create JSON output shape is UNVERIFIED. The requested name is
 *   retained as the handle.
 */

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
    this.getToken = options.getToken || (audience => {
      if (audience !== TOKEN_AUDIENCE) throw new Error('Unexpected Azure token audience.');
      return getAzureAccessToken({ azBin: this.azBin, subscriptionId: this.subscriptionId, run: this.runProcess });
    });
    this.createDiskImage = options.createDiskImage || createDiskImage;
    this.diskImagePromise = null;
    this.secretEnvKeys = options.secretEnvKeys || [];
  }

  async create(spec) {
    if (validateSandboxImageRef(spec.image) !== this.image) {
      throw new Error('Sandbox create image does not match the configured image reference.');
    }
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
    this.diskImageId = diskId;
    const labels = Object.entries(spec.labels || {}).flatMap(([key, value]) => ['-l', `${key}=${value}`]);
    const args = [
      ...this.acaBinArgs, 'sandbox', 'create', '--region', this.region, '--group', this.group, '--name', spec.name,
      '--disk-id', diskId, '--cpu', spec.cpu || '1000m', '--memory', spec.memory || '2048Mi',
      ...labels
    ];
    const result = await this.runProcess(this.acaBin, args, { timeoutMs: 120000, secretEnvKeys: this.secretEnvKeys });
    if (result.exitCode !== 0 || result.timedOut) throw new Error('aca sandbox create failed.');
    return { id: spec.name, name: spec.name, diskId };
  }

  async exec(handle, argv, options = {}) {
    const args = [...this.acaBinArgs, 'sandbox', 'exec', '--region', this.region, '--group', this.group, '--name', handle.name || handle.id, '--', ...argv];
    return this.runProcess(this.acaBin, args, { stdin: options.stdin, timeoutMs: options.timeoutMs, secretEnvKeys: this.secretEnvKeys });
  }

  async putFile(handle, remotePath, bytes) {
    const encoded = Buffer.from(bytes).toString('base64');
    const result = await this.exec(handle, ['sh', '-lc', `mkdir -p "$(dirname "$1")" && base64 -d > "$1"`, 'sh', remotePath], { stdin: encoded });
    if (result.exitCode !== 0) throw new Error(`aca sandbox putFile failed: ${result.stderr || result.stdout}`);
  }

  async uploadFile(handle, remotePath, bytes) {
    return this.putFile(handle, remotePath, bytes);
  }

  async readFile(handle, remotePath) {
    const result = await this.exec(handle, ['sh', '-lc', 'base64 "$1"', 'sh', remotePath]);
    if (result.exitCode !== 0) throw new Error(`aca sandbox readFile failed: ${result.stderr || result.stdout}`);
    return Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64');
  }

  async downloadFile(handle, remotePath) {
    return this.readFile(handle, remotePath);
  }

  async delete(handle) {
    const result = await this.runProcess(this.acaBin, [...this.acaBinArgs, 'sandbox', 'delete', '--region', this.region, '--group', this.group, '--name', handle.name || handle.id, '--yes'], { timeoutMs: 120000, secretEnvKeys: this.secretEnvKeys });
    if (result.exitCode !== 0) throw new Error(`aca sandbox delete failed: ${result.stderr || result.stdout}`);
  }

  async deleteDiskImage() {
    if (!this.diskImageId) return;
    const result = await this.runProcess(this.acaBin, [
      ...this.acaBinArgs, 'sandboxgroup', 'disk', 'delete', '--region', this.region,
      '--group', this.group, '--id', this.diskImageId,
      '--subscription', this.subscriptionId,
      '--resource-group', this.resourceGroup,
      '--wait-timeout', '180'
    ], { timeoutMs: 210000, secretEnvKeys: this.secretEnvKeys });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`ACA disk image deletion failed for disk ${this.diskImageId} (exit code ${result.exitCode}).`);
    }
    this.diskImageId = null;
    this.diskImagePromise = null;
  }
}

module.exports = { AcaCliSandboxClient, getAzureAccessToken };
