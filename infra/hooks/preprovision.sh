#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Squad on ACA — azd preprovision hook (bash / Linux & macOS)
#
# Runs before `azd provision`.  Validates that required azd env vars are set
# and prints guidance for anything missing.  Does NOT prompt interactively —
# operators set values with `azd env set` before running `azd up`.
#
# Required azd env vars (set via `azd env set <KEY> <VALUE>`):
#   GITHUB_APP_ID               — numeric GitHub App ID
#   GITHUB_APP_INSTALLATION_ID  — numeric installation ID
#
# Optional azd env vars:
#   TARGET_REPOS  — JSON array of "owner/repo" strings,
#                   e.g. '["haflidif/squad-on-aca"]'
#                   Defaults to [] in Bicep (federated OIDC not wired).
#
# AZURE_PRINCIPAL_ID is injected automatically by azd — maps to
# deployerPrincipalId in main.bicep (grants Key Vault Secrets Officer).
# ---------------------------------------------------------------------------
set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

echo ""
echo "=== Squad on ACA — pre-provision checks ==="
echo ""

missing=0

# ---------------------------------------------------------------------------
# Validate required env vars
# ---------------------------------------------------------------------------
if [[ -z "${GITHUB_APP_ID:-}" ]]; then
  echo -e "${RED}✗ GITHUB_APP_ID is not set.${NC}"
  echo "  Run:  azd env set GITHUB_APP_ID <your-numeric-app-id>"
  missing=$((missing + 1))
else
  echo -e "${GREEN}✓ GITHUB_APP_ID${NC} = ${GITHUB_APP_ID}"
fi

if [[ -z "${GITHUB_APP_INSTALLATION_ID:-}" ]]; then
  echo -e "${RED}✗ GITHUB_APP_INSTALLATION_ID is not set.${NC}"
  echo "  Run:  azd env set GITHUB_APP_INSTALLATION_ID <your-installation-id>"
  missing=$((missing + 1))
else
  echo -e "${GREEN}✓ GITHUB_APP_INSTALLATION_ID${NC} = ${GITHUB_APP_INSTALLATION_ID}"
fi

if [[ -z "${AZURE_PRINCIPAL_ID:-}" ]]; then
  echo -e "${RED}✗ AZURE_PRINCIPAL_ID is not set.${NC}"
  echo "  This is normally injected by azd.  Ensure you are logged in: azd auth login"
  missing=$((missing + 1))
else
  echo -e "${GREEN}✓ AZURE_PRINCIPAL_ID${NC} (deployerPrincipalId) = ${AZURE_PRINCIPAL_ID}"
fi

# ---------------------------------------------------------------------------
# Optional: TARGET_REPOS guidance
# ---------------------------------------------------------------------------
if [[ -z "${TARGET_REPOS:-}" ]]; then
  echo ""
  echo -e "${YELLOW}ℹ TARGET_REPOS is not set — federated OIDC credentials will not be wired.${NC}"
  echo "  To wire OIDC for a repo, run:"
  echo "    azd env set TARGET_REPOS '[\"owner/repo\"]'"
  echo "  You can set this after the initial deploy and re-run 'azd provision'."
else
  echo -e "${GREEN}✓ TARGET_REPOS${NC} = ${TARGET_REPOS}"
fi

echo ""

if [[ "$missing" -gt 0 ]]; then
  echo -e "${RED}Pre-provision failed: $missing required variable(s) not set.${NC}"
  echo "Set the missing variables with 'azd env set' and re-run 'azd up'."
  exit 1
fi

echo -e "${GREEN}Pre-provision checks passed.  Proceeding to 'azd provision'...${NC}"
echo ""
