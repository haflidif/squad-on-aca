#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Squad on ACA — azd postprovision hook (bash / Linux & macOS)
#
# Runs after `azd provision` completes.  Three responsibilities:
#
#   A) Build + push squad-agent image to ACR via `az acr build`.
#      Imports golang and debian base images from Docker Hub into the new ACR
#      first (avoids rate limits), then builds using --build-arg BASE_ACR_HOST
#      to point the Dockerfile's ARG-parameterized FROM lines at the new ACR.
#
#   B) Key Vault secret guidance.
#      Checks whether `github-app-private-key` and `copilot-pat` exist.
#      Prints `az keyvault secret set` commands to upload them.
#      Secret VALUES are never echoed or embedded here.
#
#   C) Descriptor activation and GitHub setting guidance through scripts/activate.cjs.
#      GitHub settings are print-only. An explicit later --apply is required.
#      Set SQUAD_ACTIVATION_TARGET to write a disabled binding in a target repo.
#      Without a target, the hook previews only and writes no repository files.
#
# azd exports Bicep outputs as uppercase env vars before running hooks, e.g.:
#   RESOURCE_GROUP_NAME, ACR_LOGIN_SERVER, STORAGE_ACCOUNT_NAME, QUEUE_NAME,
#   KEY_VAULT_NAME, SQUAD_AGENT_CLIENT_ID, SQUAD_AGENT_TENANT_ID, AGENT_JOB_NAME
# AZURE_SUBSCRIPTION_ID is injected by azd.
# ---------------------------------------------------------------------------
set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo "==================================================================="
echo " Squad on ACA — post-provision setup"
echo "==================================================================="
echo ""

# ---------------------------------------------------------------------------
# Resolve Bicep outputs (env vars injected by azd after provision)
# Fall back to azd env get-values if an expected var is empty.
# ---------------------------------------------------------------------------
resolve_output() {
  local varname="$1"
  local val="${!varname:-}"
  if [[ -z "$val" ]]; then
    # azd env get-values emits KEY=VALUE lines; parse the specific key
    val=$(azd env get-values 2>/dev/null | grep -E "^${varname}=" | cut -d'=' -f2- | tr -d '"' || true)
  fi
  echo "$val"
}

activate_repository() {
  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -n "${SQUAD_ACTIVATION_TARGET:-}" ]]; then
    node "$script_dir/../../scripts/activate.cjs" --azd --target "$SQUAD_ACTIVATION_TARGET"
  else
    node "$script_dir/../../scripts/activate.cjs" --azd --preview
  fi
}

BACKEND=$(resolve_output "EXECUTION_BACKEND")
BACKEND="${BACKEND:-${SQUAD_EXECUTION_BACKEND-jobs}}"
case "$BACKEND" in
  jobs|sandbox) ;;
  *) echo 'Execution backend must be jobs or sandbox.' >&2; exit 1 ;;
esac
if [[ "${SQUAD_EXECUTION_BACKEND+x}" == x && "$BACKEND" != "$SQUAD_EXECUTION_BACKEND" ]]; then
  echo 'Requested backend differs from deployed backend. Reconcile the destination before post-provision setup.' >&2
  exit 1
fi
if [[ "$BACKEND" == sandbox ]]; then
  echo 'Sandbox infrastructure provisioned. Use the published immutable worker image and platformDescriptor output for separate repository onboarding.'
  echo 'Skipping Jobs image build, Job update, Key Vault/PAT checks, and legacy queue repository variables. Execution has not been enabled.'
  activate_repository
  exit 0
fi
JOBS_IMAGE_REF=$(resolve_output "JOBS_IMAGE_REF")

RESOURCE_GROUP_NAME=$(resolve_output "RESOURCE_GROUP_NAME")
ACR_LOGIN_SERVER=$(resolve_output "ACR_LOGIN_SERVER")
KEY_VAULT_NAME=$(resolve_output "KEY_VAULT_NAME")
STORAGE_ACCOUNT_NAME=$(resolve_output "STORAGE_ACCOUNT_NAME")
QUEUE_NAME=$(resolve_output "QUEUE_NAME")
SQUAD_AGENT_CLIENT_ID=$(resolve_output "SQUAD_AGENT_CLIENT_ID")
SQUAD_AGENT_TENANT_ID=$(resolve_output "SQUAD_AGENT_TENANT_ID")
AGENT_JOB_NAME=$(resolve_output "AGENT_JOB_NAME")

