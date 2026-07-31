#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Squad on ACA — Bicep what-if dry run (bash)
#
# Runs `az deployment sub what-if` at subscription scope to preview Bicep
# changes WITHOUT creating or modifying any Azure resources.
#
# Usage:
#   ./infra/tests/whatif.sh [OPTIONS]
#
# Required (flag or env var):
#   -s, --subscription <id>            Azure subscription ID (or AZURE_SUBSCRIPTION_ID)
#       --github-app-id <id>           GitHub App ID (or GITHUB_APP_ID)
#       --github-installation-id <id>  GitHub App Installation ID (or GITHUB_APP_INSTALLATION_ID)
#       --deployer-principal-id <id>   Deployer object ID (or DEPLOYER_PRINCIPAL_ID)
#                                      Get with: az ad signed-in-user show --query id -o tsv
#
# Optional:
#   -l, --location <region>    Azure region (default: swedencentral, or AZURE_LOCATION)
#   -e, --environment <name>   Environment name (default: dev, or AZURE_ENV_NAME)
#   -p, --project <name>       Project name (default: squad-aca)
#       --deployer-type <type> User | ServicePrincipal | Group (default: User)
#       --name-suffix <suffix> Override 8-char name suffix (default: auto-derived)
#   -h, --help                 Show this help and exit
#
# Examples:
#   # Minimal — required params only:
#   AZURE_SUBSCRIPTION_ID=xxx GITHUB_APP_ID=123 \
#     GITHUB_APP_INSTALLATION_ID=456 DEPLOYER_PRINCIPAL_ID=yyy \
#     ./infra/tests/whatif.sh
#
#   # All flags explicit:
#   ./infra/tests/whatif.sh \
#     --subscription xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
#     --location swedencentral \
#     --environment dev \
#     --github-app-id 123456 \
#     --github-installation-id 789012 \
#     --deployer-principal-id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# ---------------------------------------------------------------------------
set -euo pipefail

# Resolve script and repo root paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEMPLATE_FILE="${REPO_ROOT}/infra/bicep/main.bicep"
PARAMS_FILE="${REPO_ROOT}/infra/bicep/main.bicepparam"

# ---- Defaults (env-var overrides first, flags second) --------------------
SUBSCRIPTION="${AZURE_SUBSCRIPTION_ID:-}"
LOCATION="${AZURE_LOCATION:-swedencentral}"
ENVIRONMENT="${AZURE_ENV_NAME:-dev}"
PROJECT_NAME="squad-aca"
GITHUB_APP_ID="${GITHUB_APP_ID:-}"
GITHUB_INSTALLATION_ID="${GITHUB_APP_INSTALLATION_ID:-}"
DEPLOYER_PRINCIPAL_ID="${DEPLOYER_PRINCIPAL_ID:-}"
DEPLOYER_TYPE="User"
NAME_SUFFIX=""

# ---- Helpers -------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -40
  exit 0
}

die() {
  echo -e "${RED}ERROR: $*${NC}" >&2
  exit 1
}

# ---- Argument parsing ----------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--subscription)           SUBSCRIPTION="$2";            shift 2 ;;
    -l|--location)               LOCATION="$2";                shift 2 ;;
    -e|--environment)            ENVIRONMENT="$2";             shift 2 ;;
    -p|--project)                PROJECT_NAME="$2";            shift 2 ;;
    --github-app-id)             GITHUB_APP_ID="$2";           shift 2 ;;
    --github-installation-id)    GITHUB_INSTALLATION_ID="$2";  shift 2 ;;
    --deployer-principal-id)     DEPLOYER_PRINCIPAL_ID="$2";   shift 2 ;;
    --deployer-type)             DEPLOYER_TYPE="$2";            shift 2 ;;
    --name-suffix)               NAME_SUFFIX="$2";              shift 2 ;;
    -h|--help)                   usage ;;
    *)                           die "Unknown argument: $1. Run with --help." ;;
  esac
done

# ---- Validation ----------------------------------------------------------
[[ -z "$SUBSCRIPTION" ]]            && die "--subscription / AZURE_SUBSCRIPTION_ID is required."
[[ -z "$GITHUB_APP_ID" ]]           && die "--github-app-id / GITHUB_APP_ID is required."
[[ -z "$GITHUB_INSTALLATION_ID" ]]  && die "--github-installation-id / GITHUB_APP_INSTALLATION_ID is required."
[[ -z "$DEPLOYER_PRINCIPAL_ID" ]]   && die "--deployer-principal-id / DEPLOYER_PRINCIPAL_ID is required."
[[ ! -f "$TEMPLATE_FILE" ]]         && die "Template not found: ${TEMPLATE_FILE}"
[[ ! -f "$PARAMS_FILE" ]]           && die "Parameter file not found: ${PARAMS_FILE}"

case "$DEPLOYER_TYPE" in
  User|ServicePrincipal|Group) ;;
  *) die "--deployer-type must be User, ServicePrincipal, or Group (got: ${DEPLOYER_TYPE})" ;;
esac

# ---- Build extra params array -------------------------------------------
EXTRA_PARAMS=()
if [[ -n "$NAME_SUFFIX" ]]; then
  EXTRA_PARAMS+=("nameSuffix=${NAME_SUFFIX}")
fi

# ---- Banner --------------------------------------------------------------
echo ""
echo "=================================================================="
echo -e "${CYAN} Squad on ACA — Bicep what-if dry run${NC}"
echo "=================================================================="
echo ""
echo "  Subscription   : ${SUBSCRIPTION}"
echo "  Location       : ${LOCATION}"
echo "  Environment    : ${ENVIRONMENT}"
echo "  Project        : ${PROJECT_NAME}"
echo "  Deployer type  : ${DEPLOYER_TYPE}"
echo "  Template       : ${TEMPLATE_FILE}"
echo "  Params file    : ${PARAMS_FILE}"
echo ""
echo -e "  ${GREEN}NOTE: This is a DRY RUN — no resources will be created or modified.${NC}"
echo ""

# ---- Run what-if ---------------------------------------------------------
az deployment sub what-if \
  --subscription  "${SUBSCRIPTION}" \
  --location      "${LOCATION}" \
  --template-file "${TEMPLATE_FILE}" \
  --parameters    "${PARAMS_FILE}" \
  --parameters \
    "githubAppId=${GITHUB_APP_ID}" \
    "githubAppInstallationId=${GITHUB_INSTALLATION_ID}" \
    "deployerPrincipalId=${DEPLOYER_PRINCIPAL_ID}" \
    "deployerPrincipalType=${DEPLOYER_TYPE}" \
    "environment=${ENVIRONMENT}" \
    "projectName=${PROJECT_NAME}" \
    "${EXTRA_PARAMS[@]+"${EXTRA_PARAMS[@]}"}" \
  --result-format FullResourcePayloads

echo ""
echo "=================================================================="
echo -e "${GREEN} What-if complete — review the diff above before deploying.${NC}"
echo "=================================================================="
echo ""
echo "To deploy for real, run:"
echo "  azd up                                     # azd / Bicep path"
echo "  cd infra/terraform && terraform apply       # Terraform path"
echo ""
