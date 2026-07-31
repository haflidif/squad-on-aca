# ---------------------------------------------------------------------------
# Squad on ACA — smoke test suite (PowerShell)
#
# Asserts that every resource deployed by infra/bicep/main.bicep exists and
# is healthy.  Run AFTER a successful `azd provision` or `azd up`.
#
# Usage:
#   .\infra\tests\smoke-test.ps1 [OPTIONS]
#
# Discovery modes (choose one):
#   -AzdEnv <name>           Read all resource names from azd env outputs.
#                            Requires `azd` installed and authenticated.
#
#   -ResourceGroup <name>    Resource group name (required in manual mode).
#   -StorageAccount <name>   Storage account name.
#   -QueueName <name>        Queue name (default: squad-work-queue).
#   -AcrName <name>          Container Registry name (without .azurecr.io).
#   -LogAnalytics <name>     Log Analytics workspace name.
#   -KeyVault <name>         Key Vault name.
#   -AcaEnv <name>           Container Apps environment name.
#   -JobName <name>          Container App Job name.
#   -IdentityName <name>     User-Assigned Managed Identity name.
#   -UamiResourceId <id>     UAMI resource ID (for KEDA scaler check).
#
# Optional:
#   -ImageTag <tag>          Expected ACR image tag (default: squad-agent:latest).
#   -RunJob                  OPT-IN: trigger one job execution and assert it
#                            reaches Succeeded/Running within -JobTimeout seconds.
#   -JobTimeout <secs>       Max seconds to wait for job execution (default: 120).
#
# Exit codes:
#   0 — all assertions passed
#   1 — one or more assertions failed
#   2 — prerequisite / argument error
#
# SECURITY: This script NEVER echoes secret values or connection strings.
#           Key Vault checks assert presence of secret NAMES only.
#
# Examples:
#   # azd env mode (easiest after `azd provision`):
#   .\infra\tests\smoke-test.ps1 -AzdEnv dev
#
#   # Manual mode:
#   .\infra\tests\smoke-test.ps1 `
#     -ResourceGroup 'rg-squad-aca-dev-a1b2c3d4' `
#     -StorageAccount 'stSquadacaa1b2c3d4' `
#     -AcrName 'crSquadacaa1b2c3d4' `
#     -LogAnalytics 'law-squad-aca-dev-a1b2c3d4' `
#     -KeyVault 'kv-squad-a1b2c3d4' `
#     -AcaEnv 'cae-squad-aca-dev-a1b2c3d4' `
#     -JobName 'job-squad-agent-a1b2c3d4' `
#     -IdentityName 'id-squad-agent-a1b2c3d4' `
#     -UamiResourceId '/subscriptions/.../...'
#
#   # With optional job trigger:
#   .\infra\tests\smoke-test.ps1 -AzdEnv dev -RunJob -JobTimeout 180
# ---------------------------------------------------------------------------
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $AzdEnv        = '',
    [string] $ResourceGroup = '',
    [string] $StorageAccount = '',
    [string] $QueueName     = 'squad-work-queue',
    [string] $AcrName       = '',
    [string] $LogAnalytics  = '',
    [string] $KeyVault      = '',
    [string] $AcaEnv        = '',
    [string] $JobName       = '',
    [string] $IdentityName  = '',
    [string] $UamiResourceId = '',
    [string] $ImageTag      = 'squad-agent:latest',
    [switch] $RunJob,
    [int]    $JobTimeout    = 120
)
$ErrorActionPreference = 'Stop'

# ---- Counters ------------------------------------------------------------
$PassCount = 0
$FailCount = 0

# ---- Helpers -------------------------------------------------------------
function Write-Pass([string]$msg) {
    Write-Host "  [PASS] $msg" -ForegroundColor Green
    $script:PassCount++
}

function Write-Fail([string]$msg) {
    Write-Host "  [FAIL] $msg" -ForegroundColor Red
    $script:FailCount++
}