AZURE_SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv 2>/dev/null || true)}"

if [[ -z "$ACR_LOGIN_SERVER" ]]; then
  echo -e "${RED}ERROR: ACR_LOGIN_SERVER output not found.  Cannot build agent image.${NC}"
  echo "  Check that 'azd provision' completed successfully."
  exit 1
fi

# Derive ACR name from login server (strip .azurecr.io suffix)
ACR_NAME="${ACR_LOGIN_SERVER%.azurecr.io}"

echo -e "${CYAN}Resource Group :${NC} ${RESOURCE_GROUP_NAME}"
echo -e "${CYAN}ACR            :${NC} ${ACR_LOGIN_SERVER}"
echo -e "${CYAN}Key Vault      :${NC} ${KEY_VAULT_NAME}"
echo -e "${CYAN}Storage Account:${NC} ${STORAGE_ACCOUNT_NAME}"
echo -e "${CYAN}Queue          :${NC} ${QUEUE_NAME}"
echo -e "${CYAN}CA Job         :${NC} ${AGENT_JOB_NAME}"
echo ""

# ---------------------------------------------------------------------------
# A) Build + push squad-agent image
# ---------------------------------------------------------------------------
if [[ -z "$JOBS_IMAGE_REF" ]]; then
echo -e "${CYAN}--- A) Building squad-agent image ---${NC}"
echo ""

echo "📦 Importing base images from Docker Hub into ${ACR_LOGIN_SERVER} ..."
echo "   (This avoids Docker Hub rate limits by caching in your ACR)"
echo "   golang:1.23.4-bookworm ..."
az acr import \
  --name "$ACR_NAME" \
  --source docker.io/library/golang:1.23.4-bookworm \
  --image base/golang:1.23.4-bookworm \
  --force \
  --only-show-errors || {
    echo -e "${YELLOW}⚠ Warning: Could not import golang base image.  Build may fail if image is not already present.${NC}"
  }

echo "   debian:bookworm-20240701-slim ..."
az acr import \
  --name "$ACR_NAME" \
  --source docker.io/library/debian:bookworm-20240701-slim \
  --image base/debian:bookworm-20240701-slim \
  --force \
  --only-show-errors || {
    echo -e "${YELLOW}⚠ Warning: Could not import debian base image.  Build may fail if image is not already present.${NC}"
  }

echo ""
echo "🔨 Building squad-agent:latest and pushing to ${ACR_LOGIN_SERVER} ..."

az acr build \
  --registry "$ACR_NAME" \
  --image "squad-agent:latest" \
  --file "agents/base/Dockerfile" \
  --build-arg "BASE_ACR_HOST=${ACR_LOGIN_SERVER}/" \
  "agents/base/" \
  --only-show-errors

echo -e "${GREEN}✓ squad-agent:latest pushed to ${ACR_LOGIN_SERVER}${NC}"
echo ""

# Update the Container App Job to use the real image now that it is in ACR.
# On initial provision the job starts with a public placeholder image (see
# infra/bicep/modules/container-app-job.bicep); this step wires in the real image.
if [[ -n "$AGENT_JOB_NAME" && -n "$RESOURCE_GROUP_NAME" ]]; then
  echo "🔄 Updating Container App Job image to ${ACR_LOGIN_SERVER}/squad-agent:latest ..."
  az containerapp job update \
    --name "${AGENT_JOB_NAME}" \
    --resource-group "${RESOURCE_GROUP_NAME}" \
    --image "${ACR_LOGIN_SERVER}/squad-agent:latest" \
    --only-show-errors \
  && echo -e "${GREEN}✓ Container App Job image updated${NC}" \
  || echo -e "${YELLOW}⚠ Could not update job image — run manually:${NC}
    az containerapp job update \\
      --name ${AGENT_JOB_NAME} \\
      --resource-group ${RESOURCE_GROUP_NAME} \\
      --image ${ACR_LOGIN_SERVER}/squad-agent:latest"
