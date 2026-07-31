# ---------------------------------------------------------------------------
# Squad on ACA — end-to-end ephemeral deploy loop (PowerShell)
#
# Orchestrates: azd provision → smoke-test → azd down (always).
# Teardown runs in a try/finally so it executes even if smoke-test fails.
#
# ⚠ REAL AZURE COSTS: This script deploys live Azure resources.
# Resources are torn down when the script exits.  You are responsible for
# any charges incurred during the run.
#
# Usage:
#   .\infra\tests\e2e.ps1 [OPTIONS]
#
# Required (deploy mode):
#   -Deploy                          REQUIRED to actually deploy. Absent = dry-run only.
#   -Env <name>                      azd environment name (e.g. ephemeral-test).
#   -Subscription <id>               Azure subscription ID (or $env:AZURE_SUBSCRIPTION_ID).
#   -Location <region>               Azure region (default: swedencentral).
#
# azd env parameters:
#   -GithubAppId <id>                GitHub App ID (or $env:GITHUB_APP_ID).
#   -GithubInstallationId <id>       GitHub App Installation ID.
#   -DeployerPrincipalId <id>        Deployer object ID.
#   -DeployerType <type>             User | ServicePrincipal (default: User).
#
# Optional:
#   -RunJob                          OPT-IN: trigger one job execution in smoke-test.
#   -JobTimeout <secs>               Max seconds for job execution wait (default: 120).
#   -NoPurge                         Skip --purge on `azd down` (keep soft-deleted KV).
#   -SkipTeardown                    Do NOT run `azd down` after test (debug mode).
#
# Examples:
#   # Dry-run (what-if only, no deploy):
#   .\infra\tests\e2e.ps1 -Env ephemeral-test -Subscription xxx `
#     -GithubAppId 123 -GithubInstallationId 456 -DeployerPrincipalId yyy
#
#   # Full loop (REAL DEPLOY):
#   .\infra\tests\e2e.ps1 -Deploy -Env ephemeral-test -Subscription xxx `
#     -GithubAppId 123 -GithubInstallationId 456 -DeployerPrincipalId yyy
#
#   # Full loop + job execution test:
#   .\infra\tests\e2e.ps1 -Deploy -RunJob -Env ephemeral-test -Subscription xxx `
#     -GithubAppId 123 -GithubInstallationId 456 -DeployerPrincipalId yyy
# ---------------------------------------------------------------------------
#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch] $Deploy,
    [string] $Env                  = '',
    [string] $Subscription         = $env:AZURE_SUBSCRIPTION_ID,
    [string] $Location             = $(if ($env:AZURE_LOCATION) { $env:AZURE_LOCATION } else { 'swedencentral' }),
    [string] $GithubAppId          = $env:GITHUB_APP_ID,
    [string] $GithubInstallationId = $env:GITHUB_APP_INSTALLATION_ID,
    [string] $DeployerPrincipalId  = $env:DEPLOYER_PRINCIPAL_ID,
    [ValidateSet('User','ServicePrincipal','Group')]
    [string] $DeployerType         = 'User',
    [switch] $RunJob,
    [int]    $JobTimeout           = 120,
    [switch] $NoPurge,
    [switch] $SkipTeardown
)
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path

# ---- Helpers -------------------------------------------------------------
function Exit-Error([string]$msg) {
    Write-Host "ERROR: $msg" -ForegroundColor Red
    exit 1
}

# ---- Validation ----------------------------------------------------------
if (-not $Env)                  { Exit-Error "-Env is required." }
if (-not $Subscription)         { Exit-Error "-Subscription / AZURE_SUBSCRIPTION_ID is required." }
if (-not $GithubAppId)          { Exit-Error "-GithubAppId / GITHUB_APP_ID is required." }
if (-not $GithubInstallationId) { Exit-Error "-GithubInstallationId / GITHUB_APP_INSTALLATION_ID is required." }
if (-not $DeployerPrincipalId)  { Exit-Error "-DeployerPrincipalId / DEPLOYER_PRINCIPAL_ID is required." }

foreach ($cmd in 'az', 'azd') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Exit-Error "'$cmd' CLI not found. Install it before running this script."
    }
}

$PurgeFlag = if ($NoPurge) { @() } else { @('--purge') }

# ---- Banner --------------------------------------------------------------
Write-Host ""
Write-Host "=================================================================="  -ForegroundColor Cyan
Write-Host " Squad on ACA — End-to-End Test Loop"                               -ForegroundColor Cyan
Write-Host "=================================================================="  -ForegroundColor Cyan
Write-Host ""
Write-Host "  azd environment   : $Env"
Write-Host "  Subscription      : $Subscription"
Write-Host "  Location          : $Location"
Write-Host "  Deploy mode       : $Deploy"
Write-Host "  Run job test      : $RunJob"
Write-Host "  Purge on teardown : $(-not $NoPurge)"
Write-Host "  Skip teardown     : $SkipTeardown"
Write-Host ""