function Write-Skip([string]$msg) {
    Write-Host "  [SKIP] $msg" -ForegroundColor Yellow
}

function Write-Section([string]$title) {
    Write-Host ""
    Write-Host "--- $title ---" -ForegroundColor Cyan
}

function Exit-Error([string]$msg) {
    Write-Host "ERROR: $msg" -ForegroundColor Red
    exit 2
}

# ---- Role ID constants (from infra/bicep/main.bicep) --------------------
$RoleStorageQueueReader      = '19e7f393-937e-4f77-808e-94535e297925'
$RoleStorageQueueContributor = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
$RoleAcrPull                 = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
$RoleAcrPush                 = '8311e382-0749-4cb8-b61a-304f252e45ec'
$RoleKvSecretsUser           = '4633458b-17de-408a-b874-0445c86b69e6'

# ---- Prerequisite: az CLI ------------------------------------------------
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Exit-Error "'az' CLI not found. Install from https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
}

# ---- Resolve resource names from azd env ---------------------------------
if ($AzdEnv) {
    if (-not (Get-Command azd -ErrorAction SilentlyContinue)) {
        Exit-Error "'azd' not found but -AzdEnv was specified. Install from https://aka.ms/azd"
    }
    Write-Host "Reading resource names from azd environment: $AzdEnv" -ForegroundColor Cyan

    $azdValues = azd env get-values --environment $AzdEnv 2>$null
    if ($LASTEXITCODE -ne 0) {
        Exit-Error "Failed to read azd env values for environment '$AzdEnv'. Is it provisioned?"
    }

    function Get-AzdValue([string]$key) {
        $line = $azdValues | Where-Object { $_ -match "^${key}=" } | Select-Object -First 1
        if ($line) { return ($line -replace "^${key}=", '').Trim('"') }
        return ''
    }

    if (-not $ResourceGroup)  { $ResourceGroup  = Get-AzdValue 'RESOURCE_GROUP_NAME' }
    if (-not $StorageAccount) { $StorageAccount = Get-AzdValue 'STORAGE_ACCOUNT_NAME' }
    if (-not $QueueName -or $QueueName -eq 'squad-work-queue') {
        $q = Get-AzdValue 'QUEUE_NAME'; if ($q) { $QueueName = $q }
    }
    if (-not $AcaEnv)         { $AcaEnv         = Get-AzdValue 'CONTAINER_APPS_ENVIRONMENT' }
    if (-not $JobName)        { $JobName         = Get-AzdValue 'AGENT_JOB_NAME' }
    if (-not $IdentityName)   { $IdentityName    = Get-AzdValue 'AGENT_IDENTITY_NAME' }
    if (-not $KeyVault)       { $KeyVault        = Get-AzdValue 'KEY_VAULT_NAME' }
    if (-not $UamiResourceId) { $UamiResourceId  = Get-AzdValue 'UAMI_RESOURCE_ID' }

    # ACR name from login server (strip .azurecr.io)
    if (-not $AcrName) {
        $acrServer = Get-AzdValue 'ACR_LOGIN_SERVER'
        if ($acrServer) { $AcrName = $acrServer -replace '\.azurecr\.io$', '' }
    }

    # Log Analytics: not a Bicep output — derive from resource group name
    # rg-squad-aca-dev-XXXXXXXX → law-squad-aca-dev-XXXXXXXX
    if (-not $LogAnalytics -and $ResourceGroup -match '^rg-(.+)$') {
        $LogAnalytics = "law-$($Matches[1])"
    }
}

# ---- Validate required inputs --------------------------------------------
if (-not $ResourceGroup)  { Exit-Error "-ResourceGroup (or -AzdEnv) is required." }
if (-not $StorageAccount) { Exit-Error "-StorageAccount is required in manual mode." }
if (-not $AcrName)        { Exit-Error "-AcrName is required in manual mode." }
if (-not $KeyVault)       { Exit-Error "-KeyVault is required in manual mode." }
if (-not $AcaEnv)         { Exit-Error "-AcaEnv is required in manual mode." }
if (-not $JobName)        { Exit-Error "-JobName is required in manual mode." }
if (-not $IdentityName)   { Exit-Error "-IdentityName is required in manual mode." }

