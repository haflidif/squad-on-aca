const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSafeChildEnv, findBash, run, safeName } = require('../lib/util');

class FakeSandboxClient {
  constructor(options = {}) {
    this.root = path.resolve(options.root || path.join(process.cwd(), '.dispatcher-fake-sandboxes'));
    this.bash = options.bash || findBash();
    this.deleted = [];
    this.created = [];
    this.execCalls = [];
    this.activeExecs = 0;
    this.maxActiveExecs = 0;
    this.onBeforeReadFile = options.onBeforeReadFile;
    this.secretEnvKeys = options.secretEnvKeys || [];
    if (!this.bash) throw new Error('bash is required for FakeSandboxClient. Set SQUAD_ALLOW_SKIP_BASH_TESTS=1 only for tests that explicitly skip bash.');
  }

  async create(spec) {
    fs.mkdirSync(this.root, { recursive: true });
    const id = safeName(`${spec.labels?.execution_id || 'run'}-${spec.labels?.task_id || Date.now()}-${this.created.length + 1}`);
    const sandboxRoot = path.join(this.root, id);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    fs.mkdirSync(sandboxRoot, { recursive: true });
    const handle = { id, root: sandboxRoot, labels: spec.labels || {} };
    this.created.push(handle);
    return handle;
  }

  remoteToHost(handle, remotePath) {
    const normalized = String(remotePath).replace(/\\/g, '/');
    if (!normalized.startsWith('/workspace')) throw new Error(`fake sandbox path must be under /workspace: ${remotePath}`);
    const relative = normalized.slice('/workspace'.length).replace(/^\/+/, '');
    return path.join(handle.root, relative);
  }

  bashPath(hostPath) {
    if (process.platform !== 'win32') return hostPath;
    const result = spawnSync(this.bash, ['-lc', 'if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf "%s" "$1"; fi', 'bash', hostPath], {
      encoding: 'utf8',
      env: buildSafeChildEnv({}, { secretEnvKeys: this.secretEnvKeys })
    });
    if (result.status !== 0) throw new Error(`cygpath failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  mapValue(handle, value) {
    if (typeof value !== 'string') return value;
    if (value.startsWith('/workspace')) return this.bashPath(this.remoteToHost(handle, value));
    if (path.isAbsolute(value)) return this.bashPath(value);
    return value;
  }

  mapStdin(handle, stdin) {
    if (typeof stdin !== 'string') return stdin;
    try {
      const payload = JSON.parse(stdin);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return stdin;
      const mapped = {};
      for (const [key, value] of Object.entries(payload)) mapped[key] = this.mapValue(handle, value);
      return `${JSON.stringify(mapped)}\n`;
    } catch {
      return stdin;
    }
  }

  async putFile(handle, remotePath, bytes) {
    const hostPath = this.remoteToHost(handle, remotePath);
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.writeFileSync(hostPath, bytes);
  }

  async uploadFile(handle, remotePath, bytes) {
    return this.putFile(handle, remotePath, bytes);
  }

  async readFile(handle, remotePath) {
    if (this.onBeforeReadFile) await this.onBeforeReadFile(handle, remotePath, this);
    return fs.readFileSync(this.remoteToHost(handle, remotePath));
  }

  async downloadFile(handle, remotePath) {
    return this.readFile(handle, remotePath);
  }

  async exec(handle, argv, options = {}) {
    this.activeExecs += 1;
    this.maxActiveExecs = Math.max(this.maxActiveExecs, this.activeExecs);
    try {
      let mappedArgv;
      if ((argv[0] === 'node' || argv[0] === process.execPath) && String(argv[1] || '').endsWith('exec-with-env.js')) {
        mappedArgv = [argv[0], argv[1], argv[2], ...argv.slice(3).map(value => this.mapValue(handle, value))];
      } else {
        mappedArgv = [argv[0], ...argv.slice(1).map(value => this.mapValue(handle, value))];
      }
      const mappedEnv = {};
      for (const [key, value] of Object.entries(options.env || {})) mappedEnv[key] = this.mapValue(handle, value);
      const mappedStdin = this.mapStdin(handle, options.stdin);
      this.execCalls.push({
        argv: mappedArgv,
        env: { ...mappedEnv },
        stdin: mappedStdin
      });
      const env = buildSafeChildEnv(mappedEnv, { secretEnvKeys: [...this.secretEnvKeys, ...(options.secretEnvKeys || [])] });
      const result = await run(mappedArgv[0], mappedArgv.slice(1), {
        cwd: handle.root,
        env,
        stdin: mappedStdin,
        timeoutMs: options.timeoutMs
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
    } finally {
      this.activeExecs -= 1;
    }
  }

  async delete(handle) {
    this.deleted.push(handle.id);
    fs.rmSync(handle.root, { recursive: true, force: true });
  }
}

module.exports = { FakeSandboxClient };
