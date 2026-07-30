# ---------------------------------------------------------------------------
# Squad on ACA — azd postprovision hook (PowerShell / Windows)
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
$ErrorActionPreference = 'Stop'

function Resolve-AzdOutput {
    param([string]$Name)
    $val = [System.Environment]::GetEnvironmentVariable($Name)
    if (-not $val) {
        # Fall back to azd env get-values
        try {
            $lines = azd env get-values 2>$null
            foreach ($line in $lines) {
                if ($line -match "^${Name}=(.*)$") {
                    $val = $Matches[1].Trim('"')
                    break
                }
            }
        } catch { }
    }
    return $val
}

Write-Host ""
Write-Host "===================================================================" -ForegroundColor Cyan
Write-Host " Squad on ACA — post-provision setup" -ForegroundColor Cyan
Write-Host "===================================================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# Resolve Bicep outputs
# ---------------------------------------------------------------------------
$ResourceGroupName    = Resolve-AzdOutput "RESOURCE_GROUP_NAME"
$AcrLoginServer       = Resolve-AzdOutput "ACR_LOGIN_SERVER"
$KeyVaultName         = Resolve-AzdOutput "KEY_VAULT_NAME"
$StorageAccountName   = Resolve-AzdOutput "STORAGE_ACCOUNT_NAME"
$QueueName            = Resolve-AzdOutput "QUEUE_NAME"
$SquadAgentClientId   = Resolve-AzdOutput "SQUAD_AGENT_CLIENT_ID"
$SquadAgentTenantId   = Resolve-AzdOutput "SQUAD_AGENT_TENANT_ID"
$AgentJobName         = Resolve-AzdOutput "AGENT_JOB_NAME"

$AzureSubscriptionId  = $env:AZURE_SUBSCRIPTION_ID
if (-not $AzureSubscriptionId) {
    $AzureSubscriptionId = az account show --query id -o tsv 2>$null
}

if (-not $AcrLoginServer) {
    Write-Host "ERROR: ACR_LOGIN_SERVER output not found.  Cannot build agent image." -ForegroundColor Red
    Write-Host "  Check that 'azd provision' completed successfully."
    exit 1
}

# Derive ACR name (strip .azurecr.io)
$AcrName = $AcrLoginServer -replace '\.azurecr\.io$', ''

Write-Host "Resource Group : $ResourceGroupName" -ForegroundColor Cyan
Write-Host "ACR            : $AcrLoginServer"    -ForegroundColor Cyan
Write-Host "Key Vault      : $KeyVaultName"       -ForegroundColor Cyan
Write-Host "Storage Account: $StorageAccountName" -ForegroundColor Cyan
Write-Host "Queue          : $QueueName"           -ForegroundColor Cyan
Write-Host "CA Job         : $AgentJobName"        -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# A) Build + push squad-agent image
# ---------------------------------------------------------------------------
Write-Host "--- A) Building squad-agent image ---" -ForegroundColor Cyan
Write-Host ""

Write-Host "Importing base images from Docker Hub into ${AcrLoginServer} ..."
Write-Host "  (This avoids Docker Hub rate limits by caching in your ACR)"

