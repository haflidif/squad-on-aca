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

function Invoke-Activation {
    $script = Join-Path $PSScriptRoot '..\..\scripts\activate.cjs'
    $arguments = @($script, '--azd')
    if ($env:SQUAD_ACTIVATION_TARGET) { $arguments += @('--target', $env:SQUAD_ACTIVATION_TARGET) }
    else { $arguments += '--preview' }
    node @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Descriptor activation failed. Resolve the reported missing fields; execution remains unchanged.' }
}

$Backend = Resolve-AzdOutput 'EXECUTION_BACKEND'
if (-not $Backend) { $Backend = if (Test-Path Env:\SQUAD_EXECUTION_BACKEND) { $env:SQUAD_EXECUTION_BACKEND } else { 'jobs' } }
if ($Backend -cnotin @('jobs', 'sandbox')) { throw 'Execution backend must be jobs or sandbox.' }
if ((Test-Path Env:\SQUAD_EXECUTION_BACKEND) -and $Backend -cne $env:SQUAD_EXECUTION_BACKEND) {
    throw 'Requested backend differs from deployed backend. Reconcile the destination before post-provision setup.'
}
if ($Backend -ceq 'sandbox') {
    Write-Host 'Sandbox infrastructure provisioned. Use the published immutable worker image and platformDescriptor output for separate repository onboarding.'
    Write-Host 'Skipping Jobs image build, Job update, Key Vault/PAT checks, and legacy queue repository variables. Execution has not been enabled.'
    Invoke-Activation
    exit 0
}
$JobsImageRef = Resolve-AzdOutput 'JOBS_IMAGE_REF'

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
if (-not $JobsImageRef) {
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

# Update the Container App Job to use the real image now that it is in ACR.
# On initial provision the job starts with a public placeholder image (see
# infra/bicep/modules/container-app-job.bicep); this step wires in the real image.
if ($AgentJobName -and $ResourceGroupName) {
    Write-Host "Updating Container App Job image to ${AcrLoginServer}/squad-agent:latest ..."
    try {
        az containerapp job update `
            --name $AgentJobName `
            --resource-group $ResourceGroupName `
            --image "${AcrLoginServer}/squad-agent:latest" `
            --only-show-errors 2>&1 | Out-Null
        Write-Host "✓ Container App Job image updated" -ForegroundColor Green
    } catch {
        Write-Host "Warning: Could not update job image — run manually:" -ForegroundColor Yellow
        Write-Host "  az containerapp job update --name $AgentJobName --resource-group $ResourceGroupName --image ${AcrLoginServer}/squad-agent:latest"
    }
}
Write-Host ""

# ---------------------------------------------------------------------------
} else {
    Write-Host 'Using the pinned Jobs image from provisioning; skipping latest image build and Job update.'
}

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

Invoke-Activation
