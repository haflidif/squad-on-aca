#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Squad on ACA — smoke test suite (bash)
#
# Asserts that every resource deployed by infra/bicep/main.bicep exists and
# is healthy.  Run AFTER a successful `azd provision` or `azd up`.
#
# Usage:
#   ./infra/tests/smoke-test.sh [OPTIONS]
#
# Discovery modes (choose one):
#   -a, --azd-env <name>         Read all resource names from azd env outputs.
#                                Requires `azd` to be installed and authenticated.
#
#   -g, --resource-group <name>  Resource group name (required in manual mode).
#       --storage-account <name> Storage account name.
#       --queue-name <name>      Queue name (default: squad-work-queue).
#       --acr <name>             Container Registry name (without .azurecr.io).
#       --log-analytics <name>   Log Analytics workspace name.
#       --key-vault <name>       Key Vault name.
#       --aca-env <name>         Container Apps environment name.
#       --job <name>             Container App Job name.
#       --identity <name>        User-Assigned Managed Identity name.
#       --uami-resource-id <id>  UAMI resource ID (for KEDA scaler check).
#
# Optional:
#       --image-tag <tag>        Expected ACR image tag (default: squad-agent:latest).
#       --run-job                OPT-IN: trigger one job execution and assert
#                                it reaches Succeeded/Running state within --job-timeout.
#       --job-timeout <secs>     Max seconds to wait for job execution (default: 120).
#   -h, --help                   Show this help and exit.
#
# Exit codes:
#   0 — all assertions passed
#   1 — one or more assertions failed (details printed inline)
#   2 — prerequisite / argument error
#
# SECURITY: This script NEVER echoes secret values or connection strings.
#           Key Vault checks assert presence of secret NAMES only.
#
# Examples:
#   # azd env mode (easiest after `azd provision`):
#   ./infra/tests/smoke-test.sh --azd-env dev
#
#   # Manual mode:
#   ./infra/tests/smoke-test.sh \
#     --resource-group rg-squad-aca-dev-a1b2c3d4 \
#     --storage-account stSquadacaa1b2c3d4 \
#     --acr crSquadacaa1b2c3d4 \
#     --log-analytics law-squad-aca-dev-a1b2c3d4 \
#     --key-vault kv-squad-a1b2c3d4 \
#     --aca-env cae-squad-aca-dev-a1b2c3d4 \
#     --job job-squad-agent-a1b2c3d4 \
#     --identity id-squad-agent-a1b2c3d4 \
#     --uami-resource-id /subscriptions/.../...
#
#   # With optional job trigger:
#   ./infra/tests/smoke-test.sh --azd-env dev --run-job --job-timeout 180
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- Defaults ------------------------------------------------------------
AZD_ENV=""
RESOURCE_GROUP=""
STORAGE_ACCOUNT=""
QUEUE_NAME="squad-work-queue"
ACR_NAME=""
LOG_ANALYTICS=""
KEY_VAULT=""
ACA_ENV=""
JOB_NAME=""
IDENTITY_NAME=""
UAMI_RESOURCE_ID=""
IMAGE_TAG="squad-agent:latest"
RUN_JOB=false
JOB_TIMEOUT=120

# ---- Counters ------------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0

# ---- Colors --------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -60
  exit 0
}

die() {
  echo -e "${RED}ERROR: $*${NC}" >&2
  exit 2
}

# ---- Argument parsing ----------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--azd-env)         AZD_ENV="$2";          shift 2 ;;
    -g|--resource-group)  RESOURCE_GROUP="$2";    shift 2 ;;
    --storage-account)    STORAGE_ACCOUNT="$2";   shift 2 ;;
    --queue-name)         QUEUE_NAME="$2";         shift 2 ;;
    --acr)                ACR_NAME="$2";           shift 2 ;;
    --log-analytics)      LOG_ANALYTICS="$2";      shift 2 ;;
    --key-vault)          KEY_VAULT="$2";          shift 2 ;;
    --aca-env)            ACA_ENV="$2";            shift 2 ;;
    --job)                JOB_NAME="$2";           shift 2 ;;
    --identity)           IDENTITY_NAME="$2";      shift 2 ;;
    --uami-resource-id)   UAMI_RESOURCE_ID="$2";   shift 2 ;;
    --image-tag)          IMAGE_TAG="$2";           shift 2 ;;
    --run-job)            RUN_JOB=true;             shift 1 ;;
    --job-timeout)        JOB_TIMEOUT="$2";         shift 2 ;;
    -h|--help)            usage ;;
    *)                    die "Unknown argument: $1. Run with --help." ;;
  esac