Write-Host "  golang:1.23.4-bookworm ..."
try {
    az acr import `
        --name $AcrName `
        --source docker.io/library/golang:1.23.4-bookworm `
        --image base/golang:1.23.4-bookworm `
        --force `
        --only-show-errors 2>&1 | Out-Null
} catch {
    Write-Host "  Warning: Could not import golang base image.  Build may fail if image is not already present." -ForegroundColor Yellow
}

Write-Host "  debian:bookworm-20240701-slim ..."
try {
    az acr import `
        --name $AcrName `
        --source docker.io/library/debian:bookworm-20240701-slim `
        --image base/debian:bookworm-20240701-slim `
        --force `
        --only-show-errors 2>&1 | Out-Null
} catch {
    Write-Host "  Warning: Could not import debian base image.  Build may fail if image is not already present." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Building squad-agent:latest and pushing to ${AcrLoginServer} ..."

az acr build `
    --registry $AcrName `
    --image "squad-agent:latest" `
    --file "agents/base/Dockerfile" `
    --build-arg "BASE_ACR_HOST=${AcrLoginServer}/" `
    "agents/base/" `
    --only-show-errors

Write-Host "✓ squad-agent:latest pushed to $AcrLoginServer" -ForegroundColor Green
Write-Host ""

# ---------------------------------------------------------------------------
# B) Key Vault secret guidance
# ---------------------------------------------------------------------------
Write-Host "--- B) Key Vault secrets ---" -ForegroundColor Cyan
Write-Host ""

function Test-KvSecret {
    param([string]$SecretName)
    try {
        $result = az keyvault secret show `
            --vault-name $KeyVaultName `
            --name $SecretName `
            --query "id" -o tsv `
            --only-show-errors 2>$null
        return ($null -ne $result -and $result -ne "")
    } catch {
        return $false
    }
}

$GhAppKeyMissing   = $false
$CopilotPatMissing = $false

if (-not (Test-KvSecret "github-app-private-key")) {
    $GhAppKeyMissing = $true
    Write-Host "  WARNING: 'github-app-private-key' is NOT set in Key Vault '$KeyVaultName'." -ForegroundColor Yellow
    Write-Host "    Upload your GitHub App private key (.pem file):"
    Write-Host ""
    Write-Host "      az keyvault secret set ``"
    Write-Host "        --vault-name $KeyVaultName ``"
    Write-Host "        --name github-app-private-key ``"
    Write-Host "        --file C:\path\to\your-app.private-key.pem"
    Write-Host ""
} else {
    Write-Host "  ✓ 'github-app-private-key' exists in Key Vault" -ForegroundColor Green
}

if (-not (Test-KvSecret "copilot-pat")) {
    $CopilotPatMissing = $true
    Write-Host "  WARNING: 'copilot-pat' is NOT set in Key Vault '$KeyVaultName'." -ForegroundColor Yellow
    Write-Host "    Upload your GitHub Copilot PAT (with copilot scope):"
    Write-Host ""
    Write-Host "      az keyvault secret set ``"
    Write-Host "        --vault-name $KeyVaultName ``"
    Write-Host "        --name copilot-pat ``"
    Write-Host "        --value '<YOUR_COPILOT_PAT>'"
    Write-Host ""
    Write-Host "    Or from an env var (never echo the value in shell history):"
    Write-Host '      $pat = Read-Host "Copilot PAT" -AsSecureString'
    Write-Host '      $plainPat = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pat))'
    Write-Host "      az keyvault secret set --vault-name $KeyVaultName --name copilot-pat --value `$plainPat"
    Write-Host ""
} else {
    Write-Host "  ✓ 'copilot-pat' exists in Key Vault" -ForegroundColor Green
}

# Note on purge protection: Key Vault is deployed with purge protection DISABLED
# in dev (soft-delete only) for easy teardown via `azd down`.  In production,
# enable purge protection in modules/keyvault.bicep to prevent accidental deletion.
# RBAC propagation may take 1-2 minutes — if secrets upload fails with 403,
# wait a moment and retry.

Write-Host ""

# ---------------------------------------------------------------------------
# C) GitHub Actions repository variables
# ---------------------------------------------------------------------------
Write-Host "--- C) GitHub Actions repository variables ---" -ForegroundColor Cyan
Write-Host ""

$TargetRepos = $env:TARGET_REPOS

if (-not $TargetRepos) {
    Write-Host "TARGET_REPOS is not set — skipping GitHub Actions variable setup." -ForegroundColor Yellow
    Write-Host "  Set it and re-run 'azd provision' to wire the variables:"
    Write-Host '    azd env set TARGET_REPOS "[""owner/repo""]"'
    Write-Host ""
} else {
    # Check gh CLI
    $ghAvailable = $null -ne (Get-Command gh -ErrorAction SilentlyContinue)
    if (-not $ghAvailable) {
        Write-Host "WARNING: 'gh' CLI not found — skipping GitHub Actions variable setup." -ForegroundColor Yellow
        Write-Host "  Install from https://cli.github.com and run: gh auth login"
        Write-Host "  Then re-run 'azd provision' or set the variables manually:"
        Write-Host "    gh variable set SQUAD_AZURE_CLIENT_ID       --body <client_id>    --repo <owner/repo>"
        Write-Host "    gh variable set SQUAD_AZURE_TENANT_ID       --body <tenant_id>    --repo <owner/repo>"
        Write-Host "    gh variable set SQUAD_AZURE_SUBSCRIPTION_ID --body <sub_id>       --repo <owner/repo>"
        Write-Host "    gh variable set SQUAD_STORAGE_ACCOUNT       --body <storage_name> --repo <owner/repo>"
        Write-Host "    gh variable set SQUAD_QUEUE_NAME            --body <queue_name>   --repo <owner/repo>"
    } else {
        $ghAuthed = $null
        try { gh auth status 2>&1 | Out-Null; $ghAuthed = $true } catch { $ghAuthed = $false }
        if (-not $ghAuthed) {
            Write-Host "WARNING: 'gh' CLI is not authenticated — skipping GitHub Actions variable setup." -ForegroundColor Yellow
            Write-Host "  Run:  gh auth login"
            Write-Host "  Then re-run 'azd provision'."
        } else {
            # Parse TARGET_REPOS JSON array: '["owner/repo1","owner/repo2"]'
            $repoList = $TargetRepos -replace '[\[\]\s]', '' -split ',' | ForEach-Object { $_.Trim('"') } | Where-Object { $_ }

            function Set-GhVar {
                param([string]$VarName, [string]$VarValue, [string]$Repo)
                if (-not $VarValue) {
                    Write-Host "    Skipping $VarName — value is empty" -ForegroundColor Yellow
                    return
                }
                try {
                    gh variable set $VarName --body $VarValue --repo $Repo 2>&1 | Out-Null
                    Write-Host "    ✓ $VarName" -ForegroundColor Green
                } catch {
                    Write-Host "    ✗ Failed to set ${VarName} — check repo permissions" -ForegroundColor Red
                }
            }

            foreach ($repo in $repoList) {
                Write-Host "  Setting variables on repo: $repo"
                Set-GhVar "SQUAD_AZURE_CLIENT_ID"       $SquadAgentClientId   $repo
                Set-GhVar "SQUAD_AZURE_TENANT_ID"       $SquadAgentTenantId   $repo
                Set-GhVar "SQUAD_AZURE_SUBSCRIPTION_ID" $AzureSubscriptionId  $repo
                Set-GhVar "SQUAD_STORAGE_ACCOUNT"       $StorageAccountName   $repo
                Set-GhVar "SQUAD_QUEUE_NAME"            $QueueName            $repo
                Write-Host ""
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host "===================================================================" -ForegroundColor Cyan
Write-Host " Post-provision complete." -ForegroundColor Cyan
Write-Host "===================================================================" -ForegroundColor Cyan
Write-Host ""

if ($GhAppKeyMissing -or $CopilotPatMissing) {
    Write-Host "ACTION REQUIRED: Upload missing Key Vault secrets (see instructions above)." -ForegroundColor Yellow
    Write-Host "The agent job will not start until both secrets are present."
    Write-Host ""
}

Write-Host "Useful commands:"
Write-Host "  View job:   az containerapp job show -n $AgentJobName -g $ResourceGroupName"
Write-Host "  Tail logs:  az containerapp job logs show -n $AgentJobName -g $ResourceGroupName"
Write-Host "  Teardown:   azd down --purge"
Write-Host ""

# azd down notes:
# - Key Vault uses soft-delete; `--purge` purges it immediately (dev behaviour).
#   Remove --purge in production or if purge protection is enabled.
# - RBAC propagation on newly created resources may take 1-2 minutes; if the
#   agent job fails with auth errors on first run, wait and retry.
