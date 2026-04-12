#!/usr/bin/env bash
set -euo pipefail

# Agent entrypoint for Container App Job execution
# Env vars expected: AGENT_TYPE, GITHUB_REPO, GITHUB_TOKEN, QUEUE_NAME

echo "=== Squad Agent: ${AGENT_TYPE} ==="
echo "Repository: ${GITHUB_REPO}"

# Authenticate with GitHub
echo "${GITHUB_TOKEN}" | gh auth login --with-token

# Clone the target repository
gh repo clone "${GITHUB_REPO}" /workspace/repo
cd /workspace/repo

# Read the queue message (passed as argument or env var)
ISSUE_NUMBER="${ISSUE_NUMBER:-}"
if [ -z "${ISSUE_NUMBER}" ]; then
  echo "ERROR: No ISSUE_NUMBER provided"
  exit 1
fi

echo "Working on issue #${ISSUE_NUMBER} as agent type: ${AGENT_TYPE}"

# Create a working branch
BRANCH="squad/${AGENT_TYPE}/issue-${ISSUE_NUMBER}"
git checkout -b "${BRANCH}"

# Run the squad agent for this issue
# The agent reads .squad/ config, works the issue, commits changes
squad work --issue "${ISSUE_NUMBER}" --agent-type "${AGENT_TYPE}"

# Push and create PR
git push origin "${BRANCH}"
gh pr create \
  --title "squad(${AGENT_TYPE}): resolve issue #${ISSUE_NUMBER}" \
  --body "Automated PR by Squad agent \`${AGENT_TYPE}\` for issue #${ISSUE_NUMBER}." \
  --base main \
  --head "${BRANCH}"

echo "=== Agent ${AGENT_TYPE} completed issue #${ISSUE_NUMBER} ==="
