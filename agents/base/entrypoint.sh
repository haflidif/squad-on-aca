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

ISSUE_NUMBER=$(echo "${QUEUE_MESSAGE}" | jq -r '.issue_number // empty')
AGENT_TYPE=$(echo "${QUEUE_MESSAGE}" | jq -r '.agent_type // empty')
GITHUB_REPO=$(echo "${QUEUE_MESSAGE}" | jq -r '.repo // empty')

[[ -z "${ISSUE_NUMBER}" ]] && die "issue_number is missing in message."
[[ -z "${AGENT_TYPE}" ]] && die "agent_type is missing in message."
[[ -z "${GITHUB_REPO}" ]] && die "repo is missing in message."

# -- Delete message from queue (prevent reprocessing) ------------------------
log "Deleting message ${MSG_ID} from queue..."
az storage message delete --queue-name "${QUEUE_NAME}" --account-name "${AZURE_STORAGE_ACCOUNT}" --auth-mode login --id "${MSG_ID}" --pop-receipt "${POP_RECEIPT}" -o none || die "Failed to delete message ${MSG_ID} from queue."

export ISSUE_NUMBER AGENT_TYPE GITHUB_REPO

log "=== Squad Agent: ${AGENT_TYPE} ==="
log "Repository: ${GITHUB_REPO}"
log "Issue:      #${ISSUE_NUMBER}"

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

# -- Dedup checks (prevent multiple containers working the same issue) -------
# Multiple KEDA-triggered containers may dequeue messages for the same issue
# (e.g. retries, duplicate enqueue). These checks gate processing so only one
# container performs work per issue.

# 1. Check squad:processing label — if the label is missing, another container
#    already completed this issue (it would have swapped the label on PR creation).
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

# 2. Check for existing open PRs whose branch matches the squad naming convention.
#    Using --head is precise and avoids false positives from free-text search.
log "Checking for existing PRs for issue #${ISSUE_NUMBER}..."
EXISTING_PR=$(gh pr list --repo "${GITHUB_REPO}" --state open \
  --json number,headRefName \
  --jq "[.[] | select(.headRefName | test(\"squad/.*/issue-${ISSUE_NUMBER}$\"))] | .[0].number // empty" \
  2>/dev/null || true)

if [[ -n "${EXISTING_PR}" ]]; then
  log "PR #${EXISTING_PR} already exists for issue #${ISSUE_NUMBER}. Skipping."
  # Ensure labels reflect reality — swap processing → queued if needed
  gh issue edit "${ISSUE_NUMBER}" --repo "${GITHUB_REPO}" \
    --remove-label "squad:processing" --add-label "squad:queued" 2>/dev/null || true
  exit 0
fi

# 3. Check for existing squad branches on remote (covers the window between
#    push and PR creation where another container could start).
log "Checking for existing squad branches for issue #${ISSUE_NUMBER}..."
EXISTING_BRANCH=$(git ls-remote --heads "https://github.com/${GITHUB_REPO}.git" "squad/*/issue-${ISSUE_NUMBER}" 2>/dev/null | head -1 || true)
if [[ -n "${EXISTING_BRANCH}" ]]; then
  log "Branch already exists for issue #${ISSUE_NUMBER}. Skipping."
  exit 0
fi

# 4. Confirm squad:processing label is present (it should already be set by the
#    workflow before enqueue — this is a defensive re-apply for edge cases).
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
# Run GitHub Copilot CLI in --yolo mode (auto-accepts all operations).
# The container is ephemeral and isolated — yolo is safe here.
# If copilot fails, fall back to a work artifact so the PR still gets created.

COPILOT_SUCCEEDED=false

log "Running Copilot CLI for issue #${ISSUE_NUMBER}..."

COPILOT_PROMPT="You are working in a git repo. Read the following GitHub issue and make the code changes it describes.

Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

${ISSUE_BODY}

Make all necessary code changes to resolve this issue. After making changes, stage and commit them with a descriptive commit message referencing issue #${ISSUE_NUMBER}."

# Temporarily allow failure so copilot errors don't kill the script
set +e
# Swap to Copilot-licensed PAT for AI operations (App tokens can't use Copilot)
export GITHUB_TOKEN="${COPILOT_TOKEN}"
echo "${COPILOT_PROMPT}" | copilot --yolo 2>&1 | tee /workspace/copilot-output.log
COPILOT_EXIT=${PIPESTATUS[1]}
# Swap back to App token for git push + PR creation
export GITHUB_TOKEN="${APP_TOKEN}"
set -e

if [[ "${COPILOT_EXIT}" -eq 0 ]]; then
  log "Copilot CLI completed successfully."
  COPILOT_SUCCEEDED=true
else
  log "WARNING: Copilot CLI failed (exit code ${COPILOT_EXIT}). Falling back to work artifact."
fi

# Check if copilot made any changes (committed or uncommitted)
if [[ "${COPILOT_SUCCEEDED}" == "true" ]]; then
  # Stage any unstaged changes copilot may have left
  if [[ -n "$(git status --porcelain)" ]]; then
    log "Copilot left uncommitted changes — committing them now."
    git add -A
    git commit -m "squad(${AGENT_TYPE}): copilot changes for issue #${ISSUE_NUMBER}

Automated by Squad agent pipeline (Copilot CLI --yolo).
Issue: ${ISSUE_TITLE}" || log "Nothing new to commit (copilot may have committed already)."
  fi

  # Verify we actually have commits beyond the base branch
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

# -- Push and open PR --------------------------------------------------------
log "Pushing branch and creating PR..."
git push origin "${BRANCH}" || die "git push failed."

PR_BODY=$(cat <<EOF
## Squad Agent: \`${AGENT_TYPE}\`

Automated PR for issue #${ISSUE_NUMBER}.

### Pipeline Status
| Step | Status |
|------|--------|
| Queue dequeue (MI auth) | ✅ |
| Issue fetch | ✅ |
| Clone + branch | ✅ |
| Copilot CLI (--yolo) | $(if [[ "${COPILOT_SUCCEEDED}" == "true" ]]; then echo "✅"; else echo "⚠️ fallback"; fi) |
| Push + PR | ✅ |

$(if [[ "${COPILOT_SUCCEEDED}" == "true" ]]; then
  echo "### Copilot CLI"
  echo "Code changes were generated by GitHub Copilot CLI running in \`--yolo\` mode."
else
  echo "### Note"
  echo "Copilot CLI did not produce code changes. A fallback work artifact was committed instead."
  echo "Check \`.squad-work/issue-${ISSUE_NUMBER}.md\` for details and copilot output."
fi)

Closes #${ISSUE_NUMBER}
EOF
)

gh pr create \
  --title "squad(${AGENT_TYPE}): resolve issue #${ISSUE_NUMBER}" \
  --body "${PR_BODY}" \
  --base main \
  --head "${BRANCH}" \
  || die "gh pr create failed."

# -- Update issue labels (processing → queued) -------------------------------
# Signal that this issue now has a PR queued for review.
log "Swapping labels on issue #${ISSUE_NUMBER} (processing → queued)..."
gh issue edit "${ISSUE_NUMBER}" --repo "${GITHUB_REPO}" \
  --remove-label "squad:processing" --add-label "squad:queued" 2>/dev/null \
  || log "WARNING: Could not swap labels on issue #${ISSUE_NUMBER}."

log "=== Agent ${AGENT_TYPE} completed issue #${ISSUE_NUMBER} ==="