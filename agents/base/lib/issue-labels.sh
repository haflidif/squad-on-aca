#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_ISSUE_LABELS_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_ISSUE_LABELS_SH=1

ensure_squad_lifecycle_labels() {
  log "Ensuring squad lifecycle labels exist on ${GITHUB_REPO}..."
  gh label create "squad:processing" --repo "${GITHUB_REPO}" --color "FBCA04" --description "Squad agent is actively working on this issue" --force 2>/dev/null || true
  gh label create "squad:queued" --repo "${GITHUB_REPO}" --color "0E8A16" --description "Squad agent created a PR — awaiting review" --force 2>/dev/null || true
  gh label create "squad:revising" --repo "${GITHUB_REPO}" --color "D93F0B" --description "Squad agent is revising this PR based on reviewer feedback" --force 2>/dev/null || true
}
