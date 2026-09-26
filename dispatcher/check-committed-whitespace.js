const { spawnSync } = require('node:child_process');

function git(args, cwd, input) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message || result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

function commit(value, label, cwd) {
  if (!/^[a-f0-9]{40}$/i.test(value || '')) throw new Error(`${label} must be a full commit SHA.`);
  git(['cat-file', '-e', `${value}^{commit}`], cwd);
  return value;
}

function emptyTree(cwd) {
  return git(['hash-object', '-t', 'tree', '--stdin'], cwd, '');
}

function checkCommittedWhitespace(env = process.env, cwd = process.cwd()) {
  const head = commit(env.GITHUB_SHA, 'GITHUB_SHA', cwd);
  const actual = git(['rev-parse', 'HEAD'], cwd);
  if (actual.toLowerCase() !== head.toLowerCase()) throw new Error('GITHUB_SHA must match checked-out HEAD.');
  let base;
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    const prBase = commit(env.SQUAD_CI_PR_BASE_SHA, 'PR base SHA', cwd);
    base = git(['merge-base', prBase, head], cwd);
    if (!base) throw new Error('PR base has no merge-base with the checked-out commit.');
  } else if (env.GITHUB_EVENT_NAME === 'push') {
    const before = env.SQUAD_CI_PUSH_BEFORE;
    if (/^0{40}$/.test(before || '')) {
      if (String(env.SQUAD_CI_PUSH_CREATED).toLowerCase() === 'true') {
        base = emptyTree(cwd);
      } else if (env.SQUAD_CI_PUSH_BASE_SHA) {
        const baseSha = commit(env.SQUAD_CI_PUSH_BASE_SHA, 'push base SHA', cwd);
        base = git(['merge-base', baseSha, head], cwd);
        if (!base) throw new Error('Push base SHA has no merge-base with the checked-out commit.');
      } else {
        throw new Error('Zero-SHA push requires a created event or validated push base SHA.');
      }
    } else {
      base = commit(before, 'Push before SHA', cwd);
    }
  } else {
    throw new Error('Whitespace check requires a pull_request or push event.');
  }
  git(['diff', '--check', base, head], cwd);
  return { base, head };
}

if (require.main === module) {
  try {
    const range = checkCommittedWhitespace();
    console.log(`Committed whitespace checked: ${range.base}..${range.head}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkCommittedWhitespace };
