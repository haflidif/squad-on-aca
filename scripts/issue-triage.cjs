'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadRoster, validateRoutingDecision } = require('./issue-plan.cjs');
const { summarizeStored, renderComment, isNoChangeRevise } = require('./issue-report.cjs');
const { memberLabelDefinitions } = require('./member-labels.cjs');

async function ensureLabel(github, repository, label) {
  try { await github.rest.issues.getLabel({ ...repository, name: label.name }); }
  catch (error) {
    if (error.status !== 404) throw error;
    try { await github.rest.issues.createLabel({ ...repository, ...label }); }
    catch (createError) {
      if (createError.status !== 422) throw createError;
      await github.rest.issues.getLabel({ ...repository, name: label.name });
    }
  }
}

async function postReport({ github, context, root, reportDir, jobs }) {
  const result = summarizeStored(JSON.parse(fs.readFileSync(path.join(reportDir, 'issue-result.json'), 'utf8')));
  const repository = context.repo;
  const issue = { ...repository, issue_number: context.issue.number };
  const { transitionLabels, BRANCH, ownedPull } = require('./issue-revise.cjs');
  const pulls = await github.paginate(github.rest.pulls.list, { ...repository, state: 'open', base: 'main', per_page: 100 });
  const reviseFile = path.join(root, '.squad-issue', 'revise.json');
  const revise = fs.existsSync(reviseFile) ? require('./issue-revise.cjs').readContext(reviseFile, `${repository.owner}/${repository.repo}`, issue.issue_number) : null;
  jobs = { ...jobs, revise: Boolean(revise) };
  const failed = !isNoChangeRevise(result, jobs) && (result.status !== 'succeeded' || ['lead', 'member', 'postprocess', 'publish'].some(stage => jobs[stage] !== 'success'));
  const executionId = `issue-${issue.issue_number}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}-member`;
  const safeExecutionId = require('../dispatcher/publish').sanitizeUntrusted(executionId, 'execution id', 120);
  const matching = pulls.filter(pr => ownedPull(pr, `${repository.owner}/${repository.repo}`) && Number(BRANCH.exec(pr.head.ref)[1]) === issue.issue_number && (revise ? pr.number === revise.pr_number : pr.body?.includes("Execution ID: `" + safeExecutionId + "`")));
  await transitionLabels(github, repository, [issue.issue_number, ...(revise ? [revise.pr_number] : matching.map(pr => pr.number))], !failed);
  if (result.route?.members) {
    const roster = loadRoster(root);
    const { selections } = validateRoutingDecision({ reason: result.route.reason, members: result.route.members.map(member => ({
      member: member.logical_member_id, objective: member.objective, owned_paths: member.owned_paths
    })) }, roster);
    const definitions = memberLabelDefinitions(roster.members.map(member => ({ name: member.resolved_persistent_name, role: member.role })));
    const labels = [];
    for (const selection of selections) {
      const label = definitions[roster.members.findIndex(member => member.logical_member_id === selection.member.logical_member_id)];
      await ensureLabel(github, repository, label);
      labels.push(label.name);
    }
    await github.rest.issues.addLabels({ ...issue, labels });
  }
  await github.rest.issues.createComment({ ...issue, issue_number: isNoChangeRevise(result, jobs) ? revise.pr_number : issue.issue_number, body: renderComment(result, { gate: 'success', ...jobs }) });
}
module.exports = { postReport, ensureLabel };
