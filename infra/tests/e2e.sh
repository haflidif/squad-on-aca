#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Squad on ACA — end-to-end ephemeral deploy loop (bash)
#
# Orchestrates: azd provision → smoke-test → azd down (always).
# Teardown runs in a trap so it executes even if smoke-test fails.
#
# ⚠ REAL AZURE COSTS: This script deploys live Azure resources.
# Resources are torn down when the script exits.  You are responsible for
# any charges incurred during the run.
#
# Usage:
#   ./infra/tests/e2e.sh [OPTIONS]
#
# Required (deploy mode):
#   --deploy                         REQUIRED to actually deploy. Absent = dry-run only.
#   -e, --env <name>                 azd environment name (e.g. ephemeral-test).
#   -s, --subscription <id>          Azure subscription ID (or AZURE_SUBSCRIPTION_ID).
#   -l, --location <region>          Azure region (default: swedencentral).
#
# azd env parameters (passed to `azd env set` before provision):
#       --github-app-id <id>         GitHub App ID (or GITHUB_APP_ID).
#       --github-installation-id <id> GitHub App Installation ID.
#       --deployer-principal-id <id> Deployer object ID.
#       --deployer-type <type>       User | ServicePrincipal (default: User).
#
# Optional:
#       --run-job                    OPT-IN: trigger one job execution in smoke-test.
#       --job-timeout <secs>         Max seconds for job execution wait (default: 120).
#       --no-purge                   Skip --purge on `azd down` (keep soft-deleted KV).
#       --skip-teardown              Do NOT run `azd down` after test (debug mode).
#   -h, --help                       Show this help and exit.
#
# Examples:
#   # Dry-run (what-if only, no deploy):
#   ./infra/tests/e2e.sh --env ephemeral-test --subscription xxx \
#     --github-app-id 123 --github-installation-id 456 \
#     --deployer-principal-id yyy
#
#   # Full loop (REAL DEPLOY):
#   ./infra/tests/e2e.sh --deploy --env ephemeral-test --subscription xxx \
#     --github-app-id 123 --github-installation-id 456 \
#     --deployer-principal-id yyy
#
#   # Full loop + job execution test:
#   ./infra/tests/e2e.sh --deploy --run-job --env ephemeral-test --subscription xxx \
#     --github-app-id 123 --github-installation-id 456 \
#     --deployer-principal-id yyy
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---- Defaults ------------------------------------------------------------
DO_DEPLOY=false
AZD_ENV=""
SUBSCRIPTION="${AZURE_SUBSCRIPTION_ID:-}"
LOCATION="${AZURE_LOCATION:-swedencentral}"
GITHUB_APP_ID="${GITHUB_APP_ID:-}"
GITHUB_INSTALLATION_ID="${GITHUB_APP_INSTALLATION_ID:-}"
DEPLOYER_PRINCIPAL_ID="${DEPLOYER_PRINCIPAL_ID:-}"
DEPLOYER_TYPE="User"
RUN_JOB=false
JOB_TIMEOUT=120
PURGE_FLAG="--purge"
SKIP_TEARDOWN=false

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
  exit 1
}

# ---- Argument parsing ----------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy)                   DO_DEPLOY=true;               shift 1 ;;
    -e|--env)                   AZD_ENV="$2";                 shift 2 ;;
    -s|--subscription)          SUBSCRIPTION="$2";            shift 2 ;;
    -l|--location)              LOCATION="$2";                shift 2 ;;
    --github-app-id)            GITHUB_APP_ID="$2";           shift 2 ;;
    --github-installation-id)   GITHUB_INSTALLATION_ID="$2"; shift 2 ;;
    --deployer-principal-id)    DEPLOYER_PRINCIPAL_ID="$2";   shift 2 ;;
    --deployer-type)            DEPLOYER_TYPE="$2";            shift 2 ;;
    --run-job)                  RUN_JOB=true;                  shift 1 ;;
    --job-timeout)              JOB_TIMEOUT="$2";              shift 2 ;;
    --no-purge)                 PURGE_FLAG="";                 shift 1 ;;
    --skip-teardown)            SKIP_TEARDOWN=true;            shift 1 ;;
    -h|--help)                  usage ;;
    *)                          die "Unknown argument: $1. Run with --help." ;;
  esac
done

# ---- Validation ----------------------------------------------------------
[[ -z "$AZD_ENV" ]]               && die "--env is required."
[[ -z "$SUBSCRIPTION" ]]          && die "--subscription / AZURE_SUBSCRIPTION_ID is required."
[[ -z "$GITHUB_APP_ID" ]]         && die "--github-app-id / GITHUB_APP_ID is required."
[[ -z "$GITHUB_INSTALLATION_ID" ]] && die "--github-installation-id / GITHUB_APP_INSTALLATION_ID is required."
[[ -z "$DEPLOYER_PRINCIPAL_ID" ]] && die "--deployer-principal-id / DEPLOYER_PRINCIPAL_ID is required."

for cmd in az azd; do
  command -v "$cmd" &>/dev/null || die "'${cmd}' CLI not found. Install it before running this script."
done

# ---- Teardown trap -------------------------------------------------------
TEARDOWN_DONE=false
PROVISION_COMPLETED=false

