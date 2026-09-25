#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_FLOWS_REVISION_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_FLOWS_REVISION_SH=1

handle_revision_flow() {
  # =========================================================================
  # REVISION FLOW — address reviewer feedback on an existing bot-owned PR
  # =========================================================================
  [[ -z "${PR_NUMBER}" ]] && die "pr_number is missing in revision message."
  [[ -z "${REVISION_BRANCH}" ]] && die "branch is missing in revision message."
  [[ -z "${HEAD_SHA}" ]] && die "head_sha is missing in revision message."

  # -- Git identity -----------------------------------------------------------
  configure_git_identity

  # -- Clone and checkout existing branch -------------------------------------
  log "Cloning ${GITHUB_REPO} and checking out ${REVISION_BRANCH}..."
  clone_repository "${GITHUB_REPO}" /workspace/repo
  cd /workspace/repo
  checkout_branch "${REVISION_BRANCH}"

  # -- Stale check: verify HEAD matches enqueued SHA --------------------------
  CURRENT_SHA=$(git rev-parse HEAD)
  if [[ "${CURRENT_SHA}" != "${HEAD_SHA}" ]]; then
    log "Branch has moved since revision was requested (expected ${HEAD_SHA}, got ${CURRENT_SHA})."
    gh pr comment "${PR_NUMBER}" --repo "${GITHUB_REPO}" \
      --body "⚠️ Branch has changed since revision was requested (expected \`${HEAD_SHA:0:7}\`, found \`${CURRENT_SHA:0:7}\`). Please re-trigger \`/squad revise\`."
    # Remove revising label so it can be re-triggered
    gh pr edit "${PR_NUMBER}" --repo "${GITHUB_REPO}" --remove-label "squad:revising" 2>/dev/null || true
    exit 0
  fi

  # -- Collect rich feedback for the prompt -----------------------------------
  log "Collecting review feedback for PR #${PR_NUMBER}..."

  # Review-level comments (approvals, change requests, general comments)
  REVIEW_COMMENTS=$(gh pr view "${PR_NUMBER}" --repo "${GITHUB_REPO}" \
    --json reviews,comments \
    --jq '{reviews: [.reviews[] | {author: .author.login, state: .state, body: .body}], comments: [.comments[] | {author: .author.login, body: .body}]}' \
    2>/dev/null || echo '{}')

  # Inline code review comments (file/line specific)
  INLINE_COMMENTS=$(gh api "repos/${GITHUB_REPO}/pulls/${PR_NUMBER}/comments" \
    --jq '[.[] | select(.position != null or .line != null) | {path: .path, line: (.line // .position), body: .body}]' \
    2>/dev/null || echo '[]')

  # Current diff for context (capped at 500 lines)
  PR_DIFF=$(gh pr diff "${PR_NUMBER}" --repo "${GITHUB_REPO}" 2>/dev/null | head -500 || echo "No diff available.")

  # -- Build revision prompt --------------------------------------------------
  SQUAD_PROMPT="@${AGENT_TYPE}, address reviewer feedback on PR #${PR_NUMBER} (issue #${ISSUE_NUMBER}).

## Reviewer Feedback
${FEEDBACK}

## Review Comments
${REVIEW_COMMENTS}

## Inline Review Comments
${INLINE_COMMENTS}

## Current PR Diff (for context)
\`\`\`diff
${PR_DIFF}
\`\`\`

Make targeted changes to address the feedback. Don't rewrite code that wasn't mentioned.
Stage and commit changes with a descriptive message referencing PR #${PR_NUMBER}."

  # -- Run Copilot CLI --------------------------------------------------------
  log "Running Copilot CLI for revision of PR #${PR_NUMBER}..."

  run_copilot_yolo "${SQUAD_PROMPT}"

  if [[ "${COPILOT_EXIT}" -eq 0 ]]; then
    log "Copilot CLI completed revision successfully."
  else
    log "WARNING: Copilot CLI failed during revision (exit code ${COPILOT_EXIT})."
  fi

  # Stage any uncommitted changes
  if [[ -n "$(git status --porcelain)" ]]; then
    log "Staging uncommitted changes from revision..."
    git add -A
    git commit -m "squad(${AGENT_TYPE}): revise PR #${PR_NUMBER} per reviewer feedback

Automated revision by Squad agent pipeline.
Issue: #${ISSUE_NUMBER}" || log "Nothing new to commit."
  fi

  # -- Commit .squad/ state changes -------------------------------------------
  commit_squad_state_changes_for_revision

  # -- Push (add commits, no force-push) --------------------------------------
  log "Pushing revision commits to ${REVISION_BRANCH}..."
  git push origin "${REVISION_BRANCH}" || die "git push failed."

  # -- Comment on PR with results ---------------------------------------------
  AGENT_SUMMARY=""
  if [[ -f /workspace/copilot-output.log ]]; then
    AGENT_SUMMARY=$(tail -50 /workspace/copilot-output.log 2>/dev/null \
      | sed 's/\x1b\[[0-9;]*m//g' \
      | grep -v '^\s*$' \
      | grep -v '^●' \
      | grep -v '^\s*└' \
      | grep -v '^Changes\s\+[+-]' \
      | grep -v '^Requests\s' \
      | grep -v '^Tokens\s' \
      | grep -v '^Duration\s' \
      | grep -v '^\s*Running\s*$' \
      | grep -v '^\s*Completed\s*$' \
      | grep -v '^\s*│' \
      | grep -v '/workspace/' \
      | grep -v '^\s*cat ' \
      | grep -v '^\s*ls ' \
      | grep -v '^\s*cd ' \
      | grep -v '^\s*find ' \
      | grep -v '^\s*git config' \
      | grep -v '^\s*git rev-parse' \
      | grep -v '2>/dev/null' \
      | grep -v '\.squad/agents/.*/charter\.md' \
      | grep -v '\.squad/agents/.*/history\.md' \
      | grep -v '\.squad/decisions\.md' \
      | grep -v '\.squad/routing\.md' \
      | grep -v '\.squad/team\.md' \
      | grep -v '\.squad/casting/' \
      | grep -v 'Read.*charter.*shell' \
      | grep -v 'Read.*history.*shell' \
      | grep -v '(shell)$' \
      | grep -v '^Agent started in background' \
      | grep -v '^General-purpose' \
      | grep -v '<system_notification>' \
      | grep -v '</system_notification>' \
      | grep -v 'read_agent' \
      | grep -v 'Background agent.*completed' \
      | tail -10 \
      || true)
  fi

  # Show diff stats for ALL revision commits (not just the last one)
  DIFF_STATS=$(git diff --stat "origin/main..HEAD" 2>/dev/null | grep -v '\.squad/' || echo "No diff stats available.")
  COMMIT_LOG=$(git log "origin/main..HEAD" --oneline 2>/dev/null | head -10 || echo "")

  gh pr comment "${PR_NUMBER}" --repo "${GITHUB_REPO}" \
    --body "🔧 **Revision applied** by \`${AGENT_TYPE}\`

${AGENT_SUMMARY:-"Revision completed — check the updated diff for changes."}

### Changes
\`\`\`
${DIFF_STATS}
\`\`\`

### Commits
\`\`\`
${COMMIT_LOG}
\`\`\`"

  # -- Remove squad:revising label --------------------------------------------
  log "Removing squad:revising label from PR #${PR_NUMBER}..."
  gh pr edit "${PR_NUMBER}" --repo "${GITHUB_REPO}" --remove-label "squad:revising" 2>/dev/null || true

  log "=== Agent ${AGENT_TYPE} completed revision of PR #${PR_NUMBER} ==="
}
