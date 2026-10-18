'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = '.squad/sandbox-flow.json';
const DEFAULT_PATHS = ['**'];
const MAX_STEPS = 10;
const MAX_PATHS = 50;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function globToRegExp(pattern) {
  let result = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') { index++; result += '(?:.*/)?'; }
        else result += '.*';
      } else result += '[^/]*';
    } else if (char === '?') result += '[^/]';
    else result += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${result}$`, 'iu');
}
function validPathPattern(pattern) {
  return typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 240 &&
    !pattern.includes('\\') && !pattern.startsWith('/') && !/^[A-Za-z]:/u.test(pattern) &&
    !/[\x00-\x1f\x7f]/u.test(pattern) &&
    !pattern.split('/').some(part => !part || part === '.' || part === '..');
}
function enginePath(relative, root) {
  if (!fs.existsSync(path.join(root, 'dispatcher', 'cli.js')) || !fs.existsSync(path.join(root, 'contracts', 'aca-sandbox', 'v1', 'schemas', 'integration-dispatch.schema.json'))) return false;
  const file = relative.toLowerCase();
  return file.startsWith('dispatcher/') || file.startsWith('contracts/aca-sandbox/') ||
    file.startsWith('agents/sandbox/') ||
    /^scripts\/(?:issue-[^/]+\.cjs|sandbox-flow-config\.cjs|install-sandbox-tools\.cjs)$/.test(file) ||
    /^\.github\/workflows\/squad-sandbox-[^/]+\.yml$/.test(file);
}
function isDeniedPath(relative, root = process.cwd()) {
  if (!validPathPattern(relative) || relative.split('/').some(part => part.toLowerCase() === '.git')) return true;
  const normalized = relative.toLowerCase();
  if (normalized === '.github' || normalized.startsWith('.github/')) return true;
  if (normalized === '.squad' || normalized.startsWith('.squad/')) return true;
  return enginePath(relative, root);
}
function roleKind(role) {
  const value = String(role || '');
  if (/\blead\b|\breviewer\b|\bmonitor\b|\blogger\b/i.test(value)) return null;
  if (/documentation|docs/i.test(value)) return 'documentation';
  if (/\btests?\b|\btester\b|\btesting\b/i.test(value)) return 'testing';
  if (/\biac\b|\binfra(?:structure)?\b|\bplatform\b|\boperations?\b|\bsre\b/i.test(value)) return 'infrastructure';
  return 'implementation';
}
function memberPaths(member, config) {
  const members = config?.members || {};
  const role = String(member?.role || '').trim().toLowerCase();
  const exact = Object.keys(members).find(key => key.startsWith('role:') && key.slice(5).toLowerCase() === role);
  const entry = exact ? members[exact] : members[roleKind(role)];
  return entry?.allowed_paths || DEFAULT_PATHS;
}
function scopeMatchesAllowed(scope, member, config, root = process.cwd()) {
  return !isDeniedPath(scope, root) && memberPaths(member, config).some(pattern => globToRegExp(pattern).test(scope));
}
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== 1 ||
      Object.keys(config).some(key => !['version', 'members', 'postprocess'].includes(key))) fail('SANDBOX_FLOW_CONFIG_INVALID version');
  if (config.members !== undefined) {
    if (!config.members || typeof config.members !== 'object' || Array.isArray(config.members)) fail('SANDBOX_FLOW_CONFIG_INVALID members');
    for (const [key, member] of Object.entries(config.members)) {
      if (!/^(?:implementation|testing|infrastructure|documentation|role:[A-Za-z0-9 _&()+./-]{1,100})$/iu.test(key) ||
          !member || typeof member !== 'object' || Array.isArray(member) ||
          Object.keys(member).some(field => field !== 'allowed_paths') ||
          !Array.isArray(member.allowed_paths) || !member.allowed_paths.length || member.allowed_paths.length > MAX_PATHS ||
          member.allowed_paths.some(pattern => !validPathPattern(pattern))) fail(`SANDBOX_FLOW_CONFIG_INVALID members.${key}`);
    }
  }
  if (config.postprocess !== undefined) {
    const post = config.postprocess;
    if (!post || typeof post !== 'object' || Array.isArray(post) ||
        Object.keys(post).some(key => !['tools', 'steps'].includes(key))) fail('SANDBOX_FLOW_CONFIG_INVALID postprocess');
    const tools = post.tools === undefined ? {} : post.tools;
    if (!tools || typeof tools !== 'object' || Array.isArray(tools)) fail('SANDBOX_FLOW_CONFIG_INVALID postprocess.tools');
    for (const [name, tool] of Object.entries(tools)) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/u.test(name) || name === 'node' || !tool || typeof tool !== 'object' || Array.isArray(tool) ||
          Object.keys(tool).sort().join(',') !== 'sha256,url,version' ||
          typeof tool.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(tool.version) || /^latest$/iu.test(tool.version) ||
          typeof tool.url !== 'string' || !/^https:\/\//iu.test(tool.url) ||
          !/^[a-f0-9]{64}$/iu.test(tool.sha256)) fail(`SANDBOX_FLOW_CONFIG_INVALID postprocess.tools.${name}`);
      let url; try { url = new URL(tool.url); } catch { fail(`SANDBOX_FLOW_CONFIG_INVALID postprocess.tools.${name}.url`); }
      if (url.username || url.password || url.hash) fail(`SANDBOX_FLOW_CONFIG_INVALID postprocess.tools.${name}.url`);
    }
    if (post.steps !== undefined && (!Array.isArray(post.steps) || post.steps.length > MAX_STEPS)) fail('SANDBOX_FLOW_CONFIG_INVALID postprocess.steps');
    const names = new Set();
    for (const [index, step] of (post.steps || []).entries()) {
      if (!step || typeof step !== 'object' || Array.isArray(step) ||
          Object.keys(step).some(key => !['name', 'run', 'paths', 'timeout_ms'].includes(key)) ||
          typeof step.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(step.name) || names.has(step.name) ||
          !Array.isArray(step.run) || !step.run.length || step.run.some(arg => typeof arg !== 'string' || /[\x00\r\n]/u.test(arg)) ||
          !Array.isArray(step.paths) || !step.paths.length || step.paths.some(pattern => !validPathPattern(pattern)) ||
          step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || step.timeout_ms < 1000 || step.timeout_ms > 600000)) fail(`SANDBOX_FLOW_CONFIG_INVALID postprocess.steps.${index}`);
      names.add(step.name);
      const executable = step.run[0];
      if (executable !== 'node' && !Object.hasOwn(tools, executable)) fail(`SANDBOX_FLOW_CONFIG_INVALID postprocess.steps.${index}.executable`);
      if (step.run.slice(1).some(arg => /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(arg) || /^(?:[\\/]|[A-Za-z]:[\\/])/u.test(arg))) fail(`SANDBOX_FLOW_CONFIG_INVALID postprocess.steps.${index}.path`);
    }
  }
  return config;
}
function loadConfig(root) {
  const squadDir = path.join(root, '.squad');
  if (fs.existsSync(squadDir)) {
    const directoryStat = fs.lstatSync(squadDir);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('SANDBOX_FLOW_CONFIG_INVALID file');
  }
  const file = path.join(root, ...CONFIG_PATH.split('/'));
  if (!fs.existsSync(file)) return { version: 1, members: {}, postprocess: { tools: {}, steps: [] } };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) fail('SANDBOX_FLOW_CONFIG_INVALID file');
  let config; try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('SANDBOX_FLOW_CONFIG_INVALID json'); }
  return validateConfig(config);
}
module.exports = { CONFIG_PATH, DEFAULT_PATHS, enginePath, globToRegExp, isDeniedPath, loadConfig, memberPaths, roleKind, scopeMatchesAllowed, validPathPattern, validateConfig };
