'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadRoster, validateRoutingDecision } = require('./issue-plan.cjs');
const { summarizeStored, renderComment } = require('./issue-report.cjs');
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
  const failed = result.status !== 'succeeded' || ['lead', 'member', 'publish'].some(stage => jobs[stage] !== 'success');
  if (failed) {
    await ensureLabel(github, repository, { name: 'sandbox:failed', color: 'B60205', description: 'Sandbox execution or publication failed' });
    await github.rest.issues.addLabels({ ...issue, labels: ['sandbox:failed'] });
  }
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
  await github.rest.issues.createComment({ ...issue, body: renderComment(result, { gate: 'success', ...jobs }) });
}
module.exports = { postReport, ensureLabel };
