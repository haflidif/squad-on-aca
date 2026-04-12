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
#   AZURE_STORAGE_ACCOUNT - storage account name (e.g. stsquadacaa6b49feb)
#   QUEUE_NAME            - queue name (e.g. squad-work-queue)
#   GITHUB_TOKEN          - PAT or GitHub App token for gh CLI auth
# ---------------------------------------------------------------------------

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die() { log "FATAL: $*"; exit 1; }

# -- Validate required env vars ---------------------------------------------
[[ -z "${AZURE_STORAGE_ACCOUNT:-}" ]] && die "AZURE_STORAGE_ACCOUNT is not set."
[[ -z "${QUEUE_NAME:-}" ]] && die "QUEUE_NAME is not set."
[[ -z "${GITHUB_TOKEN:-}" ]] && die "GITHUB_TOKEN is not set."

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

# -- GitHub auth -------------------------------------------------------------
log "Authenticating with GitHub..."
echo "${GITHUB_TOKEN}" | gh auth login --with-token || die "gh auth login failed."

# -- Git identity (needed for commits) --------------------------------------
git config --global user.name "squad-bot[${AGENT_TYPE}]"
git config --global user.email "squad-bot@users.noreply.github.com"

# -- Clone repo --------------------------------------------------------------
log "Cloning ${GITHUB_REPO}..."
gh repo clone "${GITHUB_REPO}" /workspace/repo || die "Failed to clone ${GITHUB_REPO}."
cd /workspace/repo

# -- Create working branch ---------------------------------------------------
BRANCH="squad/${AGENT_TYPE}/issue-${ISSUE_NUMBER}"
log "Creating branch: ${BRANCH}"
git checkout -b "${BRANCH}"

# -- Run squad agent ---------------------------------------------------------
log "Starting squad work..."
squad work --issue "${ISSUE_NUMBER}" --agent-type "${AGENT_TYPE}"

# -- Push and open PR --------------------------------------------------------
log "Pushing branch and creating PR..."
git push origin "${BRANCH}" || die "git push failed."

gh pr create --title "squad(${AGENT_TYPE}): resolve issue #${ISSUE_NUMBER}" --body "Automated PR by Squad agent \`${AGENT_TYPE}\` for issue #${ISSUE_NUMBER}." --base main --head "${BRANCH}" || die "gh pr create failed."

log "=== Agent ${AGENT_TYPE} completed issue #${ISSUE_NUMBER} ==="