/*
  Squad on ACA — Main Bicep Orchestrator
  Scope: subscription (creates resource group, then deploys all resources)

  Deployment parity with infra/terraform/ — both coexist. Terraform is canonical.
  Choose one deployment path: either `azd up` (this file) or `terraform apply`.

  POST-PROVISION (required, not in Bicep scope):
  1. Upload secrets to Key Vault:
       az keyvault secret set --vault-name <name> --name "github-app-private-key" --file ./key.pem
       az keyvault secret set --vault-name <name> --name "copilot-pat" --value "<PAT>"
  2. Set GitHub Actions repository variables on each target repo (handled by Lando via gh CLI):
       SQUAD_AZURE_CLIENT_ID, SQUAD_AZURE_TENANT_ID, SQUAD_AZURE_SUBSCRIPTION_ID,
       SQUAD_STORAGE_ACCOUNT, SQUAD_QUEUE_NAME
     NOTE: Bicep cannot manage GitHub resources — this is intentional. The Terraform
     path uses the GitHub provider (github.tf) for this; the Bicep/azd path delegates
     to a post-provision step. See Lando's azd/azure.yaml configuration.
*/

targetScope = 'subscription'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Azure region for all resources')
param location string = 'swedencentral'

@description('Project name — used in resource naming')
param projectName string = 'squad-aca'

@description('Environment name (dev, staging, prod)')
param environment string = 'dev'

@description('GitHub repository in owner/repo format')
param githubRepo string = 'haflidif/squad-on-aca'

@description('Name of the Storage Queue for work items')
param queueName string = 'squad-work-queue'

@description('GitHub repos (owner/repo) allowed to authenticate via OIDC federated credentials')
param targetRepos array = []

@description('GitHub App ID (numeric string) — required')
param githubAppId string

@description('GitHub App Installation ID — required')
param githubAppInstallationId string

@description('CPU cores for the agent container (e.g. "1.0", "0.5")')
param agentCpu string = '1.0'

@description('Memory for the agent container (e.g. "2Gi")')
param agentMemory string = '2Gi'

@description('Maximum concurrent job executions')
param agentMaxExecutions int = 10

@description('Job replica timeout in seconds')
param agentTimeoutSeconds int = 1800

@description('''
  Principal ID of the deployer (user or SP running this deployment).
  Granted Key Vault Secrets Officer so secrets can be uploaded post-provision.
  Required. Get with: az ad signed-in-user show --query id -o tsv
''')
param deployerPrincipalId string

@description('''
  Principal type of the deployer. Use 'ServicePrincipal' for CI/CD pipelines,
  Managed Identities, or azd with a service principal. Use 'User' for interactive
  deployments. 'Group' for Azure AD groups.
  CI/SP deployers must set this to 'ServicePrincipal' — leaving it as 'User' will
  cause the Key Vault Secrets Officer role assignment to fail for non-user principals.
''')
@allowed(['User', 'ServicePrincipal', 'Group'])
param deployerPrincipalType string = 'User'

@description('''
  Stable 8-char hex suffix for globally-unique resource names.
  Defaults to a deterministic value derived from subscription + project + environment.
  Override with the same value on redeployments to keep names stable.
''')
param nameSuffix string = substring(uniqueString(subscription().subscriptionId, projectName, environment), 0, 8)

@description('Tags applied to all resources. Override at deploy time to add extra tags (e.g. SecurityControl=ignore when testing on a policy-restricted tenant).')
param tags object = {
  project:    'squad-on-aca'
  managed_by: 'bicep'
}

// ---------------------------------------------------------------------------
// Computed locals
// ---------------------------------------------------------------------------

var projectNoHyphen = replace(projectName, '-', '')
var namePrefix      = '${projectName}-${environment}'

var resourceGroupName         = 'rg-${namePrefix}-${nameSuffix}'
var storageAccountName        = 'st${projectNoHyphen}${nameSuffix}'
var acrName                   = 'cr${projectNoHyphen}${nameSuffix}'
var logAnalyticsWorkspaceName = 'law-${namePrefix}-${nameSuffix}'
var acaEnvironmentName        = 'cae-${namePrefix}-${nameSuffix}'
var uamiName                  = 'id-squad-agent-${nameSuffix}'
var keyVaultName              = 'kv-squad-${nameSuffix}'
var jobName                   = 'job-squad-agent-${nameSuffix}'

// Role definition IDs (built-in Azure roles)
var roleIds = {
  storageQueueDataReader:      '19e7f393-937e-4f77-808e-94535e297925'
  storageQueueDataContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  acrPull:                     '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  acrPush:                     '8311e382-0749-4cb8-b61a-304f252e45ec'
  keyVaultSecretsUser:         '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer:      'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
}

// ---------------------------------------------------------------------------
// Resource Group
// ---------------------------------------------------------------------------

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------
// User-Assigned Managed Identity + Federated Credentials
// Must deploy before storage/acr/kv so we have the principalId for RBAC.
// ---------------------------------------------------------------------------

module identity './modules/identity.bicep' = {
  scope: rg
  name: 'identity-module'
  params: {
    name: uamiName
    location: location
    tags: tags
    targetRepos: targetRepos
  }
}

// ---------------------------------------------------------------------------
// Log Analytics Workspace
// ---------------------------------------------------------------------------

