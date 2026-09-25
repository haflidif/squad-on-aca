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

SCRIPT_PATH="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
  SCRIPT_PATH="$(readlink -f "${SCRIPT_PATH}")"
fi
RUNTIME_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"

# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/logging.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/env.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/azure-auth.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/queue.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/keyvault.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/github-app-auth.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/github-cli-auth.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/issue-labels.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/repo.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/copilot.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/publication.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/flows/revision.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/flows/new-issue.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/providers/aca-job.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/providers/aca-sandbox.sh"
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/providers/dispatch.sh"

validate_required_env
azure_login_managed_identity
dequeue_queue_message
parse_queue_message
validate_provider_before_ack
delete_queue_message
dispatch_provider
