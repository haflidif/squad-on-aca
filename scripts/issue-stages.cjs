'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateContract } = require('../contracts/aca-sandbox/v1/tools/validate');
const { validateMaxAiCredits } = require('../contracts/aca-sandbox/v1/tools/copilot-credit-limit');
const { resolveContainedFile } = require('./issue-route.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function groupStages(tasks) {
  const byId = new Map(tasks.map(task => [task.task_id, task]));
  if (byId.size !== tasks.length || !tasks.length) throw new Error('DECISION_DEPENDENCY_INVALID');
  for (const task of tasks) {
    for (const dependency of task.dependencies || []) {
      const parent = byId.get(dependency.task_id);
      if (!parent || parent === task || parent.dependencies?.length) throw new Error('DECISION_DEPENDENCY_INVALID');
    }
  }
  return [tasks.filter(task => !task.dependencies?.length), tasks.filter(task => task.dependencies?.length)].filter(stage => stage.length);
}
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error('STAGE_COMMAND_FAILED');
  return result.stdout;
}
function git(repo, args, input) {
  return command('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { input });
}
function checkedPatch(out, summary) {
  const file = resolveContainedFile(out, summary.integration.integrated_patch_path);
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== summary.integration.sha256) throw new Error('STAGE_PATCH_HASH_MISMATCH');
  return file;
}
function copyPatches(stageOut, stagePlan, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const task of stagePlan.tasks) {
    const root = path.join(stageOut, 'tasks', task.task_id);
    const manifestFile = path.join(root, 'artifact-manifest.json');
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = read(manifestFile);
    for (const artifact of manifest.artifacts || []) {
      if (artifact.kind !== 'patch') continue;
      const source = resolveContainedFile(root, artifact.path);
      const bytes = fs.readFileSync(source);
      if (hash(bytes) !== artifact.sha256) throw new Error('STAGE_PATCH_HASH_MISMATCH');
      fs.writeFileSync(path.join(destination, `${task.task_id}.patch`), bytes);
    }
  }
  const manifestFile = path.join(stageOut, 'integration', 'artifact-manifest.json');
  if (fs.existsSync(manifestFile)) {
    const artifact = read(manifestFile).artifacts.find(item => item.kind === 'patch');
    if (artifact) {
      const bytes = fs.readFileSync(resolveContainedFile(path.join(stageOut, 'integration'), artifact.path));
      if (hash(bytes) !== artifact.sha256) throw new Error('STAGE_PATCH_HASH_MISMATCH');
      fs.writeFileSync(path.join(destination, 'combined.patch'), bytes);
    }
  }
}
function skipped(task, now) {
  return { task_id: task.task_id, logical_member_id: task.owner.logical_member_id, status: 'skipped', reason: 'Earlier member stage failed.', started_at: now, ended_at: now, sandbox_id: '', artifact_paths: [], deletion_error: '' };
}
function runStages(options, dispatch = defaultDispatch) {
  const plan = read(options.planPath);
  const validation = validateContract('coordinator-execution.schema.json', plan);
  if (!validation.valid) throw new Error('STAGE_PLAN_INVALID');
  const stages = groupStages(plan.tasks);
  const perMember = validateMaxAiCredits(options.maxAiCredits ?? 30);
  // Reserve once per routed persona, not once per stage or per full-plan replay.
  const budget = options.totalAiCredits ?? perMember * plan.tasks.length;
  if (!Number.isSafeInteger(budget) || budget < perMember * plan.tasks.length) throw new Error('STAGE_CREDIT_BUDGET_INSUFFICIENT');
  const out = path.resolve(options.outDir);
  const work = path.join(out, '.stage-work');
  const repo = path.join(work, 'repo');
  fs.mkdirSync(out, { recursive: true });
  const now = new Date().toISOString();
  const summary = { schema_version: plan.schema_version, message_type: 'dispatcher.summary', run_id: plan.run_id,
    status: 'failed', started_at: now, ended_at: now, disk_image_deletion_error: '',
    integration: { status: 'not_run', reason: '', sandbox_id: '', integrated_patch_path: '', sha256: '', failed_task_id: '', check_results: [], deletion_error: '' },
    tasks: plan.tasks.map(task => skipped(task, now)) };
  const progress = { credit_budget: budget, reserved_ai_credits: 0, stages: [] };
  let baseline = plan.baseline_sha;
  let firstPatch;
  const diagnosticParts = [];
  try {
    for (const [index, tasks] of stages.entries()) {
      const number = index + 1;
      const stageOut = path.join(out, `stage-${number}`);
      const stagePlan = { ...plan, run_id: stages.length === 1 ? plan.run_id : `${plan.run_id}-stage-${number}`, baseline_sha: baseline,
        tasks: tasks.map(task => ({ ...task, baseline_sha: baseline, dependencies: [] })),
        integration: { ...plan.integration, check_commands: index === stages.length - 1 ? plan.integration.check_commands : [] } };
      const planPath = path.join(out, `stage-${number}-plan.json`);
      write(planPath, stagePlan);
      progress.reserved_ai_credits += perMember * tasks.length;
      const entry = { stage: number, status: 'failed', members: tasks.map(task => task.owner.logical_member_id) };
      progress.stages.push(entry);
      write(path.join(out, 'stage-results.json'), progress);
      const code = dispatch({ ...options, planPath, outDir: stageOut, repoPath: index ? repo : options.repoPath, maxAiCredits: perMember });
      const stageSummary = read(path.join(stageOut, 'dispatcher-summary.json'));
      if (!validateContract('dispatcher-summary.schema.json', stageSummary).valid || stageSummary.run_id !== stagePlan.run_id ||
          stageSummary.tasks.length !== tasks.length || stageSummary.tasks.some(task => !tasks.some(expected => expected.task_id === task.task_id && expected.owner.logical_member_id === task.logical_member_id))) throw new Error('STAGE_SUMMARY_INVALID');
      const diagnosticDir = path.join(out, 'diagnostic-patches', `stage-${number}`);
      copyPatches(stageOut, stagePlan, diagnosticDir);
      for (const task of tasks) {
        const file = path.join(diagnosticDir, `${task.task_id}.patch`);
        if (fs.existsSync(file)) diagnosticParts.push(fs.readFileSync(file));
      }
      if (diagnosticParts.length) fs.writeFileSync(path.join(out, 'diagnostic-patches', 'combined.patch'), Buffer.concat(diagnosticParts));
      summary.tasks = summary.tasks.map(task => stageSummary.tasks.find(result => result.task_id === task.task_id) || task);
      summary.integration = { ...stageSummary.integration, reason: `member-stage-${number}: ${stageSummary.integration.reason}` };
      summary.disk_image_deletion_error = stageSummary.disk_image_deletion_error || '';
      if (code !== 0 || stageSummary.status !== 'succeeded' || stageSummary.integration.status !== 'succeeded' || summary.disk_image_deletion_error || stageSummary.integration.deletion_error || stageSummary.tasks.some(task => task.status !== 'succeeded' || task.deletion_error)) break;
      const patch = checkedPatch(stageOut, stageSummary);
      entry.status = 'succeeded';
      if (!index && stages.length > 1) {
        firstPatch = patch;
        fs.mkdirSync(work, { recursive: true });
        command('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', path.resolve(options.repoPath), repo]);
        git(repo, ['checkout', '--quiet', '--detach', plan.baseline_sha]);
        git(repo, ['apply', '--index', '--whitespace=nowarn', firstPatch]);
        const tree = git(repo, ['write-tree']).trim();
        // An unreferenced runtime snapshot in the isolated clone; never commit to the user's checkout.
        baseline = git(repo, ['-c', 'user.name=Stage snapshot', '-c', 'user.email=stage@invalid', 'commit-tree', tree, '-p', plan.baseline_sha], 'Member stage 1 snapshot\n').trim();
      }
      if (index === stages.length - 1) {
        let bytes = fs.readFileSync(patch);
        if (firstPatch) {
          git(repo, ['apply', '--index', '--whitespace=nowarn', patch]);
          bytes = Buffer.from(git(repo, ['diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', plan.baseline_sha]));
        }
        const relative = 'integration/patches/combined.patch';
        fs.mkdirSync(path.join(out, 'integration', 'patches'), { recursive: true });
        fs.writeFileSync(path.join(out, relative), bytes);
        const manifest = read(path.join(stageOut, 'integration', 'artifact-manifest.json'));
        write(path.join(out, 'integration', 'artifact-manifest.json'), { ...manifest, run_id: plan.run_id, baseline_sha: plan.baseline_sha,
          artifacts: [{ artifact_id: 'combined-patch', kind: 'patch', path: 'patches/combined.patch', sha256: hash(bytes), size_bytes: bytes.length, media_type: 'text/x-diff' }] });
        fs.writeFileSync(path.join(out, 'diagnostic-patches', 'combined.patch'), bytes);
        summary.integration.integrated_patch_path = relative;
        summary.integration.sha256 = hash(bytes);
        summary.status = 'succeeded';
      }
      write(path.join(out, 'stage-results.json'), progress);
    }
  } catch {
    if (progress.stages.length) progress.stages.at(-1).status = 'failed';
    summary.disk_image_deletion_error = 'Stage execution aborted; cleanup cannot be confirmed.';
    summary.status = 'failed';
    summary.integration.status = 'failed';
    summary.integration.reason = `member-stage-${progress.stages.at(-1)?.stage || 1}: STAGE_EXECUTION_FAILED`;
  } finally {
    summary.ended_at = new Date().toISOString();
    if (summary.status !== 'succeeded') {
      if (summary.integration.status === 'succeeded') summary.integration.status = 'failed';
      summary.integration.integrated_patch_path = '';
      summary.integration.sha256 = '';
    }
    write(path.join(out, 'stage-results.json'), progress);
    write(path.join(out, 'dispatcher-summary.json'), summary);
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
  return summary;
}
function defaultDispatch(options) {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'dispatcher', 'cli.js'), '--plan', options.planPath,
    '--repo', options.repoPath, '--out', options.outDir, '--repo-full-name', options.repoFullName, '--issue-number', String(options.issueNumber),
    '--client', 'aca', '--auth-mode', 'actions', '--max-ai-credits', String(options.maxAiCredits), '--concurrency', '1', '--timeout-ms', '300000'], { stdio: 'inherit' });
  return result.status ?? 1;
}
if (require.main === module) {
  const args = {};
  const names = { '--plan': 'planPath', '--repo': 'repoPath', '--out': 'outDir', '--repo-full-name': 'repoFullName', '--issue-number': 'issueNumber', '--max-ai-credits': 'maxAiCredits', '--total-ai-credits': 'totalAiCredits' };
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const key = names[process.argv[i]];
      if (!key || process.argv[i + 1] === undefined) throw new Error('USAGE');
      args[key] = process.argv[++i];
    }
    if (args.totalAiCredits !== undefined) args.totalAiCredits = Number(args.totalAiCredits);
    process.exitCode = runStages(args).status === 'succeeded' ? 0 : 1;
  } catch { console.error('ISSUE_MEMBER_STAGES_FAILED'); process.exitCode = 1; }
}
module.exports = { groupStages, runStages };