module monitoring './modules/monitoring.bicep' = {
  scope: rg
  name: 'monitoring-module'
  params: {
    name: logAnalyticsWorkspaceName
    location: location
    tags: tags
  }
}

// ---------------------------------------------------------------------------
// Storage Account + Queue
// RBAC: UAMI → Storage Queue Data Reader (KEDA scaler reads queue length)
//        UAMI → Storage Queue Data Contributor (agent dequeues at runtime)
// ---------------------------------------------------------------------------

module storage './modules/storage.bicep' = {
  scope: rg
  name: 'storage-module'
  params: {
    name: storageAccountName
    location: location
    tags: tags
    queueName: queueName
    roleAssignments: [
      {
        principalId:            identity.outputs.principalId
        roleDefinitionIdOrName: roleIds.storageQueueDataReader
        principalType:          'ServicePrincipal'
      }
      {
        principalId:            identity.outputs.principalId
        roleDefinitionIdOrName: roleIds.storageQueueDataContributor
        principalType:          'ServicePrincipal'
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Container Registry
// RBAC: UAMI → AcrPull (pull agent image without admin credentials)
//        UAMI → AcrPush (import base images)
// ---------------------------------------------------------------------------

module acr './modules/acr.bicep' = {
  scope: rg
  name: 'acr-module'
  params: {
    name: acrName
    location: location
    tags: tags
    roleAssignments: [
      {
        principalId:            identity.outputs.principalId
        roleDefinitionIdOrName: roleIds.acrPull
        principalType:          'ServicePrincipal'
      }
      {
        principalId:            identity.outputs.principalId
        roleDefinitionIdOrName: roleIds.acrPush
        principalType:          'ServicePrincipal'
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Key Vault
// RBAC: UAMI → Key Vault Secrets User (read secrets at runtime)
//        Deployer → Key Vault Secrets Officer (upload secrets post-provision)
// Secret VALUES are NOT created here — upload manually post-provision.
// ---------------------------------------------------------------------------

module keyvault './modules/keyvault.bicep' = {
  scope: rg
  name: 'keyvault-module'
  params: {
    name: keyVaultName
    location: location
    tags: tags
    roleAssignments: [
      {
        principalId:            identity.outputs.principalId
        roleDefinitionIdOrName: roleIds.keyVaultSecretsUser
        principalType:          'ServicePrincipal'
      }
      {
        principalId:            deployerPrincipalId
        roleDefinitionIdOrName: roleIds.keyVaultSecretsOfficer
        principalType:          deployerPrincipalType
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// ACA Managed Environment (inline AVM module — no separate module file)
// Linked to Log Analytics workspace; zone redundancy disabled.
// ---------------------------------------------------------------------------

module acaEnvironment 'br/public:avm/res/app/managed-environment:0.8.1' = {
  scope: rg
  name: 'aca-env-module'
  params: {
    name: acaEnvironmentName
    location: location
    tags: tags
    logAnalyticsWorkspaceResourceId: monitoring.outputs.resourceId
    zoneRedundant: false
    enableTelemetry: false
  }
}

// ---------------------------------------------------------------------------
// Container App Job
// Deployed after RBAC assignments are in place (implicit via consuming outputs
// from storage, acr, keyvault, and acaEnvironment modules).
// ---------------------------------------------------------------------------

module agentJob './modules/container-app-job.bicep' = {
  scope: rg
  name: 'agent-job-module'
  params: {
    name:                   jobName
    location:               location
    tags:                   tags
    acaEnvironmentId:       acaEnvironment.outputs.resourceId
    acrLoginServer:         acr.outputs.loginServer
    uamiResourceId:         identity.outputs.resourceId
    uamiClientId:           identity.outputs.clientId
    storageAccountName:     storage.outputs.name
    queueName:              queueName
    keyVaultName:           keyvault.outputs.name
    githubRepo:             githubRepo
    githubAppId:            githubAppId
    githubAppInstallationId: githubAppInstallationId
    cpu:                    agentCpu
    memory:                 agentMemory
    maxExecutions:          agentMaxExecutions
    timeoutSeconds:         agentTimeoutSeconds
  }
}

// ---------------------------------------------------------------------------
// Outputs (parity with infra/terraform/outputs.tf)
// ---------------------------------------------------------------------------

@description('Name of the Resource Group')
output resource_group_name string = rg.name

@description('Name of the Storage Account')
output storage_account_name string = storage.outputs.name

@description('Name of the Storage Queue')
output queue_name string = queueName

@description('Login server of the Container Registry')
output acr_login_server string = acr.outputs.loginServer

@description('Name of the ACA Managed Environment')
output container_apps_environment string = acaEnvironment.outputs.name

@description('Name of the Container App Job')
output agent_job_name string = agentJob.outputs.name

@description('Name of the User-Assigned Managed Identity')
output agent_identity_name string = identity.outputs.name

@description('Client ID of the UAMI — for GitHub Actions OIDC login')
output squad_agent_client_id string = identity.outputs.clientId

@description('Tenant ID — for GitHub Actions OIDC login')
output squad_agent_tenant_id string = tenant().tenantId

@description('Name of the Key Vault')
output key_vault_name string = keyvault.outputs.name

@description('Resource ID of the UAMI — for downstream consumers')
output uami_resource_id string = identity.outputs.resourceId

@description('Principal ID of the UAMI — for downstream consumers')
output uami_principal_id string = identity.outputs.principalId
