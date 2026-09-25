#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_PROVIDERS_ACA_JOB_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_PROVIDERS_ACA_JOB_SH=1

run_aca_job_provider() {
  export ISSUE_NUMBER AGENT_TYPE GITHUB_REPO

  log "=== Squad Agent: ${AGENT_TYPE} (mode: ${MSG_TYPE}) ==="
  log "Repository: ${GITHUB_REPO}"
  log "Issue:      #${ISSUE_NUMBER}"
  if [[ "${MSG_TYPE}" == "revise" ]]; then
    log "PR:         #${PR_NUMBER}"
    log "Branch:     ${REVISION_BRANCH}"
    log "Head SHA:   ${HEAD_SHA}"
  fi

  generate_github_app_installation_token
  retrieve_copilot_token
  authenticate_github_cli
  ensure_squad_lifecycle_labels

  # ==========================================================================
  # MSG_TYPE dispatch — "revise" vs "new" (default)
  # ==========================================================================

  if [[ "${MSG_TYPE}" == "revise" ]]; then
    handle_revision_flow
  else
    handle_new_issue_flow
  fi
}