# ---- Dry-run mode --------------------------------------------------------
if (-not $Deploy) {
    Write-Host "DRY-RUN MODE: -Deploy not specified. Running what-if only." -ForegroundColor Yellow
    Write-Host "Pass -Deploy to run the full loop (REAL AZURE RESOURCES)."
    Write-Host ""

    $whatifScript = Join-Path $ScriptDir 'whatif.ps1'
    & $whatifScript `
        -Subscription         $Subscription `
        -Location             $Location `
        -Environment          $Env `
        -GithubAppId          $GithubAppId `
        -GithubInstallationId $GithubInstallationId `
        -DeployerPrincipalId  $DeployerPrincipalId `
        -DeployerType         $DeployerType

    Write-Host ""
    Write-Host "What-if complete. Add -Deploy to this command to provision for real."
    exit 0
}

# ---- Confirmation prompt (interactive only) -----------------------------
if ([System.Environment]::UserInteractive -and [Console]::IsInputRedirected -eq $false) {
    Write-Host "WARNING: This will deploy REAL Azure resources under subscription:" -ForegroundColor Yellow
    Write-Host "  $Subscription"
    Write-Host ""
    Write-Host "  Costs will be incurred. Resources are torn down at the end."
    Write-Host ""
    $confirm = Read-Host "Type 'yes' to continue"
    if ($confirm -ne 'yes') {
        Write-Host "Aborted."
        exit 0
    }
    Write-Host ""
}

# ---- Track provision state for teardown ---------------------------------
$ProvisionCompleted = $false
$SmokeExitCode      = 0

try {
    # ---- Step 1: configure azd environment --------------------------------
    Write-Host "=================================================================="  -ForegroundColor Cyan
    Write-Host " Step 1: Configure azd environment"                                  -ForegroundColor Cyan
    Write-Host "=================================================================="  -ForegroundColor Cyan
    Write-Host ""

    Push-Location $RepoRoot
    try {
        # Select existing env or create new
        azd env select $Env 2>$null
        if ($LASTEXITCODE -ne 0) {
            azd env new $Env --subscription $Subscription --location $Location --no-prompt
        }

        azd env set AZURE_SUBSCRIPTION_ID          $Subscription
        azd env set GITHUB_APP_ID                  $GithubAppId
        azd env set GITHUB_APP_INSTALLATION_ID     $GithubInstallationId
        azd env set DEPLOYER_PRINCIPAL_ID          $DeployerPrincipalId
        azd env set DEPLOYER_PRINCIPAL_TYPE        $DeployerType
        # Enable SecurityControl=ignore tag exemption for e2e runs on policy-restricted tenants (e.g. MCAPS)
        azd env set enableSecurityControlExemption "true"

        Write-Host "azd environment configured." -ForegroundColor Green
        Write-Host ""

        # ---- Step 2: azd provision ----------------------------------------
        Write-Host "=================================================================="  -ForegroundColor Cyan
        Write-Host " Step 2: azd provision"                                              -ForegroundColor Cyan
        Write-Host "=================================================================="  -ForegroundColor Cyan
        Write-Host ""

        azd provision --environment $Env --no-prompt
        if ($LASTEXITCODE -ne 0) {
            throw "azd provision failed with exit code $LASTEXITCODE"
        }
        $ProvisionCompleted = $true

        Write-Host ""
        Write-Host "Provision complete." -ForegroundColor Green
        Write-Host ""

        # ---- Step 3: smoke-test -------------------------------------------
        Write-Host "=================================================================="  -ForegroundColor Cyan
        Write-Host " Step 3: Smoke test"                                                 -ForegroundColor Cyan
        Write-Host "=================================================================="  -ForegroundColor Cyan
        Write-Host ""

        $smokeScript = Join-Path $ScriptDir 'smoke-test.ps1'
        $smokeArgs   = @('-AzdEnv', $Env)
        if ($RunJob)    { $smokeArgs += @('-RunJob', '-JobTimeout', $JobTimeout) }

        & $smokeScript @smokeArgs
        $SmokeExitCode = $LASTEXITCODE

        if ($SmokeExitCode -ne 0) {
            Write-Host "Smoke test FAILED (exit $SmokeExitCode). Proceeding to teardown." -ForegroundColor Red
        } else {
            Write-Host "Smoke test PASSED." -ForegroundColor Green
        }
    } finally {
        Pop-Location
    }
} finally {
    # ---- Teardown (always) ------------------------------------------------
    if ($SkipTeardown) {
        Write-Host ""
        Write-Host "SKIP_TEARDOWN is set — skipping azd down. Clean up manually:" -ForegroundColor Yellow
        Write-Host "  azd down --environment $Env --force $($PurgeFlag -join ' ')"
    } elseif ($ProvisionCompleted) {
        Write-Host ""
        Write-Host "=================================================================="  -ForegroundColor Cyan
        Write-Host " Teardown — running azd down (always, even on failure)"             -ForegroundColor Cyan
        Write-Host "=================================================================="  -ForegroundColor Cyan
        Write-Host ""

        Push-Location $RepoRoot
        try {
            $downArgs = @('down', '--environment', $Env, '--force') + $PurgeFlag
            az @downArgs 2>&1 | Out-Null   # suppress but continue
            azd @downArgs
            if ($LASTEXITCODE -ne 0) {
                Write-Host "WARNING: azd down failed — manual cleanup required for environment: $Env" -ForegroundColor Red
            } else {
                Write-Host "Teardown complete." -ForegroundColor Green
            }
        } catch {
            Write-Host "WARNING: azd down threw an exception — manual cleanup required for: $Env" -ForegroundColor Red
        } finally {
            Pop-Location
        }
    } else {
        Write-Host "Provision did not complete — skipping azd down (nothing to clean up)." -ForegroundColor Yellow
    }
}

exit $SmokeExitCode
