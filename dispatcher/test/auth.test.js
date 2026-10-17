const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COPILOT_AUTH_MODES,
  NOTE_ENV_NOT_CRYPTOGRAPHIC_ORIGIN,
  isOfflineStub,
  validateCopilotAuth
} = require('../lib/auth');

test('COPILOT_AUTH_MODES contains pat and actions', () => {
  assert.deepEqual(Array.from(COPILOT_AUTH_MODES), ['pat', 'actions']);
});

test('validateCopilotAuth rejects missing or empty token', () => {
  assert.throws(() => validateCopilotAuth({ token: '' }), /SQUAD_COPILOT_TOKEN is required/);
  assert.throws(() => validateCopilotAuth({ token: '   ' }), /SQUAD_COPILOT_TOKEN is required/);
  assert.throws(() => validateCopilotAuth({ token: null }), /SQUAD_COPILOT_TOKEN is required/);
});

test('validateCopilotAuth rejects unsupported auth mode', () => {
  assert.throws(
    () => validateCopilotAuth({ token: 'github_pat_valid', authMode: 'invalid' }),
    /Unsupported Copilot auth mode: invalid/
  );
});

test('validateCopilotAuth strictly rejects classic PAT (ghp_) across all modes', () => {
  for (const authMode of ['pat', 'actions']) {
    assert.throws(
      () => validateCopilotAuth({ token: 'ghp_classicToken1234567890', authMode, isLive: false, clientKind: 'fake' }),
      /Classic GitHub PAT \(ghp_\) is not supported/
    );
    assert.throws(
      () => validateCopilotAuth({ token: 'ghp_classicToken1234567890', authMode, isLive: true, clientKind: 'aca' }),
      /Classic GitHub PAT \(ghp_\) is not supported/
    );
  }
});

test('validateCopilotAuth accepts offline stubs in fake/offline mode', () => {
  const offlineTokens = [
    'offline-fake-token-not-a-credential',
    'offline-stub',
    'test-stub-token',
    'fake-test-token'
  ];
  for (const token of offlineTokens) {
    const res = validateCopilotAuth({ token, authMode: 'pat', isLive: false, clientKind: 'fake' });
    assert.equal(res.valid, true);
    assert.equal(res.tokenType, 'offline-stub');
  }
});

test('validateCopilotAuth rejects offline stubs in live mode', () => {
  assert.throws(
    () => validateCopilotAuth({ token: 'offline-fake-token-not-a-credential', authMode: 'pat', isLive: true, clientKind: 'aca' }),
    /SQUAD_COPILOT_TOKEN must be a fine-grained github_pat_ token/
  );
});

test('validateCopilotAuth handles pat mode', () => {
  const validPat = 'github_pat_11AEXAMPLE_TOKEN_VALUE_HERE';
  const res = validateCopilotAuth({ token: validPat, authMode: 'pat', isLive: true, clientKind: 'aca' });
  assert.equal(res.valid, true);
  assert.equal(res.authMode, 'pat');
  assert.equal(res.tokenType, 'fine-grained-pat');

  assert.throws(
    () => validateCopilotAuth({ token: 'ghs_actionsToken', authMode: 'pat', isLive: true, clientKind: 'aca' }),
    /SQUAD_COPILOT_TOKEN must be a fine-grained github_pat_ token/
  );
  assert.throws(
    () => validateCopilotAuth({ token: 'arbitrary_random_string', authMode: 'pat', isLive: true, clientKind: 'aca' }),
    /SQUAD_COPILOT_TOKEN must be a fine-grained github_pat_ token/
  );
});