done

# ---- Prerequisite: az CLI ------------------------------------------------
if ! command -v az &>/dev/null; then
  die "'az' CLI not found. Install from https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
fi

# ---- Resolve resource names from azd env ---------------------------------
if [[ -n "$AZD_ENV" ]]; then
  if ! command -v azd &>/dev/null; then
    die "'azd' not found but --azd-env was specified. Install from https://aka.ms/azd"
  fi
  echo -e "${CYAN}Reading resource names from azd environment: ${AZD_ENV}${NC}"
  # azd env get-values emits KEY="VALUE" lines
  AZD_VALUES=$(azd env get-values --environment "${AZD_ENV}" 2>/dev/null || true)

  _azd_get() {
    local key="$1"
    echo "$AZD_VALUES" | grep -E "^${key}=" | head -1 | cut -d'=' -f2- | tr -d '"' || true
  }

  RESOURCE_GROUP="${RESOURCE_GROUP:-$(_azd_get RESOURCE_GROUP_NAME)}"
  STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-$(_azd_get STORAGE_ACCOUNT_NAME)}"
  QUEUE_NAME="${QUEUE_NAME:-$(_azd_get QUEUE_NAME)}"
  ACA_ENV="${ACA_ENV:-$(_azd_get CONTAINER_APPS_ENVIRONMENT)}"
  JOB_NAME="${JOB_NAME:-$(_azd_get AGENT_JOB_NAME)}"
  IDENTITY_NAME="${IDENTITY_NAME:-$(_azd_get AGENT_IDENTITY_NAME)}"
  KEY_VAULT="${KEY_VAULT:-$(_azd_get KEY_VAULT_NAME)}"
  UAMI_RESOURCE_ID="${UAMI_RESOURCE_ID:-$(_azd_get UAMI_RESOURCE_ID)}"

  # ACR: derive name from login server (strip .azurecr.io)
  _ACR_SERVER=$(_azd_get ACR_LOGIN_SERVER)
  ACR_NAME="${ACR_NAME:-${_ACR_SERVER%.azurecr.io}}"

  # Log Analytics name is not a Bicep output; derive from resource group name
  # naming: law-${namePrefix}-${nameSuffix}  where rg = rg-${namePrefix}-${nameSuffix}
  if [[ -z "$LOG_ANALYTICS" && -n "$RESOURCE_GROUP" ]]; then
    # rg-squad-aca-dev-a1b2c3d4 → law-squad-aca-dev-a1b2c3d4
    _SUFFIX="${RESOURCE_GROUP#rg-}"
    LOG_ANALYTICS="law-${_SUFFIX}"
  fi
fi

# ---- Validate required inputs --------------------------------------------
[[ -z "$RESOURCE_GROUP" ]]  && die "--resource-group (or --azd-env) is required."
[[ -z "$STORAGE_ACCOUNT" ]] && die "--storage-account is required in manual mode."
[[ -z "$ACR_NAME" ]]        && die "--acr is required in manual mode."
[[ -z "$KEY_VAULT" ]]       && die "--key-vault is required in manual mode."
[[ -z "$ACA_ENV" ]]         && die "--aca-env is required in manual mode."
[[ -z "$JOB_NAME" ]]        && die "--job is required in manual mode."
[[ -z "$IDENTITY_NAME" ]]   && die "--identity is required in manual mode."