# ---- Banner --------------------------------------------------------------
Write-Host ""
Write-Host "=================================================================="  -ForegroundColor Cyan
Write-Host " Squad on ACA — Smoke Test Suite"                                    -ForegroundColor Cyan
Write-Host "=================================================================="  -ForegroundColor Cyan
Write-Host ""
Write-Host "  Resource group  : $ResourceGroup"
Write-Host "  Storage account : $StorageAccount"
Write-Host "  Queue           : $QueueName"
Write-Host "  ACR             : $AcrName"
Write-Host "  Log Analytics   : $(if ($LogAnalytics) { $LogAnalytics } else { '<not specified>' })"
Write-Host "  Key Vault       : $KeyVault"
Write-Host "  ACA Environment : $AcaEnv"
Write-Host "  CA Job          : $JobName"
Write-Host "  UAMI            : $IdentityName"
Write-Host "  Run job test    : $RunJob"
Write-Host ""

# ==========================================================================
# 1. Resource group
# ==========================================================================
Write-Section "1. Resource group"
try {
    $rgState = az group show --name $ResourceGroup --query "properties.provisioningState" -o tsv 2>$null
    if ($rgState -eq 'Succeeded') {
        Write-Pass "Resource group '$ResourceGroup' exists (provisioningState: Succeeded)"
    } else {
        Write-Fail "Resource group '$ResourceGroup' — expected Succeeded, got: $rgState"
    }
} catch {
    Write-Fail "Resource group '$ResourceGroup' — not found or access denied"
}

