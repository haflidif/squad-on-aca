const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateContract } = require('../tools/validate');

const root = path.join(__dirname, '..');
const schemasDir = path.join(root, 'schemas');
const fixturesDir = path.join(root, 'fixtures');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

test('legacy ACA Job message remains valid', () => {
  const result = validateContract('queue-message.schema.json', readFixture('legacy-aca-job-task.example.json'));
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('revision queue message remains valid', () => {
  const result = validateContract('queue-message.schema.json', {
    type: 'revise',
    pr_number: 7,
    issue_number: 42,
    branch: 'squad/example-agent/issue-42',
    agent_type: 'example-agent',
    repo: 'example-owner/example-repo',
    head_sha: '0123456789abcdef0123456789abcdef01234567',
    feedback: 'Illustrative feedback'
  });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('provider-extended fan-out queue message uses the provider object contract', () => {
  const execution = readFixture('dynamic-multi-agent-execution.example.json');
  const result = validateContract('queue-message.schema.json', {
    type: 'fanout',
    message_type: 'persona.dispatch',
    run_id: execution.run_id,
    task_id: execution.tasks[0].task_id,
    logical_member_id: execution.tasks[0].owner.logical_member_id,
    resolved_persistent_name: execution.tasks[0].owner.resolved_persistent_name,
    charter_ref: execution.tasks[0].owner.charter_ref,
    roster: execution.roster,
    baseline_sha: execution.baseline_sha,
    provider: execution.provider,
    required_capabilities: ['planning']
  });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('queue provider extension rejects a string provider', () => {
  const result = validateContract('queue-message.schema.json', {
    type: 'fanout',
    message_type: 'persona.dispatch',
    run_id: 'run-example',
    task_id: 'task-example',
    logical_member_id: 'member-example',
    resolved_persistent_name: 'Example Member',
    charter_ref: '.squad/agents/example/charter.md',
    roster: {
      revision: 'roster-example',
      hash: 'abcdef0123456789abcdef0123456789abcdef0',
      members: []
    },
    baseline_sha: '0123456789abcdef0123456789abcdef01234567',
    provider: 'aca-sandbox-example'
  });
  assert.equal(result.valid, false);
});

test('dynamic multi-agent execution fixture is valid', () => {
  const result = validateContract('coordinator-execution.schema.json', readFixture('dynamic-multi-agent-execution.example.json'));
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('all v1 contract schemas accept representative valid values', () => {
  const execution = readFixture('dynamic-multi-agent-execution.example.json');
  const owner = execution.tasks[0].owner;
  const provider = execution.provider;
  const context = {
    schema_version: 'aca-sandbox/v1',
    run_id: execution.run_id,
    task_id: execution.tasks[0].task_id,
    owner,
    baseline_sha: execution.baseline_sha,
    roster: execution.roster,
    provider
  };
  const cases = [
    ['persona-dispatch.schema.json', {
      ...context,
      message_type: 'persona.dispatch',
      objective: execution.tasks[0].objective,
      dependencies: [],
      owned_paths: ['docs/plan']
    }],
    ['persona-result.schema.json', {
      ...context,
      message_type: 'persona.result',
      status: 'succeeded',
      summary: 'Illustrative successful result',
      artifacts: []
    }],
    ['artifact-manifest.schema.json', {
      schema_version: 'aca-sandbox/v1',
      run_id: execution.run_id,
      task_id: execution.tasks[0].task_id,
      baseline_sha: execution.baseline_sha,
      roster: execution.roster,
      provider,
      artifacts: [{
        artifact_id: 'artifact-example-log',
        kind: 'log',
        path: 'artifacts/example.log',
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      }]
    }],
    ['integration-result.schema.json', {
      schema_version: 'aca-sandbox/v1',
      message_type: 'integration.result',
      run_id: execution.run_id,
      provider,
      baseline_sha: execution.baseline_sha,
      roster: execution.roster,
      status: 'succeeded',
      tasks: [{
        task_id: execution.tasks[0].task_id,
        status: 'succeeded',
        owner
      }],
      artifacts: []
    }],
    ['provider.schema.json', {
      schema_version: 'aca-sandbox/v1',
      provider,
      capabilities: ['dispatch', 'artifacts'],
      configuration: {
        mode: 'illustrative'
      }
    }]
  ];
  for (const [schema, value] of cases) {
    const result = validateContract(schema, value);
    assert.equal(result.valid, true, `${schema}: ${result.errors.join('\n')}`);
  }
});

test('fan-out rejects missing baseline and roster data', () => {
  const fixture = readFixture('dynamic-multi-agent-execution.example.json');
  delete fixture.baseline_sha;
  delete fixture.roster;
  const result = validateContract('coordinator-execution.schema.json', fixture);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('baseline_sha')));
  assert.ok(result.errors.some(error => error.includes('roster')));
});

test('fan-out rejects unknown and cyclic dependencies', () => {
  const fixture = readFixture('dynamic-multi-agent-execution.example.json');
  fixture.tasks[0].dependencies = [{ task_id: 'missing-task' }];
  fixture.tasks[1].dependencies = [{ task_id: 'task-example-validate' }];
  const result = validateContract('coordinator-execution.schema.json', fixture);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('unknown task')));
  assert.ok(result.errors.some(error => error.includes('dependency cycle')));
});

test('plan rejects duplicate IDs, unknown owners, capability mismatches, and provider drift', () => {
  const fixture = readFixture('dynamic-multi-agent-execution.example.json');
  fixture.tasks[1].task_id = fixture.tasks[0].task_id;
  fixture.tasks[0].owner.logical_member_id = 'missing-member';
  fixture.tasks[1].required_capabilities = ['planning'];
  fixture.tasks[1].provider = {
    id: 'different-provider',
    kind: 'local',
    contract_version: 'aca-sandbox-provider/v1'
  };
  const result = validateContract('coordinator-execution.schema.json', fixture);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('task IDs must be unique')));
  assert.ok(result.errors.some(error => error.includes('not present in roster')));
  assert.ok(result.errors.some(error => error.includes('capability not held')));
  assert.ok(result.errors.some(error => error.includes('provider does not match')));
});

test('dispatch rejects baseline, roster, provider, and owner mismatches against plan context', () => {
  const execution = readFixture('dynamic-multi-agent-execution.example.json');
  const dispatch = {
    schema_version: 'aca-sandbox/v1',
    message_type: 'persona.dispatch',
    run_id: execution.run_id,
    task_id: execution.tasks[0].task_id,
    owner: execution.tasks[0].owner,
    objective: execution.tasks[0].objective,
    required_capabilities: ['planning'],
    dependencies: [],
    baseline_sha: 'fedcba9876543210fedcba9876543210fedcba98',
    roster: execution.roster,
    provider: execution.provider,
    owned_paths: ['docs/plan']
  };
  const changedRoster = structuredClone(execution.roster);
  changedRoster.revision = 'different-roster';
  const changedProvider = structuredClone(execution.provider);
  changedProvider.id = 'different-provider';
  dispatch.roster = changedRoster;
  dispatch.provider = changedProvider;
  dispatch.owner = { ...dispatch.owner, resolved_persistent_name: 'Wrong Owner' };
  const result = validateContract('persona-dispatch.schema.json', dispatch, execution);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('baseline SHA')));
  assert.ok(result.errors.some(error => error.includes('roster snapshot')));
  assert.ok(result.errors.some(error => error.includes('provider')));
  assert.ok(result.errors.some(error => error.includes('owner identity')));
});