# ---- Assertion helpers ---------------------------------------------------
pass() {
  echo -e "  ${GREEN}✓ PASS${NC}: $*"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "  ${RED}✗ FAIL${NC}: $*"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

warn() {
  echo -e "  ${YELLOW}⚠ SKIP${NC}: $*"
}

section() {
  echo ""
  echo -e "${CYAN}--- $* ---${NC}"
}

# ---- Role ID constants (from infra/bicep/main.bicep) --------------------
ROLE_STORAGE_QUEUE_READER="19e7f393-937e-4f77-808e-94535e297925"
ROLE_STORAGE_QUEUE_CONTRIBUTOR="974c5e8b-45b9-4653-ba55-5f855dd0fb88"
ROLE_ACR_PULL="7f951dda-4ed3-4680-a7ca-43fe172d538d"
ROLE_ACR_PUSH="8311e382-0749-4cb8-b61a-304f252e45ec"
ROLE_KV_SECRETS_USER="4633458b-17de-408a-b874-0445c86b69e6"

# ---- Print discovered config --------------------------------------------
echo ""
echo "=================================================================="
echo -e "${CYAN} Squad on ACA — Smoke Test Suite${NC}"
echo "=================================================================="
echo ""
echo "  Resource group  : ${RESOURCE_GROUP}"
echo "  Storage account : ${STORAGE_ACCOUNT}"
echo "  Queue           : ${QUEUE_NAME}"
echo "  ACR             : ${ACR_NAME}"
echo "  Log Analytics   : ${LOG_ANALYTICS:-<not specified>}"
echo "  Key Vault       : ${KEY_VAULT}"
echo "  ACA Environment : ${ACA_ENV}"
echo "  CA Job          : ${JOB_NAME}"
echo "  UAMI            : ${IDENTITY_NAME}"
echo "  Run job test    : ${RUN_JOB}"
echo ""

# ==========================================================================
# 1. Resource group
# ==========================================================================
section "1. Resource group"

RG_STATE=$(az group show --name "${RESOURCE_GROUP}" --query "properties.provisioningState" -o tsv 2>/dev/null || echo "NOT_FOUND")
if [[ "$RG_STATE" == "Succeeded" ]]; then
  pass "Resource group '${RESOURCE_GROUP}' exists (provisioningState: Succeeded)"
else
  fail "Resource group '${RESOURCE_GROUP}' — expected Succeeded, got: ${RG_STATE}"
fi

# ==========================================================================
# 2. Log Analytics workspace
# ==========================================================================
section "2. Log Analytics workspace"

if [[ -n "$LOG_ANALYTICS" ]]; then
  LAW_STATE=$(az monitor log-analytics workspace show \
    --resource-group "${RESOURCE_GROUP}" \
    --workspace-name "${LOG_ANALYTICS}" \
    --query "provisioningState" -o tsv 2>/dev/null || echo "NOT_FOUND")
  if [[ "$LAW_STATE" == "Succeeded" ]]; then
    pass "Log Analytics workspace '${LOG_ANALYTICS}' — provisioningState: Succeeded"
  else
    fail "Log Analytics workspace '${LOG_ANALYTICS}' — expected Succeeded, got: ${LAW_STATE}"
  fi
else
  warn "Log Analytics workspace name not available — skipping (provide --log-analytics to enable)"
fi

# ==========================================================================
# 3. Storage account + queue
# ==========================================================================
section "3. Storage account and queue"

SA_STATE=$(az storage account show \
  --name "${STORAGE_ACCOUNT}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query "provisioningState" -o tsv 2>/dev/null || echo "NOT_FOUND")
if [[ "$SA_STATE" == "Succeeded" ]]; then
  pass "Storage account '${STORAGE_ACCOUNT}' — provisioningState: Succeeded"
else
  fail "Storage account '${STORAGE_ACCOUNT}' — expected Succeeded, got: ${SA_STATE}"
fi

# Check shared key access is disabled (security assertion from storage.bicep)
SA_SHARED_KEY=$(az storage account show \
  --name "${STORAGE_ACCOUNT}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query "allowSharedKeyAccess" -o tsv 2>/dev/null || echo "unknown")
if [[ "$SA_SHARED_KEY" == "false" ]]; then
  pass "Storage account shared key access is disabled (identity-auth enforced)"
else
  fail "Storage account shared key access — expected false (disabled), got: ${SA_SHARED_KEY}"
fi

# Queue existence: use az storage queue exists with --auth-mode login
QUEUE_EXISTS=$(az storage queue exists \
  --account-name "${STORAGE_ACCOUNT}" \
  --name "${QUEUE_NAME}" \
  --auth-mode login \
  --query "exists" -o tsv 2>/dev/null || echo "false")
if [[ "$QUEUE_EXISTS" == "true" ]]; then
  pass "Storage queue '${QUEUE_NAME}' exists"
else
  fail "Storage queue '${QUEUE_NAME}' not found in account '${STORAGE_ACCOUNT}'"
fi

# ==========================================================================
# 4. Container Registry + image
# ==========================================================================
section "4. Container Registry and image"

ACR_STATE=$(az acr show \
  --name "${ACR_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query "provisioningState" -o tsv 2>/dev/null || echo "NOT_FOUND")
if [[ "$ACR_STATE" == "Succeeded" ]]; then
  pass "Container Registry '${ACR_NAME}' — provisioningState: Succeeded"
else
  fail "Container Registry '${ACR_NAME}' — expected Succeeded, got: ${ACR_STATE}"
fi

# Check image/tag from postprovision hook: squad-agent:latest
IMAGE_REPO="${IMAGE_TAG%%:*}"
IMAGE_VER="${IMAGE_TAG##*:}"
IMAGE_EXISTS=$(az acr repository show-tags \
  --name "${ACR_NAME}" \
  --repository "${IMAGE_REPO}" \
  --query "contains(@, '${IMAGE_VER}')" -o tsv 2>/dev/null || echo "false")
if [[ "$IMAGE_EXISTS" == "true" ]]; then
  pass "ACR image '${IMAGE_TAG}' is present in registry"
else
  fail "ACR image '${IMAGE_TAG}' not found — run postprovision hook (az acr build) to push it"
fi

# ==========================================================================
# 5. User-Assigned Managed Identity + role assignments
# ==========================================================================
section "5. User-Assigned Managed Identity and role assignments"

UAMI_JSON=$(az identity show \
  --name "${IDENTITY_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query "{principalId:principalId,clientId:clientId,id:id}" \
  -o json 2>/dev/null || echo "null")

if [[ "$UAMI_JSON" == "null" ]]; then
  fail "UAMI '${IDENTITY_NAME}' not found in resource group '${RESOURCE_GROUP}'"
else
  pass "UAMI '${IDENTITY_NAME}' exists"
  UAMI_PRINCIPAL_ID=$(echo "$UAMI_JSON" | grep '"principalId"' | sed 's/.*: *"\([^"]*\)".*/\1/')
  UAMI_ACTUAL_RID=$(echo "$UAMI_JSON" | grep '"id"' | sed 's/.*: *"\([^"]*\)".*/\1/')

  # Validate UAMI resource ID consistency if provided
  if [[ -n "$UAMI_RESOURCE_ID" ]]; then
    if [[ "${UAMI_ACTUAL_RID,,}" == "${UAMI_RESOURCE_ID,,}" ]]; then
      pass "UAMI resource ID matches azd output"
    else
      fail "UAMI resource ID mismatch — got: ${UAMI_ACTUAL_RID}"
    fi
  fi

  # Helper: check a role assignment on a scope
  check_role() {
    local desc="$1"
    local scope="$2"
    local role_id="$3"
    local assignments
    assignments=$(az role assignment list \
      --assignee "${UAMI_PRINCIPAL_ID}" \
      --scope "${scope}" \
      --query "[?ends_with(roleDefinitionId,'/${role_id}')].roleDefinitionId" \
      -o tsv 2>/dev/null || true)
    if [[ -n "$assignments" ]]; then
      pass "${desc}"
    else
      fail "${desc} — role assignment not found (principal: ${UAMI_PRINCIPAL_ID}, scope: ${scope})"
    fi
  }

  # Get resource IDs for scope-based role check
  SA_RESOURCE_ID=$(az storage account show \
    --name "${STORAGE_ACCOUNT}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "id" -o tsv 2>/dev/null || true)

  ACR_RESOURCE_ID=$(az acr show \
    --name "${ACR_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "id" -o tsv 2>/dev/null || true)

  KV_RESOURCE_ID=$(az keyvault show \
    --name "${KEY_VAULT}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "id" -o tsv 2>/dev/null || true)

  [[ -n "$SA_RESOURCE_ID" ]]  && check_role "UAMI → Storage Queue Data Reader on storage account"      "${SA_RESOURCE_ID}"  "${ROLE_STORAGE_QUEUE_READER}"
  [[ -n "$SA_RESOURCE_ID" ]]  && check_role "UAMI → Storage Queue Data Contributor on storage account" "${SA_RESOURCE_ID}"  "${ROLE_STORAGE_QUEUE_CONTRIBUTOR}"
  [[ -n "$ACR_RESOURCE_ID" ]] && check_role "UAMI → AcrPull on container registry"                     "${ACR_RESOURCE_ID}" "${ROLE_ACR_PULL}"
  [[ -n "$ACR_RESOURCE_ID" ]] && check_role "UAMI → AcrPush on container registry"                     "${ACR_RESOURCE_ID}" "${ROLE_ACR_PUSH}"
  [[ -n "$KV_RESOURCE_ID" ]]  && check_role "UAMI → Key Vault Secrets User on key vault"               "${KV_RESOURCE_ID}"  "${ROLE_KV_SECRETS_USER}"
fi

# ==========================================================================
# 6. Key Vault + expected secrets (names only — never print values)
# ==========================================================================
section "6. Key Vault and secrets"

KV_STATE=$(az keyvault show \
  --name "${KEY_VAULT}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query "properties.provisioningState" -o tsv 2>/dev/null || echo "NOT_FOUND")
if [[ "$KV_STATE" == "Succeeded" ]]; then
  pass "Key Vault '${KEY_VAULT}' — provisioningState: Succeeded"
else
  fail "Key Vault '${KEY_VAULT}' — expected Succeeded, got: ${KV_STATE}"
fi

# RBAC authorization enabled (no legacy access policies)
KV_RBAC=$(az keyvault show \
  --name "${KEY_VAULT}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query "properties.enableRbacAuthorization" -o tsv 2>/dev/null || echo "false")
if [[ "$KV_RBAC" == "true" ]]; then
  pass "Key Vault RBAC authorization is enabled"
else
  fail "Key Vault RBAC authorization — expected true, got: ${KV_RBAC}"
fi

# Check secret NAMES only — never echo values
check_secret() {
  local secret_name="$1"
  local secret_id
  secret_id=$(az keyvault secret show \
    --vault-name "${KEY_VAULT}" \
    --name "${secret_name}" \
    --query "id" -o tsv 2>/dev/null || echo "")
  if [[ -n "$secret_id" ]]; then
    pass "Key Vault secret '${secret_name}' exists (value not displayed)"
  else
    fail "Key Vault secret '${secret_name}' not found in '${KEY_VAULT}' — upload after provision"
  fi
}
check_secret "github-app-private-key"
check_secret "copilot-pat"

# ==========================================================================
# 7. Container Apps environment + Container App Job
# ==========================================================================
section "7. Container Apps environment and job"

CAE_STATE=$(az containerapp env show \
  --name "${ACA_ENV}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query "properties.provisioningState" -o tsv 2>/dev/null || echo "NOT_FOUND")
if [[ "$CAE_STATE" == "Succeeded" ]]; then
  pass "Container Apps environment '${ACA_ENV}' — provisioningState: Succeeded"
else
  fail "Container Apps environment '${ACA_ENV}' — expected Succeeded, got: ${CAE_STATE}"
fi

# Container App Job existence and provisioning state
JOB_JSON=$(az containerapp job show \
  --name "${JOB_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query "{state:properties.provisioningState,trigger:properties.configuration.triggerType}" \
  -o json 2>/dev/null || echo "null")

if [[ "$JOB_JSON" == "null" ]]; then
  fail "Container App Job '${JOB_NAME}' not found in resource group '${RESOURCE_GROUP}'"
else
  JOB_STATE=$(echo "$JOB_JSON" | grep '"state"' | sed 's/.*: *"\([^"]*\)".*/\1/')
  JOB_TRIGGER=$(echo "$JOB_JSON" | grep '"trigger"' | sed 's/.*: *"\([^"]*\)".*/\1/')

  if [[ "$JOB_STATE" == "Succeeded" ]]; then
    pass "Container App Job '${JOB_NAME}' — provisioningState: Succeeded"
  else
    fail "Container App Job '${JOB_NAME}' — expected Succeeded, got: ${JOB_STATE}"
  fi

  if [[ "$JOB_TRIGGER" == "Event" ]]; then
    pass "Container App Job trigger type is 'Event' (KEDA event-driven)"
  else
    fail "Container App Job trigger type — expected Event, got: ${JOB_TRIGGER}"
  fi

  # KEDA azure-queue scaler: assert identity is the UAMI resource ID
  KEDA_IDENTITY=$(az containerapp job show \
    --name "${JOB_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "properties.configuration.eventTriggerConfig.scale.rules[?name=='queue-scaling'].identity | [0]" \
    -o tsv 2>/dev/null || echo "")

  if [[ -n "$KEDA_IDENTITY" ]]; then
    if [[ -n "$UAMI_RESOURCE_ID" ]]; then
      if [[ "${KEDA_IDENTITY,,}" == "${UAMI_RESOURCE_ID,,}" ]]; then
        pass "KEDA azure-queue scaler identity matches UAMI resource ID"
      else
        fail "KEDA scaler identity mismatch — expected: ${UAMI_RESOURCE_ID} — got: ${KEDA_IDENTITY}"
      fi
    else
      pass "KEDA azure-queue scaler has an identity set: ${KEDA_IDENTITY}"
    fi
  else
    fail "KEDA azure-queue scaler identity not set on job '${JOB_NAME}' (expected UAMI resource ID)"
  fi

  # ACR registry identity on the job
  JOB_REG_IDENTITY=$(az containerapp job show \
    --name "${JOB_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "properties.configuration.registries[0].identity" \
    -o tsv 2>/dev/null || echo "")

  if [[ -n "$JOB_REG_IDENTITY" ]]; then
    pass "Container App Job ACR registry pull uses identity (not admin credentials)"
  else
    fail "Container App Job registry identity not configured — job cannot pull from ACR"
  fi
fi

# ==========================================================================
# 8. Optional: trigger a single job execution and assert it starts
# ==========================================================================
if [[ "$RUN_JOB" == "true" ]]; then
  section "8. Job execution test (OPT-IN)"
  echo -e "  ${YELLOW}Triggering a single job execution — this costs one Container App Job run.${NC}"

  EXEC_NAME=$(az containerapp job start \
    --name "${JOB_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "name" -o tsv 2>/dev/null || echo "")

  if [[ -z "$EXEC_NAME" ]]; then
    fail "Failed to start job execution for '${JOB_NAME}'"
  else
    echo "  Job execution started: ${EXEC_NAME}"
    echo "  Waiting up to ${JOB_TIMEOUT}s for completion..."

    ELAPSED=0
    EXEC_STATUS=""
    while [[ $ELAPSED -lt $JOB_TIMEOUT ]]; do
      EXEC_STATUS=$(az containerapp job execution show \
        --name "${JOB_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --job-execution-name "${EXEC_NAME}" \
        --query "properties.status" -o tsv 2>/dev/null || echo "Unknown")
      case "$EXEC_STATUS" in
        Succeeded|Running) break ;;
        Failed|Stopped)    break ;;
      esac
      sleep 10
      ELAPSED=$((ELAPSED + 10))
    done

    case "$EXEC_STATUS" in
      Succeeded) pass "Job execution '${EXEC_NAME}' — Succeeded" ;;
      Running)   pass "Job execution '${EXEC_NAME}' — Running (still active, not failed)" ;;
      Failed)    fail "Job execution '${EXEC_NAME}' — Failed (check logs: az containerapp job logs show -n ${JOB_NAME} -g ${RESOURCE_GROUP})" ;;
      Stopped)   fail "Job execution '${EXEC_NAME}' — Stopped unexpectedly" ;;
      *)         fail "Job execution '${EXEC_NAME}' — timed out after ${JOB_TIMEOUT}s (last status: ${EXEC_STATUS})" ;;
    esac
  fi
fi

# ==========================================================================
# Summary
# ==========================================================================
echo ""
echo "=================================================================="
TOTAL=$((PASS_COUNT + FAIL_COUNT))
if [[ $FAIL_COUNT -eq 0 ]]; then
  echo -e "${GREEN} Smoke test: ALL ${TOTAL} assertions PASSED${NC}"
  echo "=================================================================="
  echo ""
  exit 0
else
  echo -e "${RED} Smoke test: ${FAIL_COUNT} FAILED, ${PASS_COUNT} passed (${TOTAL} total)${NC}"
  echo "=================================================================="
  echo ""
  echo "Troubleshooting:"
  echo "  Logs:     az containerapp job logs show -n ${JOB_NAME} -g ${RESOURCE_GROUP}"
  echo "  Details:  az containerapp job show -n ${JOB_NAME} -g ${RESOURCE_GROUP}"
  echo "  Teardown: azd down --purge"
  echo ""
  exit 1
fi
