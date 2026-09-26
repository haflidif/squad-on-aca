const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runChecked } = require('./util');

function hardenedVerificationEnv(ctx, extra = {}) {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: ctx.globalConfig,
    HOME: ctx.homeDir,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_PARAMETERS: '',
    ...extra
  };
}
function hardenedGitArgs(ctx, args) {
  return [
    '-c', `core.hooksPath=${ctx.hooksDir}`,
    '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf',
    '-c', 'core.fileMode=true',
    '-c', 'core.symlinks=false',
    '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.clean=',
    '-c', 'filter.lfs.process=',
    '-c', 'filter.lfs.required=false',
    '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false',
    ...args
  ];
}
const ALLOWED_VERIFICATION_GIT_COMMANDS = new Set([
  'init',
  'fetch',
  'rev-parse',
  'read-tree',
  'apply',
  'ls-files',
  'cat-file',
  'write-tree',
  'diff',
  'diff-tree'
]);
function verificationGitCommand(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = String(args[index]);
    if (arg === '--') return '';
    if (arg === '-c' || arg === '-C' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
      index++;
      continue;
    }
    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=') || arg.startsWith('--namespace=')) continue;
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return '';
}
function assertAllowedVerificationGit(args, allowedCommands = ALLOWED_VERIFICATION_GIT_COMMANDS) {
  const command = verificationGitCommand(args);
  if (!allowedCommands.has(command)) {
    throw new Error(`verification git command is not allowed: ${command || args.join(' ')}`);
  }
  if (command === 'apply' && !args.includes('--cached')) {
    throw new Error('verification git apply must use --cached');
  }
  if (command === 'read-tree' && args.some(arg => arg === '-u' || arg === '--reset' || arg === '-m')) {
    throw new Error('verification git read-tree must not update a worktree or merge trees');
  }
}
function hardenedGitEnv(ctx, extra = {}) {
  return Object.fromEntries(Object.entries({
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    ...hardenedVerificationEnv(ctx, extra)
  }).filter(([, value]) => value !== undefined));
}
function recordVerificationGit(ctx, args, env) {
  if (typeof ctx.onVerificationGitSpawn === 'function') {
    ctx.onVerificationGitSpawn({ args: [...args], env: { ...env } });
  }
}
async function hardenedGit(ctx, args, options = {}) {
  assertAllowedVerificationGit(args, ctx.allowedCommands || ALLOWED_VERIFICATION_GIT_COMMANDS);
  const gitArgs = hardenedGitArgs(ctx, args);
  const env = hardenedVerificationEnv(ctx, options.env);
  recordVerificationGit(ctx, gitArgs, env);
  return runChecked('git', gitArgs, {
    cwd: options.cwd || ctx.cwd,
    env,
    secretEnvKeys: ctx.secretEnvKeys
  });
}
function hardenedGitBuffer(ctx, args, options = {}) {
  assertAllowedVerificationGit(args, ctx.allowedCommands || ALLOWED_VERIFICATION_GIT_COMMANDS);
  const gitArgs = hardenedGitArgs(ctx, args);
  const env = hardenedGitEnv(ctx, options.env);
  recordVerificationGit(ctx, gitArgs, env);
  const result = spawnSync('git', gitArgs, {
    cwd: options.cwd || ctx.cwd,
    env,
    shell: false,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed with ${result.status}: ${result.stderr?.toString('utf8') || result.stdout?.toString('utf8') || ''}`);
  return result.stdout || Buffer.alloc(0);
}


function createHardenedContext(root, config = {}) {
  return {
    cwd: root,
    repoDir: config.repoDir || root,
    homeDir: path.join(root, 'home'),
    hooksDir: path.join(root, 'hooks'),
    globalConfig: path.join(root, 'global.gitconfig'),
    secretEnvKeys: config.secretEnvKeys || [],
    allowedCommands: config.allowedCommands,
    onVerificationGitSpawn: config.onVerificationGitSpawn
  };
}

module.exports = {
  hardenedVerificationEnv,
  hardenedGitArgs,
  verificationGitCommand,
  assertAllowedVerificationGit,
  hardenedGitEnv,
  recordVerificationGit,
  hardenedGit,
  hardenedGitBuffer,
  createHardenedContext,
  ALLOWED_VERIFICATION_GIT_COMMANDS
};