teardown() {
  if [[ "$TEARDOWN_DONE" == "true" ]]; then return; fi
  TEARDOWN_DONE=true

  if [[ "$SKIP_TEARDOWN" == "true" ]]; then
    echo -e "${YELLOW}SKIP_TEARDOWN is set — skipping azd down. Clean up manually:${NC}"
    echo "  azd down --environment ${AZD_ENV} ${PURGE_FLAG}"
    return
  fi

  if [[ "$PROVISION_COMPLETED" == "true" ]]; then
    echo ""
    echo -e "${CYAN}=================================================================="
    echo " Teardown — running azd down (always, even on failure)"
    echo -e "==================================================================${NC}"
    echo ""
    cd "${REPO_ROOT}"
    azd down \
      --environment "${AZD_ENV}" \
      --force \
      ${PURGE_FLAG:+${PURGE_FLAG}} \
      || echo -e "${RED}WARNING: azd down failed — manual cleanup required for environment: ${AZD_ENV}${NC}"
    echo ""
    echo -e "${GREEN}Teardown complete.${NC}"
  else
    echo -e "${YELLOW}Provision did not complete — skipping azd down (nothing to clean up).${NC}"
  fi
}
trap teardown EXIT INT TERM

# ---- Banner --------------------------------------------------------------
echo ""
echo "=================================================================="
echo -e "${CYAN} Squad on ACA — End-to-End Test Loop${NC}"
echo "=================================================================="
echo ""
echo "  azd environment   : ${AZD_ENV}"
echo "  Subscription      : ${SUBSCRIPTION}"
echo "  Location          : ${LOCATION}"
echo "  Deploy mode       : ${DO_DEPLOY}"
echo "  Run job test      : ${RUN_JOB}"
echo "  Purge on teardown : ${PURGE_FLAG:-disabled}"
echo "  Skip teardown     : ${SKIP_TEARDOWN}"
echo ""

if [[ "$DO_DEPLOY" != "true" ]]; then
  echo -e "${YELLOW}DRY-RUN MODE: --deploy not specified. Running what-if only.${NC}"
  echo "Pass --deploy to run the full loop (REAL AZURE RESOURCES)."
  echo ""
  bash "${SCRIPT_DIR}/whatif.sh" \
    --subscription         "${SUBSCRIPTION}" \
    --location             "${LOCATION}" \
    --environment          "${AZD_ENV}" \
    --github-app-id        "${GITHUB_APP_ID}" \
    --github-installation-id "${GITHUB_INSTALLATION_ID}" \
    --deployer-principal-id "${DEPLOYER_PRINCIPAL_ID}" \
    --deployer-type         "${DEPLOYER_TYPE}"
  echo ""
  echo "What-if complete. Add --deploy to this command to provision for real."
  TEARDOWN_DONE=true   # nothing to tear down
  exit 0
fi

# ---- Confirmation prompt (interactive only) -----------------------------
if [[ -t 0 ]]; then
  echo -e "${YELLOW}⚠ WARNING: This will deploy REAL Azure resources under subscription:${NC}"
  echo "  ${SUBSCRIPTION}"
  echo ""
  echo "  Costs will be incurred. Resources are torn down at the end."
  echo ""
  read -r -p "Type 'yes' to continue: " CONFIRM
  [[ "$CONFIRM" != "yes" ]] && { echo "Aborted."; TEARDOWN_DONE=true; exit 0; }
  echo ""
fi

# ---- Step 1: configure azd environment ----------------------------------
echo "=================================================================="
echo -e "${CYAN} Step 1: Configure azd environment${NC}"
echo "=================================================================="
echo ""

cd "${REPO_ROOT}"

# Create or refresh the environment
azd env select "${AZD_ENV}" 2>/dev/null \
  || azd env new "${AZD_ENV}" --subscription "${SUBSCRIPTION}" --location "${LOCATION}" --no-prompt

azd env set AZURE_SUBSCRIPTION_ID  "${SUBSCRIPTION}"
azd env set GITHUB_APP_ID          "${GITHUB_APP_ID}"
azd env set GITHUB_APP_INSTALLATION_ID "${GITHUB_INSTALLATION_ID}"
azd env set DEPLOYER_PRINCIPAL_ID  "${DEPLOYER_PRINCIPAL_ID}"
azd env set DEPLOYER_PRINCIPAL_TYPE "${DEPLOYER_TYPE}"
# Enable SecurityControl=ignore tag exemption for e2e runs on policy-restricted tenants (e.g. MCAPS)
azd env set enableSecurityControlExemption "true"

echo -e "${GREEN}azd environment configured.${NC}"
echo ""

# ---- Step 2: azd provision -----------------------------------------------
echo "=================================================================="
echo -e "${CYAN} Step 2: azd provision${NC}"
echo "=================================================================="
echo ""

azd provision --environment "${AZD_ENV}" --no-prompt
PROVISION_COMPLETED=true

echo ""
echo -e "${GREEN}Provision complete.${NC}"
echo ""

# ---- Step 3: smoke-test --------------------------------------------------
echo "=================================================================="
echo -e "${CYAN} Step 3: Smoke test${NC}"
echo "=================================================================="
echo ""

SMOKE_OPTS=()
[[ "$RUN_JOB" == "true" ]] && SMOKE_OPTS+=(--run-job --job-timeout "${JOB_TIMEOUT}")

SMOKE_EXIT=0
bash "${SCRIPT_DIR}/smoke-test.sh" \
  --azd-env "${AZD_ENV}" \
  "${SMOKE_OPTS[@]+"${SMOKE_OPTS[@]}"}" \
  || SMOKE_EXIT=$?

if [[ $SMOKE_EXIT -ne 0 ]]; then
  echo -e "${RED}Smoke test FAILED (exit ${SMOKE_EXIT}). Proceeding to teardown.${NC}"
else
  echo -e "${GREEN}Smoke test PASSED.${NC}"
fi

# ---- Teardown runs via trap ----------------------------------------------
exit $SMOKE_EXIT
