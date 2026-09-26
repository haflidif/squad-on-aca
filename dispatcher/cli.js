#!/usr/bin/env node
const path = require('node:path');
const { runDispatcher } = require('./dispatcher');

function parseArgs(argv) {
  const args = { client: 'fake' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--plan') args.planPath = argv[++index];
    else if (arg === '--repo') args.repoPath = argv[++index];
    else if (arg === '--out') args.outDir = argv[++index];
    else if (arg === '--client') args.client = argv[++index];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (arg === '--timeout-ms') args.config = { ...(args.config || {}), timeoutMs: Number(argv[++index]) };
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage: node dispatcher/cli.js --plan plan.json --repo <path> --out <dir> [--client fake|aca] [--concurrency N]\n\nDefault client is fake. The aca client also requires SQUAD_ENABLE_ACA_SANDBOX=1.`;
}

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
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
