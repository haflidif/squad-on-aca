# ---------------------------------------------------------------------------
# Squad on ACA — azd preprovision hook (PowerShell / Windows)
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
$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "=== Squad on ACA — pre-provision checks ===" -ForegroundColor Cyan
Write-Host ""

$missing = 0

# ---------------------------------------------------------------------------
# Validate required env vars
# ---------------------------------------------------------------------------
if (-not $env:GITHUB_APP_ID) {
    Write-Host "✗ GITHUB_APP_ID is not set." -ForegroundColor Red
    Write-Host "  Run:  azd env set GITHUB_APP_ID <your-numeric-app-id>"
    $missing++
} else {
    Write-Host "✓ GITHUB_APP_ID = $($env:GITHUB_APP_ID)" -ForegroundColor Green
}

if (-not $env:GITHUB_APP_INSTALLATION_ID) {
    Write-Host "✗ GITHUB_APP_INSTALLATION_ID is not set." -ForegroundColor Red
    Write-Host "  Run:  azd env set GITHUB_APP_INSTALLATION_ID <your-installation-id>"
    $missing++
} else {
    Write-Host "✓ GITHUB_APP_INSTALLATION_ID = $($env:GITHUB_APP_INSTALLATION_ID)" -ForegroundColor Green
}

if (-not $env:AZURE_PRINCIPAL_ID) {
    Write-Host "✗ AZURE_PRINCIPAL_ID is not set." -ForegroundColor Red
    Write-Host "  This is normally injected by azd.  Ensure you are logged in: azd auth login"
    $missing++
} else {
    Write-Host "✓ AZURE_PRINCIPAL_ID (deployerPrincipalId) = $($env:AZURE_PRINCIPAL_ID)" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Optional: TARGET_REPOS guidance
# ---------------------------------------------------------------------------
if (-not $env:TARGET_REPOS) {
    Write-Host ""
    Write-Host "ℹ TARGET_REPOS is not set — federated OIDC credentials will not be wired." -ForegroundColor Yellow
    Write-Host "  To wire OIDC for a repo, run:"
    Write-Host '    azd env set TARGET_REPOS "[""owner/repo""]"'
    Write-Host "  You can set this after the initial deploy and re-run 'azd provision'."
} else {
    Write-Host "✓ TARGET_REPOS = $($env:TARGET_REPOS)" -ForegroundColor Green
}

Write-Host ""

if ($missing -gt 0) {
    Write-Host "Pre-provision failed: $missing required variable(s) not set." -ForegroundColor Red
    Write-Host "Set the missing variables with 'azd env set' and re-run 'azd up'."
    exit 1
}

Write-Host "Pre-provision checks passed.  Proceeding to 'azd provision'..." -ForegroundColor Green
Write-Host ""
