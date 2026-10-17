const COPILOT_AUTH_MODES = Object.freeze(['pat', 'actions']);

const NOTE_ENV_NOT_CRYPTOGRAPHIC_ORIGIN =
  'Workflow environment variables confirm job-scoped runtime context but are not cryptographic proof of origin. Token permissions must be validated live at runtime.';

function isOfflineStub(token) {
  if (typeof token !== 'string') return false;
  return token === 'offline-fake-token-not-a-credential' ||
    token.startsWith('offline-') ||
    token.startsWith('test-') ||
    token.startsWith('fake-');
}

function validateCopilotAuth({ token, authMode = 'pat', isLive = false, clientKind = 'fake', env = process.env }) {
  if (typeof authMode !== 'string' || !COPILOT_AUTH_MODES.includes(authMode)) {
    throw new Error(`Unsupported Copilot auth mode: ${authMode}. Supported modes are: ${COPILOT_AUTH_MODES.join(', ')}.`);
  }

  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('SQUAD_COPILOT_TOKEN is required.');
  }

  const trimmedToken = token.trim();

  if (trimmedToken.startsWith('ghp_')) {
    throw new Error('Classic GitHub PAT (ghp_) is not supported for ACA Sandbox Copilot integration.');
  }

  if (!isLive && clientKind === 'fake' && isOfflineStub(trimmedToken)) {
    return {
      valid: true,
      authMode,
      tokenType: 'offline-stub',
      note: 'Offline stub accepted for offline/fake execution.'
    };
  }

  if (authMode === 'pat') {
    if (!trimmedToken.startsWith('github_pat_')) {
      throw new Error('SQUAD_COPILOT_TOKEN must be a fine-grained github_pat_ token when using PAT auth mode.');
    }
    return {
      valid: true,
      authMode: 'pat',
      tokenType: 'fine-grained-pat'
    };
  }

  if (authMode === 'actions') {
    if (trimmedToken.startsWith('github_pat_')) {
      throw new Error('Actions auth mode does not accept a stored fine-grained PAT; pass the current workflow token.');
    }

    if (isLive || clientKind !== 'fake') {
      if (env.GITHUB_ACTIONS !== 'true') {
        throw new Error('Actions auth mode is only allowed inside a GitHub Actions workflow runtime (GITHUB_ACTIONS=true).');
      }
      if (!env.GITHUB_REPOSITORY || typeof env.GITHUB_REPOSITORY !== 'string') {
        throw new Error('Actions auth mode requires GITHUB_REPOSITORY in workflow environment.');
      }
      if (!['workflow_dispatch', 'issues', 'issue_comment'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_REF !== 'refs/heads/main') {
        throw new Error('Actions auth mode requires a manual workflow_dispatch, opted-in issues event, or validated sandbox revise on the main branch.');
      }
      if (env.GITHUB_EVENT_NAME === 'issue_comment') {
        require('../../scripts/issue-revise.cjs').validateActionsRevise(env);
      }
      if (['issues', 'issue_comment'].includes(env.GITHUB_EVENT_NAME) && env.SQUAD_ISSUE_FLOW_OPT_IN !== '1') {
        throw new Error('Actions auth mode for issue events requires SQUAD_ISSUE_FLOW_OPT_IN=1.');
      }
    }

    return {
      valid: true,
      authMode: 'actions',
      tokenType: 'actions-token',
      note: NOTE_ENV_NOT_CRYPTOGRAPHIC_ORIGIN
    };
  }

  throw new Error(`Unexpected Copilot auth mode: ${authMode}`);
}

module.exports = {
  COPILOT_AUTH_MODES,
  NOTE_ENV_NOT_CRYPTOGRAPHIC_ORIGIN,
  isOfflineStub,
  validateCopilotAuth
};