test('plan rejects overlapping, protected, absolute, and traversal owned paths', () => {
  const fixture = readFixture('dynamic-multi-agent-execution.example.json');
  fixture.tasks[0].owned_paths = ['src'];
  fixture.tasks[1].owned_paths = ['src/components'];
  const overlap = validateContract('coordinator-execution.schema.json', fixture);
  assert.equal(overlap.valid, false);
  assert.ok(overlap.errors.some(error => error.includes('overlaps')));

  fixture.tasks[0].owned_paths = ['.squad'];
  fixture.tasks[1].owned_paths = ['C:/repo/owned'];
  const protectedAndAbsolute = validateContract('coordinator-execution.schema.json', fixture);
  assert.equal(protectedAndAbsolute.valid, false);
  assert.ok(protectedAndAbsolute.errors.some(error => error.includes('protected path')));
  assert.ok(protectedAndAbsolute.errors.some(error => error.includes('absolute or parent traversal')));

  fixture.tasks[0].owned_paths = ['src/../secrets'];
  fixture.tasks[1].owned_paths = ['docs/validate'];
  const traversal = validateContract('coordinator-execution.schema.json', fixture);
  assert.equal(traversal.valid, false);
  assert.ok(traversal.errors.some(error => error.includes('absolute or parent traversal')));
});

test('dispatch requires owned_paths and keeps them within the plan task ownership', () => {
  const execution = readFixture('dynamic-multi-agent-execution.example.json');
  const dispatch = {
    schema_version: 'aca-sandbox/v1',
    message_type: 'persona.dispatch',
    run_id: execution.run_id,
    task_id: execution.tasks[0].task_id,
    owner: execution.tasks[0].owner,
    objective: execution.tasks[0].objective,
    required_capabilities: ['planning'],
    dependencies: [],
    baseline_sha: execution.baseline_sha,
    roster: execution.roster,
    provider: execution.provider
  };
  const missing = validateContract('persona-dispatch.schema.json', dispatch, execution);
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some(error => error.includes('owned_paths')));

  dispatch.owned_paths = ['docs/plan/detail'];
  const subset = validateContract('persona-dispatch.schema.json', dispatch, execution);
  assert.equal(subset.valid, true, subset.errors.join('\n'));

  dispatch.owned_paths = ['docs/validate'];
  const outside = validateContract('persona-dispatch.schema.json', dispatch, execution);
  assert.equal(outside.valid, false);
  assert.ok(outside.errors.some(error => error.includes('outside task')));
});

test('path ownership uses segment-aware prefixes', () => {
  const fixture = readFixture('dynamic-multi-agent-execution.example.json');
  fixture.tasks[0].owned_paths = ['src'];
  fixture.tasks[1].owned_paths = ['src-other'];
  const result = validateContract('coordinator-execution.schema.json', fixture);
  assert.equal(result.valid, true, result.errors.join('\n'));
});
test('schemas do not encode this repository roster names', () => {
  const forbiddenNames = /\b(?:Wedge|Chewie|Lando|Cassian|Bodhi|Rai|Ralph|Scribe)\b/;
  for (const file of fs.readdirSync(schemasDir).filter(file => file.endsWith('.json'))) {
    const contents = fs.readFileSync(path.join(schemasDir, file), 'utf8');
    assert.equal(forbiddenNames.test(contents), false, `${file} contains a hard-coded cast name`);
  }
});
