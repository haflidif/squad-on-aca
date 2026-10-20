'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const entrypoints = Object.freeze({
  dispatch: 'dispatcher/cli.js',
  preflight: 'dispatcher/workflow-preflight.js',
  diagnose: 'dispatcher/diagnose-summary.js',
  'stage-pem': 'dispatcher/stage-pem.js',
  plan: 'scripts/issue-plan.cjs',
  route: 'scripts/issue-route.cjs',
  stages: 'scripts/issue-stages.cjs',
  revise: 'scripts/issue-revise.cjs',
  report: 'scripts/issue-report.cjs',
  'install-tools': 'scripts/install-sandbox-tools.cjs',
  postprocess: 'scripts/issue-postprocess.cjs'
});

const [command, ...args] = process.argv.slice(2);
if (!Object.hasOwn(entrypoints, command)) {
  console.error('ENGINE_COMMAND_INVALID');
  process.exitCode = 1;
} else {
  const engineRoot = path.resolve(__dirname, '../../..');
  const result = spawnSync(process.execPath, [path.join(engineRoot, entrypoints[command]), ...args], {
    cwd: process.cwd(), env: process.env, stdio: 'inherit', shell: false
  });
  if (result.error || result.signal) console.error('ENGINE_COMMAND_FAILED');
  process.exitCode = result.status ?? 1;
}
