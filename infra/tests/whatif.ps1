# ---------------------------------------------------------------------------
# Squad on ACA — Bicep what-if dry run (PowerShell)
#
# Runs `az deployment sub what-if` at subscription scope to preview Bicep
# changes WITHOUT creating or modifying any Azure resources.
#
# Usage:
#   .\infra\tests\whatif.ps1 [OPTIONS]
#
# Required (flag or env var):
#   -Subscription          <id>    Azure subscription ID (or $env:AZURE_SUBSCRIPTION_ID)
#   -GithubAppId           <id>    GitHub App ID (or $env:GITHUB_APP_ID)
#   -GithubInstallationId  <id>    GitHub App Installation ID (or $env:GITHUB_APP_INSTALLATION_ID)
#   -DeployerPrincipalId   <id>    Deployer object ID (or $env:DEPLOYER_PRINCIPAL_ID)
#                                  Get with: az ad signed-in-user show --query id -o tsv
#
# Optional:
#   -Location      <region>   Azure region (default: swedencentral, or $env:AZURE_LOCATION)
#   -Environment   <name>     Environment name (default: dev, or $env:AZURE_ENV_NAME)
#   -ProjectName   <name>     Project name (default: squad-aca)
#   -DeployerType  <type>     User | ServicePrincipal | Group (default: User)
#   -NameSuffix    <suffix>   Override 8-char name suffix (default: auto-derived)
#
# Examples:
#   # Minimal — required params only:
#   $env:AZURE_SUBSCRIPTION_ID = 'xxx'; $env:GITHUB_APP_ID = '123'
#   $env:GITHUB_APP_INSTALLATION_ID = '456'; $env:DEPLOYER_PRINCIPAL_ID = 'yyy'
#   .\infra\tests\whatif.ps1
#
#   # All flags explicit:
#   .\infra\tests\whatif.ps1 `
#     -Subscription        'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' `
#     -Location            'swedencentral' `
#     -Environment         'dev' `
#     -GithubAppId         '123456' `
#     -GithubInstallationId '789012' `
#     -DeployerPrincipalId 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
# ---------------------------------------------------------------------------
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $Subscription        = $env:AZURE_SUBSCRIPTION_ID,
    [string] $Location            = $(if ($env:AZURE_LOCATION)  { $env:AZURE_LOCATION }  else { 'swedencentral' }),
    [string] $Environment         = $(if ($env:AZURE_ENV_NAME)  { $env:AZURE_ENV_NAME }  else { 'dev' }),
    [string] $ProjectName         = 'squad-aca',
    [string] $GithubAppId         = $env:GITHUB_APP_ID,
    [string] $GithubInstallationId = $env:GITHUB_APP_INSTALLATION_ID,
    [string] $DeployerPrincipalId = $env:DEPLOYER_PRINCIPAL_ID,
    [ValidateSet('User','ServicePrincipal','Group')]
    [string] $DeployerType        = 'User',
    [string] $NameSuffix          = ''
)
$ErrorActionPreference = 'Stop'

# ---- Resolve paths -------------------------------------------------------
$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot     = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$TemplateFile = Join-Path $RepoRoot 'infra\bicep\main.bicep'
$ParamsFile   = Join-Path $RepoRoot 'infra\bicep\main.bicepparam'

# ---- Validation ----------------------------------------------------------
function Assert-Required {
    param([string]$Value, [string]$Name)
    if (-not $Value) {
        Write-Host "ERROR: $Name is required." -ForegroundColor Red
        exit 1
    }
}

Assert-Required $Subscription         '-Subscription / AZURE_SUBSCRIPTION_ID'
Assert-Required $GithubAppId          '-GithubAppId / GITHUB_APP_ID'
Assert-Required $GithubInstallationId '-GithubInstallationId / GITHUB_APP_INSTALLATION_ID'
Assert-Required $DeployerPrincipalId  '-DeployerPrincipalId / DEPLOYER_PRINCIPAL_ID'

if (-not (Test-Path $TemplateFile)) {
    Write-Host "ERROR: Template not found: $TemplateFile" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $ParamsFile)) {
    Write-Host "ERROR: Parameter file not found: $ParamsFile" -ForegroundColor Red
    exit 1
}

# ---- Banner --------------------------------------------------------------
Write-Host ""
Write-Host "=================================================================="  -ForegroundColor Cyan
Write-Host " Squad on ACA — Bicep what-if dry run"                              -ForegroundColor Cyan
Write-Host "=================================================================="  -ForegroundColor Cyan
Write-Host ""
Write-Host "  Subscription   : $Subscription"
Write-Host "  Location       : $Location"
Write-Host "  Environment    : $Environment"
Write-Host "  Project        : $ProjectName"
Write-Host "  Deployer type  : $DeployerType"
Write-Host "  Template       : $TemplateFile"
Write-Host "  Params file    : $ParamsFile"
Write-Host ""
Write-Host "  NOTE: This is a DRY RUN — no resources will be created or modified." -ForegroundColor Green
Write-Host ""

# ---- Run what-if ---------------------------------------------------------
# Each override is a separate --parameters flag; joining them into one string
# would cause az to treat the whole blob as a single parameter name.
$azArgs = @(
    'deployment', 'sub', 'what-if',
    '--subscription',  $Subscription,
    '--location',      $Location,
    '--template-file', $TemplateFile,
    '--parameters',    $ParamsFile,
    '--parameters',    "githubAppId=$GithubAppId",
    '--parameters',    "githubAppInstallationId=$GithubInstallationId",
    '--parameters',    "deployerPrincipalId=$DeployerPrincipalId",
    '--parameters',    "deployerPrincipalType=$DeployerType",
    '--parameters',    "environment=$Environment",
    '--parameters',    "projectName=$ProjectName",
    '--parameters',    "enableSecurityControlExemption=true",
    '--result-format', 'FullResourcePayloads'
)
if ($NameSuffix) { $azArgs += @('--parameters', "nameSuffix=$NameSuffix") }

az @azArgs
$rc = $LASTEXITCODE
if ($rc -ne 0) {
    Write-Host ""
    Write-Host "ERROR: what-if failed (exit code $rc)." -ForegroundColor Red
    exit $rc
}

Write-Host ""
Write-Host "=================================================================="  -ForegroundColor Green
Write-Host " What-if complete — review the diff above before deploying."         -ForegroundColor Green
Write-Host "=================================================================="  -ForegroundColor Green
Write-Host ""
Write-Host "To deploy for real, run:"
Write-Host "  azd up                                             # azd / Bicep path"
Write-Host "  cd infra\terraform; terraform apply                # Terraform path"
Write-Host ""