fi
echo ""

# ---------------------------------------------------------------------------
else
  echo 'Using the pinned Jobs image from provisioning; skipping latest image build and Job update.'
fi

# B) Key Vault secret guidance
# ---------------------------------------------------------------------------
echo -e "${CYAN}--- B) Key Vault secrets ---${NC}"
echo ""

check_kv_secret() {
  local secret_name="$1"
  if az keyvault secret show \
       --vault-name "$KEY_VAULT_NAME" \
       --name "$secret_name" \
       --query "id" -o tsv \
       --only-show-errors > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓ '$secret_name' exists in Key Vault${NC}"
    return 0
  else
    return 1
  fi
}

GH_APP_KEY_MISSING=false
COPILOT_PAT_MISSING=false

if ! check_kv_secret "github-app-private-key"; then
  GH_APP_KEY_MISSING=true
  echo -e "  ${YELLOW}⚠ 'github-app-private-key' is NOT set in Key Vault '${KEY_VAULT_NAME}'.${NC}"
  echo "    Upload your GitHub App private key (.pem file):"
  echo ""
  echo "      az keyvault secret set \\"
  echo "        --vault-name ${KEY_VAULT_NAME} \\"
  echo "        --name github-app-private-key \\"
  echo "        --file /path/to/your-app.private-key.pem"
  echo ""
fi

if ! check_kv_secret "copilot-pat"; then
  COPILOT_PAT_MISSING=true
  echo -e "  ${YELLOW}⚠ 'copilot-pat' is NOT set in Key Vault '${KEY_VAULT_NAME}'.${NC}"
  echo "    Upload your GitHub Copilot PAT (with copilot scope):"
  echo ""
  echo "      az keyvault secret set \\"
  echo "        --vault-name ${KEY_VAULT_NAME} \\"
  echo "        --name copilot-pat \\"
  echo "        --value '<YOUR_COPILOT_PAT>'"
  echo ""
  echo "    Or from an env var (never echo the value in shell history):"
  echo "      az keyvault secret set \\"
  echo "        --vault-name ${KEY_VAULT_NAME} \\"
  echo "        --name copilot-pat \\"
  echo "        --value \"\$COPILOT_PAT_VALUE\""
  echo ""
fi

if [[ "$GH_APP_KEY_MISSING" == "false" && "$COPILOT_PAT_MISSING" == "false" ]]; then
  echo -e "  ${GREEN}✓ Both Key Vault secrets are present.${NC}"
fi

# Note on purge protection: Key Vault is deployed with purge protection DISABLED
# in dev (soft-delete only) for easy teardown via `azd down`.  In production,
# enable purge protection in modules/keyvault.bicep to prevent accidental deletion.
# RBAC propagation may take 1-2 minutes — if secrets upload fails with 403,
# wait a moment and retry.

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "==================================================================="
echo " Post-provision complete."
echo "==================================================================="
echo ""
if [[ "$GH_APP_KEY_MISSING" == "true" || "$COPILOT_PAT_MISSING" == "true" ]]; then
  echo -e "${YELLOW}ACTION REQUIRED: Upload missing Key Vault secrets (see instructions above).${NC}"
  echo "The agent job will not start until both secrets are present."
  echo ""
fi
echo "Useful commands:"
echo "  View job:   az containerapp job show -n ${AGENT_JOB_NAME} -g ${RESOURCE_GROUP_NAME}"
echo "  Tail logs:  az containerapp job logs show -n ${AGENT_JOB_NAME} -g ${RESOURCE_GROUP_NAME}"
echo "  Teardown:   azd down --purge"
echo ""

# azd down notes:
# - Key Vault uses soft-delete; `--purge` purges it immediately (dev behaviour).
#   Remove --purge in production or if purge protection is enabled.
# - RBAC propagation on newly created resources may take 1-2 minutes; if the
#   agent job fails with auth errors on first run, wait and retry.

activate_repository
