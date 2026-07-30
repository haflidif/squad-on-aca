#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Squad on ACA — azd postprovision hook (bash / Linux & macOS)
#
# Runs after `azd provision` completes.  Three responsibilities:
#
#   A) Build + push squad-agent image to ACR via `az acr build`.
#      The agents/base/Dockerfile references base images cached in the *old*
#      ACR (crsquadacaa6b49feb.azurecr.io) — a Dockerfile design limitation
#      noted for Chewie (parameterize FROM with build args in a future PR).
#      Workaround: import the two base images from Docker Hub into the new ACR
#      first, then patch the Dockerfile path before building.
#
#   B) Key Vault secret guidance.
#      Checks whether `github-app-private-key` and `copilot-pat` exist.
#      Prints `az keyvault secret set` commands to upload them.
#      Secret VALUES are never echoed or embedded here.
#
#   C) GitHub Actions repository variables.
#      Sets 5 variables on every repo in TARGET_REPOS via `gh variable set`.
#      Idempotent — gh variable set is a create-or-update operation.
#      Skips gracefully if `gh` is not installed or not authenticated.
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
echo -e "${CYAN}--- A) Building squad-agent image ---${NC}"
echo ""

# The agents/base/Dockerfile references hardcoded ACR base image paths from
# the original deployment (crsquadacaa6b49feb.azurecr.io).  We need to:
#   1. Import those base images from Docker Hub into the new ACR.
#   2. Patch the Dockerfile references to the new ACR before building.
# TODO (Chewie): Parameterize the FROM lines with ARG BASE_ACR_HOST so this
# workaround is no longer needed. Tracking: squad/9-azd-bicep-support.

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

# Patch Dockerfile FROM lines to reference the new ACR (workaround for hardcoded old ACR)
ORIGINAL_DOCKERFILE="agents/base/Dockerfile"
PATCHED_DOCKERFILE="agents/base/Dockerfile.azd-build"

# Replace any .azurecr.io host in FROM lines with the new ACR login server
sed 's|[a-z0-9]*\.azurecr\.io|'"${ACR_LOGIN_SERVER}"'|g' \
  "$ORIGINAL_DOCKERFILE" > "$PATCHED_DOCKERFILE"

echo "   (Using patched Dockerfile: FROM references updated to ${ACR_LOGIN_SERVER})"

az acr build \
  --registry "$ACR_NAME" \
  --image "squad-agent:latest" \
  --file "$PATCHED_DOCKERFILE" \
  "agents/base/" \
  --only-show-errors

# Clean up patched Dockerfile
rm -f "$PATCHED_DOCKERFILE"

echo -e "${GREEN}✓ squad-agent:latest pushed to ${ACR_LOGIN_SERVER}${NC}"
echo ""

# ---------------------------------------------------------------------------
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
# C) GitHub Actions repository variables
# ---------------------------------------------------------------------------
echo -e "${CYAN}--- C) GitHub Actions repository variables ---${NC}"
echo ""

if [[ -z "${TARGET_REPOS:-}" ]]; then
  echo -e "${YELLOW}ℹ TARGET_REPOS is not set — skipping GitHub Actions variable setup.${NC}"
  echo "  Set it and re-run 'azd provision' to wire the variables:"
  echo "    azd env set TARGET_REPOS '[\"owner/repo\"]'"
  echo ""
else
  # Check gh CLI is available and authenticated
  if ! command -v gh &>/dev/null; then
    echo -e "${YELLOW}⚠ 'gh' CLI not found — skipping GitHub Actions variable setup.${NC}"
    echo "  Install from https://cli.github.com and run:"
    echo "    gh auth login"
    echo "  Then re-run 'azd provision' or set the variables manually:"
    echo "    gh variable set SQUAD_AZURE_CLIENT_ID     --body <client_id>      --repo <owner/repo>"
    echo "    gh variable set SQUAD_AZURE_TENANT_ID     --body <tenant_id>      --repo <owner/repo>"
    echo "    gh variable set SQUAD_AZURE_SUBSCRIPTION_ID --body <sub_id>       --repo <owner/repo>"
    echo "    gh variable set SQUAD_STORAGE_ACCOUNT     --body <storage_name>   --repo <owner/repo>"
    echo "    gh variable set SQUAD_QUEUE_NAME           --body <queue_name>     --repo <owner/repo>"
  elif ! gh auth status &>/dev/null; then
    echo -e "${YELLOW}⚠ 'gh' CLI is not authenticated — skipping GitHub Actions variable setup.${NC}"
    echo "  Run:  gh auth login"
    echo "  Then re-run 'azd provision'."
  else
    # Parse TARGET_REPOS JSON array into shell array
    # Supports formats: '["owner/repo1","owner/repo2"]' or '["owner/repo1"]'
    repos=()
    while IFS= read -r repo; do
      repos+=("$repo")
    done < <(echo "$TARGET_REPOS" | tr -d '[] ' | tr ',' '\n' | tr -d '"')

    for repo in "${repos[@]}"; do
      if [[ -z "$repo" ]]; then
        continue
      fi
      echo "  Setting variables on repo: $repo"

      set_var() {
        local var_name="$1"
        local var_value="$2"
        if [[ -z "$var_value" ]]; then
          echo -e "    ${YELLOW}⚠ Skipping $var_name — value is empty${NC}"
          return
        fi
        gh variable set "$var_name" --body "$var_value" --repo "$repo" && \
          echo -e "    ${GREEN}✓ $var_name${NC}" || \
          echo -e "    ${RED}✗ Failed to set $var_name — check repo permissions${NC}"
      }

      set_var "SQUAD_AZURE_CLIENT_ID"       "$SQUAD_AGENT_CLIENT_ID"
      set_var "SQUAD_AZURE_TENANT_ID"       "$SQUAD_AGENT_TENANT_ID"
      set_var "SQUAD_AZURE_SUBSCRIPTION_ID" "$AZURE_SUBSCRIPTION_ID"
      set_var "SQUAD_STORAGE_ACCOUNT"       "$STORAGE_ACCOUNT_NAME"
      set_var "SQUAD_QUEUE_NAME"            "$QUEUE_NAME"
      echo ""
    done
  fi
fi

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
