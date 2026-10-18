#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_PUBLICATION_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_PUBLICATION_SH=1

commit_squad_state_changes_for_revision() {
  SQUAD_CHANGES=$(git diff --name-only -- .squad/ 2>/dev/null || true)
  SQUAD_UNTRACKED=$(git ls-files --others --exclude-standard -- .squad/ 2>/dev/null || true)

  if [[ -n "${SQUAD_CHANGES}" || -n "${SQUAD_UNTRACKED}" ]]; then
    log "Found .squad/ state changes — committing..."
    git add .squad/
    git commit -m "squad(${AGENT_TYPE}): update team state for PR #${PR_NUMBER} revision" || log "Nothing new to commit in .squad/."
  fi
}

commit_squad_state_changes_for_issue() {
  log "Checking for .squad/ state changes..."
  SQUAD_CHANGES=$(git diff --name-only -- .squad/ 2>/dev/null || true)
  SQUAD_UNTRACKED=$(git ls-files --others --exclude-standard -- .squad/ 2>/dev/null || true)

  if [[ -n "${SQUAD_CHANGES}" || -n "${SQUAD_UNTRACKED}" ]]; then
    log "Found .squad/ state changes — committing..."
    git add .squad/
    git commit -m "squad(${AGENT_TYPE}): update team state for issue #${ISSUE_NUMBER}

Updated decisions and learnings from agent work.
" || log "Nothing new to commit in .squad/."
  else
    log "No .squad/ state changes to commit."
  fi
}
