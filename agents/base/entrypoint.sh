#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Squad Agent Entrypoint
# Runs inside Azure Container App Jobs triggered by KEDA / Storage Queue.
#
# The container dequeues a message from Azure Storage Queue using Managed
# Identity (--auth-mode login). The message is base64-encoded JSON:
#   { "issue_number": 42, "agent_type": "backend", "repo": "owner/repo" }
#
# Required env vars:
#   AZURE_STORAGE_ACCOUNT      - storage account name (e.g. stsquadacaa6b49feb)
#   QUEUE_NAME                 - queue name (e.g. squad-work-queue)
#   GITHUB_APP_ID              - GitHub App numeric ID
#   GITHUB_APP_INSTALLATION_ID - GitHub App installation ID
#   KEY_VAULT_NAME             - Azure Key Vault name storing the App private key
#   KEY_VAULT_SECRET_NAME      - Key Vault secret name for the PEM
#   COPILOT_TOKEN_SECRET_NAME  - Key Vault secret name for the Copilot-licensed PAT
# ---------------------------------------------------------------------------

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die() { log "FATAL: $*"; exit 1; }

# -- Validate required env vars ---------------------------------------------
[[ -z "${AZURE_STORAGE_ACCOUNT:-}" ]] && die "AZURE_STORAGE_ACCOUNT is not set."
[[ -z "${QUEUE_NAME:-}" ]] && die "QUEUE_NAME is not set."
[[ -z "${GITHUB_APP_ID:-}" ]] && die "GITHUB_APP_ID is not set."
[[ -z "${GITHUB_APP_INSTALLATION_ID:-}" ]] && die "GITHUB_APP_INSTALLATION_ID is not set."
[[ -z "${KEY_VAULT_NAME:-}" ]] && die "KEY_VAULT_NAME is not set."
[[ -z "${KEY_VAULT_SECRET_NAME:-}" ]] && die "KEY_VAULT_SECRET_NAME is not set."
[[ -z "${COPILOT_TOKEN_SECRET_NAME:-}" ]] && die "COPILOT_TOKEN_SECRET_NAME is not set."

# -- Authenticate with Azure using Managed Identity -------------------------
log "Logging in with Managed Identity..."
if [[ -n "${AZURE_CLIENT_ID:-}" ]]; then
  az login --identity --client-id "${AZURE_CLIENT_ID}" --allow-no-subscriptions -o none || die "az login --identity failed."
else
  az login --identity --allow-no-subscriptions -o none || die "az login --identity failed."
fi

# -- Dequeue one message from Azure Storage Queue ----------------------------
log "Dequeuing message from queue '${QUEUE_NAME}' (account: ${AZURE_STORAGE_ACCOUNT})..."

RAW_MSG=$(az storage message get --queue-name "${QUEUE_NAME}" --account-name "${AZURE_STORAGE_ACCOUNT}" --auth-mode login --num-messages 1 -o json 2>/dev/null) || die "az storage message get failed."

# KEDA may trigger the job after the queue drains - exit cleanly if empty.
if [[ -z "${RAW_MSG}" || "${RAW_MSG}" == "[]" || "${RAW_MSG}" == "null" ]]; then
  log "No messages in queue. Exiting cleanly."
  exit 0
fi

# Extract fields needed to delete the message and the content (base64-encoded).
MSG_ID=$(echo "${RAW_MSG}" | jq -r '.[0].id // empty')
POP_RECEIPT=$(echo "${RAW_MSG}" | jq -r '.[0].popReceipt // empty')
MSG_BODY_B64=$(echo "${RAW_MSG}" | jq -r '.[0].content // empty')

[[ -z "${MSG_ID}" || -z "${POP_RECEIPT}" ]] && die "Dequeued message is missing id or popReceipt."
[[ -z "${MSG_BODY_B64}" ]] && die "Dequeued message has no content."

# -- Decode and parse the message --------------------------------------------
QUEUE_MESSAGE=$(echo "${MSG_BODY_B64}" | base64 -d 2>&1) || die "Failed to base64-decode message content: ${QUEUE_MESSAGE}"