test('validateCopilotAuth handles actions mode', () => {
  const validActions = 'opaque-workflow-token-1234567890';
  const workflowEnv = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'test-owner/test-repo',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main'
  };

  const res = validateCopilotAuth({
    token: validActions,
    authMode: 'actions',
    isLive: true,
    clientKind: 'aca',
    env: workflowEnv
  });
  assert.equal(res.valid, true);
  assert.equal(res.authMode, 'actions');
  assert.equal(res.tokenType, 'actions-token');
  assert.equal(res.note, NOTE_ENV_NOT_CRYPTOGRAPHIC_ORIGIN);

  // Actions mode is selected by trusted workflow context, not token-prefix guessing.
  assert.throws(
    () => validateCopilotAuth({ token: 'github_pat_abc123', authMode: 'actions', isLive: true, clientKind: 'aca', env: workflowEnv }),
    /Actions auth mode does not accept a stored fine-grained PAT/
  );
  assert.equal(validateCopilotAuth({
    token: 'ghs_sample_prefix_is_not_required',
    authMode: 'actions',
    isLive: true,
    clientKind: 'aca',
    env: workflowEnv
  }).valid, true);

  // Rejects when outside GitHub Actions workflow runtime
  assert.throws(
    () => validateCopilotAuth({ token: validActions, authMode: 'actions', isLive: true, clientKind: 'aca', env: {} }),
    /Actions auth mode is only allowed inside a GitHub Actions workflow runtime/
  );
  assert.throws(
    () => validateCopilotAuth({ token: validActions, authMode: 'actions', isLive: true, clientKind: 'aca', env: { GITHUB_ACTIONS: 'true' } }),
    /Actions auth mode requires GITHUB_REPOSITORY in workflow environment/
  );
  assert.throws(
    () => validateCopilotAuth({ token: validActions, authMode: 'actions', isLive: true, clientKind: 'aca', env: { ...workflowEnv, GITHUB_REF: 'refs/heads/feature' } }),
    /manual workflow_dispatch, opted-in issues event, or validated sandbox revise/
  );
  assert.throws(
    () => validateCopilotAuth({ token: validActions, authMode: 'actions', isLive: true, clientKind: 'aca', env: { ...workflowEnv, GITHUB_EVENT_NAME: 'pull_request' } }),
    /manual workflow_dispatch, opted-in issues event/
  );
  assert.throws(
    () => validateCopilotAuth({ token: validActions, authMode: 'actions', isLive: true, clientKind: 'aca', env: { ...workflowEnv, GITHUB_EVENT_NAME: 'issues' } }),
    /requires SQUAD_ISSUE_FLOW_OPT_IN=1/
  );
  assert.equal(validateCopilotAuth({
    token: validActions,
    authMode: 'actions',
    isLive: true,
    clientKind: 'aca',
    env: { ...workflowEnv, GITHUB_EVENT_NAME: 'issues', SQUAD_ISSUE_FLOW_OPT_IN: '1' }
  }).valid, true);
  assert.equal(validateCopilotAuth({
    token: validActions,
    authMode: 'actions',
    isLive: true,
    clientKind: 'aca',
    env: { ...workflowEnv, GITHUB_REPOSITORY: 'another-owner/another-repo' }
  }).valid, true);
});

test('OIDC subject construction for GitHub Actions enforces immutable IDs and environment', () => {
  // Entra OIDC federated identity credential requires immutable numeric IDs in GitHub Actions subjects:
  // repo:<owner>@<owner_id>/<repo>@<repo_id>:environment:<env>
  const owner = 'test-owner';
  const ownerId = 101;
  const repo = 'test-repo';
  const repoId = 202;
  const envName = 'test-environment';

  function formatActionsOidcSubject({ owner, ownerId, repo, repoId, environment }) {
    if (!owner || !ownerId || !repo || !repoId || !environment) {
      throw new Error('All OIDC subject components (owner, ownerId, repo, repoId, environment) are required.');
    }
    if (typeof ownerId !== 'number' || typeof repoId !== 'number') {
      throw new Error('ownerId and repoId must be numeric IDs.');
    }
    return `repo:${owner}@${ownerId}/${repo}@${repoId}:environment:${environment}`;
  }

  const expectedSubject = 'repo:test-owner@101/test-repo@202:environment:test-environment';
  const actualSubject = formatActionsOidcSubject({ owner, ownerId, repo, repoId, environment: envName });
  assert.equal(actualSubject, expectedSubject);

  // Rejects missing immutable IDs (legacy subject fallback prohibited)
  assert.throws(
    () => formatActionsOidcSubject({ owner, ownerId: null, repo, repoId, environment: envName }),
    /All OIDC subject components/
  );
  assert.throws(
    () => formatActionsOidcSubject({ owner, ownerId, repo, repoId: null, environment: envName }),
    /All OIDC subject components/
  );
  // Rejects non-numeric IDs
  assert.throws(
    () => formatActionsOidcSubject({ owner, ownerId: '40404', repo, repoId, environment: envName }),
    /must be numeric IDs/
  );
  // Validates case sensitivity and environment name match
  assert.notEqual(
    actualSubject,
    `repo:${owner}@${ownerId}/${repo}@${repoId}:environment:${envName.toUpperCase()}`
  );
  assert.notEqual(
    actualSubject,
    `repo:${owner}/${repo}:environment:${envName}`
  );
});
