#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_FLOWS_NEW_ISSUE_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_FLOWS_NEW_ISSUE_SH=1

handle_new_issue_flow() {
  # =========================================================================
  # NEW ISSUE FLOW — existing behavior, unchanged
  # =========================================================================

  # -- Dedup checks (prevent multiple containers working the same issue) -------
  log "Checking squad:processing label on issue #${ISSUE_NUMBER}..."
  ISSUE_LABELS=$(gh issue view "${ISSUE_NUMBER}" --repo "${GITHUB_REPO}" --json labels --jq '[.labels[].name] | join("\n")' 2>/dev/null || true)

  if echo "${ISSUE_LABELS}" | grep -q "^squad:queued$"; then
    log "Issue #${ISSUE_NUMBER} already has squad:queued label (PR was created). Skipping."
    exit 0
  fi

  if ! echo "${ISSUE_LABELS}" | grep -q "^squad:processing$"; then
    log "Issue #${ISSUE_NUMBER} is missing squad:processing label — already handled. Skipping."
    exit 0
  fi

  log "Checking for existing PRs for issue #${ISSUE_NUMBER}..."
  EXISTING_PR=$(gh pr list --repo "${GITHUB_REPO}" --state open \
    --json number,headRefName \
    --jq "[.[] | select(.headRefName | test(\"squad/.*/issue-${ISSUE_NUMBER}$\"))] | .[0].number // empty" \
    2>/dev/null || true)

  if [[ -n "${EXISTING_PR}" ]]; then
    log "PR #${EXISTING_PR} already exists for issue #${ISSUE_NUMBER}. Skipping."
    gh issue edit "${ISSUE_NUMBER}" --repo "${GITHUB_REPO}" \
      --remove-label "squad:processing" --add-label "squad:queued" 2>/dev/null || true
    exit 0
  fi

  log "Checking for existing squad branches for issue #${ISSUE_NUMBER}..."
  EXISTING_BRANCH=$(git ls-remote --heads "https://github.com/${GITHUB_REPO}.git" "squad/*/issue-${ISSUE_NUMBER}" 2>/dev/null | head -1 || true)
  if [[ -n "${EXISTING_BRANCH}" ]]; then
    log "Branch already exists for issue #${ISSUE_NUMBER}. Skipping."
    exit 0
  fi

  log "Confirming squad:processing label on issue #${ISSUE_NUMBER}..."
  gh issue edit "${ISSUE_NUMBER}" --repo "${GITHUB_REPO}" --add-label "squad:processing" 2>/dev/null || log "WARNING: Could not add squad:processing label."

  # -- Git identity (needed for commits) --------------------------------------
  configure_git_identity

  # -- Clone repo --------------------------------------------------------------
  log "Cloning ${GITHUB_REPO}..."
  clone_repository "${GITHUB_REPO}" /workspace/repo
  cd /workspace/repo

  # -- Create working branch ---------------------------------------------------
  BRANCH="squad/${AGENT_TYPE}/issue-${ISSUE_NUMBER}"
  log "Creating branch: ${BRANCH}"
  create_branch "${BRANCH}"

  # -- Read issue details -------------------------------------------------------
  log "Fetching issue #${ISSUE_NUMBER} from ${GITHUB_REPO}..."
  ISSUE_JSON=$(gh issue view "${ISSUE_NUMBER}" --repo "${GITHUB_REPO}" --json title,body,labels,assignees 2>/dev/null) \
    || die "Failed to fetch issue #${ISSUE_NUMBER}."

  ISSUE_TITLE=$(echo "${ISSUE_JSON}" | jq -r '.title // "Untitled"')
  ISSUE_BODY=$(echo "${ISSUE_JSON}" | jq -r '.body // "No description provided."')
  ISSUE_LABELS=$(echo "${ISSUE_JSON}" | jq -r '[.labels[].name] | join(", ") // "none"')

  log "Issue title: ${ISSUE_TITLE}"

  # -- Do the work (Copilot CLI) -----------------------------------------------
  COPILOT_SUCCEEDED=false

  log "Running Copilot CLI for issue #${ISSUE_NUMBER}..."

  SQUAD_PROMPT="@${AGENT_TYPE}, resolve issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

${ISSUE_BODY}

Make all necessary code changes to resolve this issue. After making changes, stage and commit them with a descriptive commit message referencing issue #${ISSUE_NUMBER}."

  run_copilot_yolo "${SQUAD_PROMPT}"

  if [[ "${COPILOT_EXIT}" -eq 0 ]]; then
    log "Copilot CLI completed successfully."
    COPILOT_SUCCEEDED=true
  else
    log "WARNING: Copilot CLI failed (exit code ${COPILOT_EXIT}). Falling back to work artifact."
  fi

  if [[ "${COPILOT_SUCCEEDED}" == "true" ]]; then
    if [[ -n "$(git status --porcelain)" ]]; then
      log "Copilot left uncommitted changes — committing them now."
      git add -A
      git commit -m "squad(${AGENT_TYPE}): copilot changes for issue #${ISSUE_NUMBER}

Automated by Squad agent pipeline (Copilot CLI --yolo).
Issue: ${ISSUE_TITLE}" || log "Nothing new to commit (copilot may have committed already)."
    fi

    if git log origin/main..HEAD --oneline | grep -q .; then
      log "Copilot produced commits for issue #${ISSUE_NUMBER}."
    else
      log "WARNING: Copilot ran but produced no commits. Falling back to work artifact."
      COPILOT_SUCCEEDED=false
    fi
  fi

  # -- Fallback: work artifact if copilot didn't produce changes ---------------
  if [[ "${COPILOT_SUCCEEDED}" != "true" ]]; then
    log "Creating fallback work artifact for issue #${ISSUE_NUMBER}..."

    COPILOT_LOG=""
    if [[ -f /workspace/copilot-output.log ]]; then
      COPILOT_LOG=$(tail -50 /workspace/copilot-output.log 2>/dev/null || true)
    fi

    WORK_DIR=".squad-work"
    mkdir -p "${WORK_DIR}"

    cat > "${WORK_DIR}/issue-${ISSUE_NUMBER}.md" <<EOF
# Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

**Agent:** ${AGENT_TYPE}
**Labels:** ${ISSUE_LABELS}
**Processed:** $(date -u '+%Y-%m-%dT%H:%M:%SZ')

## Issue Description

${ISSUE_BODY}

## Status

Copilot CLI was unable to produce code changes for this issue.
A work artifact has been created instead so the PR captures context.

### Copilot Output (last 50 lines)

\`\`\`
${COPILOT_LOG:-"No output captured."}
\`\`\`

## Next Steps

- Review the issue description and implement manually
- Or re-trigger the agent after resolving any Copilot CLI issues
EOF

    git add "${WORK_DIR}/"
    git commit -m "squad(${AGENT_TYPE}): work artifact for issue #${ISSUE_NUMBER}

Copilot CLI fallback — see .squad-work/ for details.
Issue: ${ISSUE_TITLE}" || die "git commit failed (nothing to commit?)."
  fi

  # -- Commit .squad/ state changes (decisions, history) -----------------------
  commit_squad_state_changes_for_issue

  # -- Push and open PR --------------------------------------------------------
  log "Pushing branch and creating PR..."
  git push origin "${BRANCH}" || die "git push failed."

  # -- Build enriched PR body with agent context --------------------------------
  log "Building PR body with agent context..."

  COPILOT_STATUS=$(if [[ "${COPILOT_SUCCEEDED}" == "true" ]]; then echo "✅"; else echo "⚠️ fallback"; fi)

  if [[ "${COPILOT_SUCCEEDED}" == "true" ]]; then
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
        | tail -15 \
        || true)
    fi

    DIFF_STATS=$(git diff --stat origin/main..HEAD 2>/dev/null || echo "No diff stats available.")
    COMMIT_LOG=$(git log origin/main..HEAD --oneline 2>/dev/null || echo "No commits found.")

    DECISIONS=""
    DECISIONS_DIR=".squad/decisions/inbox"
    if [[ -d "${DECISIONS_DIR}" ]] && ls "${DECISIONS_DIR}"/*.md 1>/dev/null 2>&1; then
      DECISIONS=$(cat "${DECISIONS_DIR}"/*.md 2>/dev/null || true)
    fi

    PR_BODY="## Squad Agent: \`${AGENT_TYPE}\` — Issue #${ISSUE_NUMBER}

### Agent Activity

${AGENT_SUMMARY:-"No summary captured from copilot output."}

### Changes Made

\`\`\`
${DIFF_STATS}
\`\`\`

### Commits

\`\`\`
${COMMIT_LOG}
\`\`\`

### Decisions

${DECISIONS:-"No team decisions recorded."}

### Pipeline Status
| Step | Status |
|------|--------|
| Queue dequeue (MI auth) | ✅ |
| Issue fetch | ✅ |
| Clone + branch | ✅ |
| Copilot CLI (--agent squad) | ${COPILOT_STATUS} |
| Push + PR | ✅ |

Closes #${ISSUE_NUMBER}"

  else
    PR_BODY="## Squad Agent: \`${AGENT_TYPE}\` — Issue #${ISSUE_NUMBER}

### Note

Copilot CLI did not produce code changes. A fallback work artifact was committed instead.
Check \`.squad-work/issue-${ISSUE_NUMBER}.md\` for details and copilot output.

### Pipeline Status
| Step | Status |
|------|--------|
| Queue dequeue (MI auth) | ✅ |
| Issue fetch | ✅ |
| Clone + branch | ✅ |
| Copilot CLI (--agent squad) | ${COPILOT_STATUS} |
| Push + PR | ✅ |

Closes #${ISSUE_NUMBER}"
  fi

  # Truncate PR body to stay under GitHub's ~65KB limit (keep ~60KB to be safe)
  if [[ ${#PR_BODY} -gt 61440 ]]; then
    log "WARNING: PR body exceeds 60KB — truncating."
    PR_BODY="${PR_BODY:0:61000}

...

> ⚠️ PR body was truncated (original was ${#PR_BODY} bytes). Check copilot output log for full context."
  fi

  gh pr create \
    --title "squad(${AGENT_TYPE}): resolve issue #${ISSUE_NUMBER}" \
    --body "${PR_BODY}" \
    --base main \
    --head "${BRANCH}" \
    || die "gh pr create failed."

  # -- Update issue labels (processing → queued) -------------------------------
  log "Swapping labels on issue #${ISSUE_NUMBER} (processing → queued)..."
  gh issue edit "${ISSUE_NUMBER}" --repo "${GITHUB_REPO}" \
    --add-label "squad:queued" 2>/dev/null \
    || log "WARNING: Could not add squad:queued label on issue #${ISSUE_NUMBER}."
  gh issue edit "${ISSUE_NUMBER}" --repo "${GITHUB_REPO}" \
    --remove-label "squad:processing" 2>/dev/null \
    || log "WARNING: Could not remove squad:processing label on issue #${ISSUE_NUMBER}."

  log "=== Agent ${AGENT_TYPE} completed issue #${ISSUE_NUMBER} ==="
}