# ==========================================================================
# 2. Log Analytics workspace
# ==========================================================================
Write-Section "2. Log Analytics workspace"
if ($LogAnalytics) {
    try {
        $lawState = az monitor log-analytics workspace show `
            --resource-group $ResourceGroup `
            --workspace-name $LogAnalytics `
            --query "provisioningState" -o tsv 2>$null
        if ($lawState -eq 'Succeeded') {
            Write-Pass "Log Analytics workspace '$LogAnalytics' — provisioningState: Succeeded"
        } else {
            Write-Fail "Log Analytics workspace '$LogAnalytics' — expected Succeeded, got: $lawState"
        }
    } catch {
        Write-Fail "Log Analytics workspace '$LogAnalytics' — not found or access denied"
    }
} else {
    Write-Skip "Log Analytics workspace name not available — provide -LogAnalytics to enable"
}

# ==========================================================================
# 3. Storage account + queue
# ==========================================================================
Write-Section "3. Storage account and queue"
try {
    $saState = az storage account show `
        --name $StorageAccount `
        --resource-group $ResourceGroup `
        --query "provisioningState" -o tsv 2>$null
    if ($saState -eq 'Succeeded') {
        Write-Pass "Storage account '$StorageAccount' — provisioningState: Succeeded"
    } else {
        Write-Fail "Storage account '$StorageAccount' — expected Succeeded, got: $saState"
    }

    $saSharedKey = az storage account show `
        --name $StorageAccount `
        --resource-group $ResourceGroup `
        --query "allowSharedKeyAccess" -o tsv 2>$null
    if ($saSharedKey -eq 'false') {
        Write-Pass "Storage account shared key access is disabled (identity-auth enforced)"
    } else {
        Write-Fail "Storage account shared key access — expected false (disabled), got: $saSharedKey"
    }
} catch {
    Write-Fail "Storage account '$StorageAccount' — not found or access denied"
}

try {
    $queueExists = az storage queue exists `
        --account-name $StorageAccount `
        --name $QueueName `
        --auth-mode login `
        --query "exists" -o tsv 2>$null
    if ($queueExists -eq 'true') {
        Write-Pass "Storage queue '$QueueName' exists"
    } else {
        Write-Fail "Storage queue '$QueueName' not found in account '$StorageAccount'"
    }
} catch {
    Write-Fail "Storage queue check failed — '$QueueName' in '$StorageAccount'"
}

# ==========================================================================
# 4. Container Registry + image
# ==========================================================================
Write-Section "4. Container Registry and image"
try {
    $acrState = az acr show `
        --name $AcrName `
        --resource-group $ResourceGroup `
        --query "provisioningState" -o tsv 2>$null
    if ($acrState -eq 'Succeeded') {
        Write-Pass "Container Registry '$AcrName' — provisioningState: Succeeded"
    } else {
        Write-Fail "Container Registry '$AcrName' — expected Succeeded, got: $acrState"
    }
} catch {
    Write-Fail "Container Registry '$AcrName' — not found or access denied"
}

try {
    $imageRepo = $ImageTag.Split(':')[0]
    $imageVer  = $ImageTag.Split(':')[1]
    $imageExists = az acr repository show-tags `
        --name $AcrName `
        --repository $imageRepo `
        --query "contains(@, '$imageVer')" -o tsv 2>$null
    if ($imageExists -eq 'true') {
        Write-Pass "ACR image '$ImageTag' is present in registry"
    } else {
        Write-Fail "ACR image '$ImageTag' not found — run postprovision hook (az acr build) to push it"
    }
} catch {
    Write-Fail "ACR image check failed for '$ImageTag' in '$AcrName'"
}

# ==========================================================================
# 5. User-Assigned Managed Identity + role assignments
# ==========================================================================
Write-Section "5. User-Assigned Managed Identity and role assignments"

$uamiPrincipalId  = $null
$uamiActualRid    = $null

try {
    $uamiJson = az identity show `
        --name $IdentityName `
        --resource-group $ResourceGroup `
        --query "{principalId:principalId,clientId:clientId,id:id}" `
        -o json 2>$null | ConvertFrom-Json
    if ($uamiJson) {
        Write-Pass "UAMI '$IdentityName' exists"
        $uamiPrincipalId = $uamiJson.principalId
        $uamiActualRid   = $uamiJson.id

        if ($UamiResourceId) {
            if ($uamiActualRid.ToLower() -eq $UamiResourceId.ToLower()) {
                Write-Pass "UAMI resource ID matches azd output"
            } else {
                Write-Fail "UAMI resource ID mismatch — got: $uamiActualRid"
            }
        }
    } else {
        Write-Fail "UAMI '$IdentityName' not found in resource group '$ResourceGroup'"
    }
} catch {
    Write-Fail "UAMI '$IdentityName' — not found or access denied"
}

if ($uamiPrincipalId) {
    function Test-RoleAssignment([string]$desc, [string]$scope, [string]$roleId) {
        try {
            $assignments = az role assignment list `
                --assignee $uamiPrincipalId `
                --scope $scope `
                --query "[?ends_with(roleDefinitionId,'/$roleId')].roleDefinitionId" `
                -o tsv 2>$null
            if ($assignments) {
                Write-Pass $desc
            } else {
                Write-Fail "$desc — role assignment not found (principal: $uamiPrincipalId)"
            }
        } catch {
            Write-Fail "$desc — role check failed"
        }
    }

    $saResourceId = az storage account show `
        --name $StorageAccount `
        --resource-group $ResourceGroup `
        --query "id" -o tsv 2>$null

    $acrResourceId = az acr show `
        --name $AcrName `
        --resource-group $ResourceGroup `
        --query "id" -o tsv 2>$null

    $kvResourceId = az keyvault show `
        --name $KeyVault `
        --resource-group $ResourceGroup `
        --query "id" -o tsv 2>$null

    if ($saResourceId) {
        Test-RoleAssignment "UAMI → Storage Queue Data Reader on storage account"      $saResourceId  $RoleStorageQueueReader
        Test-RoleAssignment "UAMI → Storage Queue Data Contributor on storage account" $saResourceId  $RoleStorageQueueContributor
    }
    if ($acrResourceId) {
        Test-RoleAssignment "UAMI → AcrPull on container registry"                    $acrResourceId $RoleAcrPull
        Test-RoleAssignment "UAMI → AcrPush on container registry"                    $acrResourceId $RoleAcrPush
    }
    if ($kvResourceId) {
        Test-RoleAssignment "UAMI → Key Vault Secrets User on key vault"               $kvResourceId  $RoleKvSecretsUser
    }
}

# ==========================================================================
# 6. Key Vault + expected secrets (names only — never print values)
# ==========================================================================
Write-Section "6. Key Vault and secrets"

try {
    $kvState = az keyvault show `
        --name $KeyVault `
        --resource-group $ResourceGroup `
        --query "properties.provisioningState" -o tsv 2>$null
    if ($kvState -eq 'Succeeded') {
        Write-Pass "Key Vault '$KeyVault' — provisioningState: Succeeded"
    } else {
        Write-Fail "Key Vault '$KeyVault' — expected Succeeded, got: $kvState"
    }

    $kvRbac = az keyvault show `
        --name $KeyVault `
        --resource-group $ResourceGroup `
        --query "properties.enableRbacAuthorization" -o tsv 2>$null
    if ($kvRbac -eq 'true') {
        Write-Pass "Key Vault RBAC authorization is enabled"
    } else {
        Write-Fail "Key Vault RBAC authorization — expected true, got: $kvRbac"
    }
} catch {
    Write-Fail "Key Vault '$KeyVault' — not found or access denied"
}

function Test-KvSecret([string]$secretName) {
    try {
        $secretId = az keyvault secret show `
            --vault-name $KeyVault `
            --name $secretName `
            --query "id" -o tsv 2>$null
        if ($secretId) {
            Write-Pass "Key Vault secret '$secretName' exists (value not displayed)"
        } else {
            Write-Fail "Key Vault secret '$secretName' not found in '$KeyVault' — upload after provision"
        }
    } catch {
        Write-Fail "Key Vault secret '$secretName' — check failed (RBAC propagation may still be in progress)"
    }
}

Test-KvSecret 'github-app-private-key'
Test-KvSecret 'copilot-pat'

# ==========================================================================
# 7. Container Apps environment + Container App Job
# ==========================================================================
Write-Section "7. Container Apps environment and job"

try {
    $caeState = az containerapp env show `
        --name $AcaEnv `
        --resource-group $ResourceGroup `
        --query "properties.provisioningState" -o tsv 2>$null
    if ($caeState -eq 'Succeeded') {
        Write-Pass "Container Apps environment '$AcaEnv' — provisioningState: Succeeded"
    } else {
        Write-Fail "Container Apps environment '$AcaEnv' — expected Succeeded, got: $caeState"
    }
} catch {
    Write-Fail "Container Apps environment '$AcaEnv' — not found or access denied"
}

try {
    $jobJson = az containerapp job show `
        --name $JobName `
        --resource-group $ResourceGroup `
        --query "{state:properties.provisioningState,trigger:properties.configuration.triggerType}" `
        -o json 2>$null | ConvertFrom-Json

    if (-not $jobJson) {
        Write-Fail "Container App Job '$JobName' not found in resource group '$ResourceGroup'"
    } else {
        if ($jobJson.state -eq 'Succeeded') {
            Write-Pass "Container App Job '$JobName' — provisioningState: Succeeded"
        } else {
            Write-Fail "Container App Job '$JobName' — expected Succeeded, got: $($jobJson.state)"
        }

        if ($jobJson.trigger -eq 'Event') {
            Write-Pass "Container App Job trigger type is 'Event' (KEDA event-driven)"
        } else {
            Write-Fail "Container App Job trigger type — expected Event, got: $($jobJson.trigger)"
        }

        # KEDA azure-queue scaler identity assertion
        $kedaIdentity = az containerapp job show `
            --name $JobName `
            --resource-group $ResourceGroup `
            --query "properties.configuration.eventTriggerConfig.scale.rules[?name=='queue-scaling'].identity | [0]" `
            -o tsv 2>$null

        if ($kedaIdentity) {
            if ($UamiResourceId) {
                if ($kedaIdentity.ToLower() -eq $UamiResourceId.ToLower()) {
                    Write-Pass "KEDA azure-queue scaler identity matches UAMI resource ID"
                } else {
                    Write-Fail "KEDA scaler identity mismatch — expected: $UamiResourceId — got: $kedaIdentity"
                }
            } else {
                Write-Pass "KEDA azure-queue scaler has an identity set: $kedaIdentity"
            }
        } else {
            Write-Fail "KEDA azure-queue scaler identity not set on job '$JobName' (expected UAMI resource ID)"
        }

        # ACR registry pull identity
        $jobRegIdentity = az containerapp job show `
            --name $JobName `
            --resource-group $ResourceGroup `
            --query "properties.configuration.registries[0].identity" `
            -o tsv 2>$null
        if ($jobRegIdentity) {
            Write-Pass "Container App Job ACR registry pull uses identity (not admin credentials)"
        } else {
            Write-Fail "Container App Job registry identity not configured — job cannot pull from ACR"
        }
    }
} catch {
    Write-Fail "Container App Job '$JobName' — check failed: $_"
}

# ==========================================================================
# 8. Optional: trigger a single job execution and assert it starts
# ==========================================================================
if ($RunJob) {
    Write-Section "8. Job execution test (OPT-IN)"
    Write-Host "  Triggering a single job execution — this costs one Container App Job run." -ForegroundColor Yellow

    try {
        $execName = az containerapp job start `
            --name $JobName `
            --resource-group $ResourceGroup `
            --query "name" -o tsv 2>$null

        if (-not $execName) {
            Write-Fail "Failed to start job execution for '$JobName'"
        } else {
            Write-Host "  Job execution started: $execName"
            Write-Host "  Waiting up to ${JobTimeout}s for completion..."

            $elapsed    = 0
            $execStatus = ''
            while ($elapsed -lt $JobTimeout) {
                $execStatus = az containerapp job execution show `
                    --name $JobName `
                    --resource-group $ResourceGroup `
                    --job-execution-name $execName `
                    --query "properties.status" -o tsv 2>$null

                if ($execStatus -in 'Succeeded', 'Running', 'Failed', 'Stopped') { break }
                Start-Sleep -Seconds 10
                $elapsed += 10
            }

            switch ($execStatus) {
                'Succeeded' { Write-Pass "Job execution '$execName' — Succeeded" }
                'Running'   { Write-Pass "Job execution '$execName' — Running (still active, not failed)" }
                'Failed'    { Write-Fail "Job execution '$execName' — Failed (check logs: az containerapp job logs show -n $JobName -g $ResourceGroup)" }
                'Stopped'   { Write-Fail "Job execution '$execName' — Stopped unexpectedly" }
                default     { Write-Fail "Job execution '$execName' — timed out after ${JobTimeout}s (last status: $execStatus)" }
            }
        }
    } catch {
        Write-Fail "Job execution test failed: $_"
    }
}

# ==========================================================================
# Summary
# ==========================================================================
Write-Host ""
Write-Host "=================================================================="
$total = $PassCount + $FailCount
if ($FailCount -eq 0) {
    Write-Host " Smoke test: ALL $total assertions PASSED" -ForegroundColor Green
    Write-Host "=================================================================="
    Write-Host ""
    exit 0
} else {
    Write-Host " Smoke test: $FailCount FAILED, $PassCount passed ($total total)" -ForegroundColor Red
    Write-Host "=================================================================="
    Write-Host ""
    Write-Host "Troubleshooting:"
    Write-Host "  Logs:     az containerapp job logs show -n $JobName -g $ResourceGroup"
    Write-Host "  Details:  az containerapp job show -n $JobName -g $ResourceGroup"
    Write-Host "  Teardown: azd down --purge"
    Write-Host ""
    exit 1
}
