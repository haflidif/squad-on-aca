const { spawn } = require('node:child_process');
const { buildSafeChildEnv } = require('../lib/util');

/*
 * UNVERIFIED ACA CLI CONTRACT
 * The following argv mapping is intentionally isolated in this file until PR 6
 * verifies it against a live ACA Sandbox Group:
 * - create: aca sandbox create --group <group> --name <name> --cpu <cpu> --memory <memory> --auto-suspend <seconds> --label k=v --env k=v --output json
 * - exec:   aca sandbox exec --group <group> --name <name> -- <argv...>
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
 * - Sandbox create JSON output shape is UNVERIFIED. This client treats the
 *   requested name as the handle and preserves raw stdout for diagnostics.
 * - ACR auth from a Sandbox Group is UNVERIFIED and not modeled here.
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

class AcaCliSandboxClient {
  constructor(options = {}) {
    if (process.env.SQUAD_ENABLE_ACA_SANDBOX !== '1') {
      throw new Error('Refusing to use live ACA Sandbox client unless SQUAD_ENABLE_ACA_SANDBOX=1 is set.');
    }
    this.group = options.group || process.env.SQUAD_SANDBOX_GROUP_NAME;
    if (!this.group) throw new Error('SQUAD_SANDBOX_GROUP_NAME is required for the ACA Sandbox client.');
    this.acaBin = options.acaBin || process.env.SQUAD_ACA_BIN || process.env.ACA_BIN || 'aca';
    this.acaBinArgs = options.acaBinArgs || [];
    this.secretEnvKeys = options.secretEnvKeys || [];
  }

  async create(spec) {
    const name = spec.name;
    const args = [...this.acaBinArgs, 'sandbox', 'create', '--group', this.group, '--name', name, '--cpu', spec.cpu, '--memory', spec.memory, '--auto-suspend', String(spec.autoSuspendSeconds), '--output', 'json'];
    for (const [key, value] of Object.entries(spec.labels || {})) args.push('--label', `${key}=${value}`);
    for (const [key, value] of Object.entries(spec.env || {})) args.push('--env', `${key}=${value}`);
    const result = await runProcess(this.acaBin, args, { timeoutMs: spec.timeoutMs || 120000, secretEnvKeys: this.secretEnvKeys });
    if (result.exitCode !== 0) throw new Error(`aca sandbox create failed: ${result.stderr || result.stdout}`);
    return { id: name, name, raw: result.stdout };
  }

  async exec(handle, argv, options = {}) {
    const args = [...this.acaBinArgs, 'sandbox', 'exec', '--group', this.group, '--name', handle.name || handle.id, '--', ...argv];
    return runProcess(this.acaBin, args, { stdin: options.stdin, timeoutMs: options.timeoutMs, secretEnvKeys: this.secretEnvKeys });
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
    const result = await runProcess(this.acaBin, [...this.acaBinArgs, 'sandbox', 'delete', '--group', this.group, '--name', handle.name || handle.id, '--yes'], { timeoutMs: 120000, secretEnvKeys: this.secretEnvKeys });
    if (result.exitCode !== 0) throw new Error(`aca sandbox delete failed: ${result.stderr || result.stdout}`);
  }
}

module.exports = { AcaCliSandboxClient };