MSG_TYPE=$(echo "${QUEUE_MESSAGE}" | jq -r '.type // "new"')
ISSUE_NUMBER=$(echo "${QUEUE_MESSAGE}" | jq -r '.issue_number // empty')
AGENT_TYPE=$(echo "${QUEUE_MESSAGE}" | jq -r '.agent_type // empty')
GITHUB_REPO=$(echo "${QUEUE_MESSAGE}" | jq -r '.repo // empty')

[[ -z "${ISSUE_NUMBER}" ]] && die "issue_number is missing in message."
[[ -z "${AGENT_TYPE}" ]] && die "agent_type is missing in message."
[[ -z "${GITHUB_REPO}" ]] && die "repo is missing in message."

# Revision-specific fields (only present when MSG_TYPE == "revise")
PR_NUMBER=$(echo "${QUEUE_MESSAGE}" | jq -r '.pr_number // empty')
REVISION_BRANCH=$(echo "${QUEUE_MESSAGE}" | jq -r '.branch // empty')
HEAD_SHA=$(echo "${QUEUE_MESSAGE}" | jq -r '.head_sha // empty')
FEEDBACK=$(echo "${QUEUE_MESSAGE}" | jq -r '.feedback // empty')

# -- Delete message from queue (prevent reprocessing) ------------------------
log "Deleting message ${MSG_ID} from queue..."
az storage message delete --queue-name "${QUEUE_NAME}" --account-name "${AZURE_STORAGE_ACCOUNT}" --auth-mode login --id "${MSG_ID}" --pop-receipt "${POP_RECEIPT}" -o none || die "Failed to delete message ${MSG_ID} from queue."

export ISSUE_NUMBER AGENT_TYPE GITHUB_REPO

log "=== Squad Agent: ${AGENT_TYPE} (mode: ${MSG_TYPE}) ==="
log "Repository: ${GITHUB_REPO}"
log "Issue:      #${ISSUE_NUMBER}"
if [[ "${MSG_TYPE}" == "revise" ]]; then
  log "PR:         #${PR_NUMBER}"
  log "Branch:     ${REVISION_BRANCH}"
  log "Head SHA:   ${HEAD_SHA}"
fi

# -- GitHub App Authentication (JWT → Installation Token) -----------------
log "Generating GitHub App installation token..."

# Retrieve private key from Azure Key Vault (never written to disk)
PEM=$(az keyvault secret show \
  --vault-name "${KEY_VAULT_NAME}" \
  --name "${KEY_VAULT_SECRET_NAME}" \
  --query value -o tsv 2>/dev/null) || die "Failed to retrieve private key from Key Vault."

[[ -z "${PEM}" ]] && die "Private key from Key Vault is empty."

# Generate JWT (valid for 10 minutes)
NOW=$(date +%s)
EXPIRES=$((NOW + 600))

HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
PAYLOAD=$(echo -n "{\"iat\":${NOW},\"exp\":${EXPIRES},\"iss\":\"${GITHUB_APP_ID}\"}" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
SIGNATURE=$(echo -n "${HEADER}.${PAYLOAD}" | openssl dgst -sha256 -sign <(echo "${PEM}") | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')

JWT="${HEADER}.${PAYLOAD}.${SIGNATURE}"

# Exchange JWT for installation access token (1hr expiry)
TOKEN_RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer ${JWT}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens") \
  || die "Failed to exchange JWT for installation token."

GITHUB_TOKEN=$(echo "${TOKEN_RESPONSE}" | jq -r '.token // empty')
[[ -z "${GITHUB_TOKEN}" ]] && die "Installation token is empty. Response: ${TOKEN_RESPONSE}"

export GITHUB_TOKEN
log "GitHub App installation token generated successfully (expires in 1hr)."

# Save the App token — git/gh operations always use this
APP_TOKEN="${GITHUB_TOKEN}"

# -- Retrieve Copilot PAT from Key Vault ------------------------------------
# GitHub Apps can't hold Copilot licenses. A Copilot-licensed user PAT is
# required exclusively for the `copilot --yolo` invocation.
log "Retrieving Copilot token from Key Vault..."
COPILOT_TOKEN=$(az keyvault secret show \
  --vault-name "${KEY_VAULT_NAME}" \
  --name "${COPILOT_TOKEN_SECRET_NAME}" \
  --query value -o tsv 2>/dev/null) || die "Failed to retrieve Copilot token from Key Vault."

[[ -z "${COPILOT_TOKEN}" ]] && die "Copilot token from Key Vault is empty."
log "Copilot token retrieved successfully."

# -- GitHub auth -------------------------------------------------------------
log "Authenticating with GitHub..."
gh auth status 2>/dev/null || die "gh auth failed. Check installation token."

# Configure gh as the git credential helper so git push uses the token
gh auth setup-git 2>/dev/null

# -- Ensure required labels exist on the target repo -------------------------
# Labels are created by the workflow template, but repos may not have them yet.
# This is a defensive check — gh label create --force is idempotent.
log "Ensuring squad lifecycle labels exist on ${GITHUB_REPO}..."
gh label create "squad:processing" --repo "${GITHUB_REPO}" --color "FBCA04" --description "Squad agent is actively working on this issue" --force 2>/dev/null || true
gh label create "squad:queued" --repo "${GITHUB_REPO}" --color "0E8A16" --description "Squad agent created a PR — awaiting review" --force 2>/dev/null || true
gh label create "squad:revising" --repo "${GITHUB_REPO}" --color "D93F0B" --description "Squad agent is revising this PR based on reviewer feedback" --force 2>/dev/null || true

# ===========================================================================
# MSG_TYPE dispatch — "revise" vs "new" (default)
# ===========================================================================

if [[ "${MSG_TYPE}" == "revise" ]]; then
  # =========================================================================
  # REVISION FLOW — address reviewer feedback on an existing bot-owned PR
  # =========================================================================
  [[ -z "${PR_NUMBER}" ]] && die "pr_number is missing in revision message."
  [[ -z "${REVISION_BRANCH}" ]] && die "branch is missing in revision message."
  [[ -z "${HEAD_SHA}" ]] && die "head_sha is missing in revision message."

  # -- Git identity -----------------------------------------------------------
  git config --global user.name "squad-aca-bot[bot]"
  git config --global user.email "3362344+squad-aca-bot[bot]@users.noreply.github.com"

  # -- Clone and checkout existing branch -------------------------------------
  log "Cloning ${GITHUB_REPO} and checking out ${REVISION_BRANCH}..."
  gh repo clone "${GITHUB_REPO}" /workspace/repo || die "Failed to clone ${GITHUB_REPO}."
  cd /workspace/repo
  git checkout "${REVISION_BRANCH}" || die "Failed to checkout branch ${REVISION_BRANCH}."

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

  set +e
  export GITHUB_TOKEN="${COPILOT_TOKEN}"
  echo "${SQUAD_PROMPT}" | copilot --yolo --agent squad 2>&1 | tee /workspace/copilot-output.log
  COPILOT_EXIT=${PIPESTATUS[1]}
  export GITHUB_TOKEN="${APP_TOKEN}"
  set -e

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
  SQUAD_CHANGES=$(git diff --name-only -- .squad/ 2>/dev/null || true)
  SQUAD_UNTRACKED=$(git ls-files --others --exclude-standard -- .squad/ 2>/dev/null || true)

  if [[ -n "${SQUAD_CHANGES}" || -n "${SQUAD_UNTRACKED}" ]]; then
    log "Found .squad/ state changes — committing..."
    git add .squad/
    git commit -m "squad(${AGENT_TYPE}): update team state for PR #${PR_NUMBER} revision" || log "Nothing new to commit in .squad/."
  fi

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

else
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
  git config --global user.name "squad-aca-bot[bot]"
  git config --global user.email "3362344+squad-aca-bot[bot]@users.noreply.github.com"

  # -- Clone repo --------------------------------------------------------------
  log "Cloning ${GITHUB_REPO}..."
  gh repo clone "${GITHUB_REPO}" /workspace/repo || die "Failed to clone ${GITHUB_REPO}."
  cd /workspace/repo

  # -- Create working branch ---------------------------------------------------
  BRANCH="squad/${AGENT_TYPE}/issue-${ISSUE_NUMBER}"
  log "Creating branch: ${BRANCH}"
  git checkout -b "${BRANCH}"

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

  set +e
  export GITHUB_TOKEN="${COPILOT_TOKEN}"
  echo "${SQUAD_PROMPT}" | copilot --yolo --agent squad 2>&1 | tee /workspace/copilot-output.log
  COPILOT_EXIT=${PIPESTATUS[1]}
  export GITHUB_TOKEN="${APP_TOKEN}"
  set -e

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

fi