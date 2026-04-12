#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Squad Agent Entrypoint
# Runs inside Azure Container App Jobs triggered by KEDA / Storage Queue.
#
# The queue message JSON is passed via QUEUE_MESSAGE env var and contains:
#   { "issue_number": 42, "agent_type": "backend", "repo": "owner/repo" }
#
# Required env vars:
#   QUEUE_MESSAGE  — JSON payload from the Storage Queue trigger
#   GITHUB_TOKEN   — PAT or GitHub App token for gh CLI auth
# ---------------------------------------------------------------------------

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die() { log "FATAL: $*"; exit 1; }

# ── Parse queue message ─────────────────────────────────────────────────────
[[ -z "${QUEUE_MESSAGE:-}" ]] && die "QUEUE_MESSAGE env var is empty or unset."
[[ -z "${GITHUB_TOKEN:-}" ]] && die "GITHUB_TOKEN env var is empty or unset."

ISSUE_NUMBER=$(echo "${QUEUE_MESSAGE}" | jq -r '.issue_number // empty') \
  || die "Failed to parse issue_number from QUEUE_MESSAGE."
AGENT_TYPE=$(echo "${QUEUE_MESSAGE}" | jq -r '.agent_type // empty') \
  || die "Failed to parse agent_type from QUEUE_MESSAGE."
GITHUB_REPO=$(echo "${QUEUE_MESSAGE}" | jq -r '.repo // empty') \
  || die "Failed to parse repo from QUEUE_MESSAGE."

[[ -z "${ISSUE_NUMBER}" ]] && die "issue_number is missing in QUEUE_MESSAGE."
[[ -z "${AGENT_TYPE}" ]]   && die "agent_type is missing in QUEUE_MESSAGE."
[[ -z "${GITHUB_REPO}" ]]  && die "repo is missing in QUEUE_MESSAGE."

export ISSUE_NUMBER AGENT_TYPE GITHUB_REPO

log "=== Squad Agent: ${AGENT_TYPE} ==="
log "Repository: ${GITHUB_REPO}"
log "Issue:      #${ISSUE_NUMBER}"

# ── GitHub auth ─────────────────────────────────────────────────────────────
log "Authenticating with GitHub..."
echo "${GITHUB_TOKEN}" | gh auth login --with-token \
  || die "gh auth login failed."

# ── Git identity (needed for commits) ──────────────────────────────────────
git config --global user.name  "squad-bot[${AGENT_TYPE}]"
git config --global user.email "squad-bot@users.noreply.github.com"

# ── Clone repo ──────────────────────────────────────────────────────────────
log "Cloning ${GITHUB_REPO}..."
gh repo clone "${GITHUB_REPO}" /workspace/repo \
  || die "Failed to clone ${GITHUB_REPO}."
cd /workspace/repo

# ── Create working branch ──────────────────────────────────────────────────
BRANCH="squad/${AGENT_TYPE}/issue-${ISSUE_NUMBER}"
log "Creating branch: ${BRANCH}"
git checkout -b "${BRANCH}"

# ── Run squad agent ─────────────────────────────────────────────────────────
log "Starting squad work..."
squad work --issue "${ISSUE_NUMBER}" --agent-type "${AGENT_TYPE}"

# ── Push and open PR ────────────────────────────────────────────────────────
log "Pushing branch and creating PR..."
git push origin "${BRANCH}" \
  || die "git push failed."

gh pr create \
  --title "squad(${AGENT_TYPE}): resolve issue #${ISSUE_NUMBER}" \
  --body "Automated PR by Squad agent \`${AGENT_TYPE}\` for issue #${ISSUE_NUMBER}." \
  --base main \
  --head "${BRANCH}" \
  || die "gh pr create failed."

log "=== Agent ${AGENT_TYPE} completed issue #${ISSUE_NUMBER} ==="
