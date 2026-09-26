#!/usr/bin/env node
const path = require('node:path');
const { runDispatcher } = require('./dispatcher');
const { runPublish } = require('./publish');

function parseArgs(argv) {
  const args = { command: 'dispatch', client: 'fake' };
  let start = 0;
  if (argv[0] === 'publish' || argv[0] === 'dispatch') {
    args.command = argv[0];
    start = 1;
  }
  for (let index = start; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--plan') args.planPath = argv[++index];
    else if (arg === '--repo') args.repoPath = argv[++index];
    else if (arg === '--out') args.outDir = argv[++index];
    else if (arg === '--client') args.client = argv[++index];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (arg === '--timeout-ms') args.config = { ...(args.config || {}), timeoutMs: Number(argv[++index]) };
    else if (arg === '--no-integrate') args.integrate = false;
    else if (arg === '--summary') args.summaryPath = argv[++index];
    else if (arg === '--result') args.outPath = argv[++index];
    else if (arg === '--repo-full-name') args.repoFullName = argv[++index];
    else if (arg === '--issue-number') args.issueNumber = argv[++index];
    else if (arg === '--issue-title') args.issueTitle = argv[++index];
    else if (arg === '--target-branch') args.targetBranch = argv[++index];
    else if (arg === '--remote') args.remote = argv[++index];
    else if (arg === '--baseline-sha') args.baselineSha = argv[++index];
    else if (arg === '--live') args.live = true;
    else if (arg === '--update') args.update = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:\n  node dispatcher/cli.js --plan plan.json --repo <path> --out <dir> [--client fake|aca] [--repo-full-name owner/repo --issue-number N] [--concurrency N] [--no-integrate]\n  node dispatcher/cli.js publish --summary dispatcher-summary.json --repo <path> --plan plan.json --repo-full-name owner/repo --issue-number N [--issue-title title] [--target-branch branch] [--result publish-result.json] [--live]\n\nDefault dispatch client is fake. The aca client requires SQUAD_ENABLE_ACA_SANDBOX=1 and an exact plan issue binding. Live publish requires --live and SQUAD_ENABLE_PUBLISH=1.`;
}

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    if (args.command === 'publish') {
      if (!args.summaryPath || !args.repoPath || !args.planPath || !args.repoFullName || !args.issueNumber) throw new Error(usage());
      if (args.live && process.env.SQUAD_ENABLE_PUBLISH !== '1') throw new Error('Refusing live publish unless SQUAD_ENABLE_PUBLISH=1 is set.');
      const result = await runPublish(args);
      console.log(`publish-result: ${path.resolve(result.resultPath)}`);
      return;
    }
    if (!args.planPath || !args.repoPath || !args.outDir) throw new Error(usage());
    if (!['fake', 'aca'].includes(args.client)) throw new Error('--client must be fake or aca');
    if (args.client === 'aca' && process.env.SQUAD_ENABLE_ACA_SANDBOX !== '1') {
      throw new Error('Refusing live ACA Sandbox dispatch unless SQUAD_ENABLE_ACA_SANDBOX=1 is set.');
    }
    const result = await runDispatcher(args);
    console.log(`summary: ${path.resolve(result.summaryPath)}`);
    process.exitCode = result.summary.status === 'succeeded' ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
})();
