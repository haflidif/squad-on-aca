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

@description('Execution backend. Keep existing deployments on jobs; provision a separate destination to switch.')
@allowed(['jobs', 'sandbox'])
param executionBackend string = 'jobs'

@description('Installed platform release recorded in the descriptor')
@minLength(1)
param releaseVersion string = '0.0.1'

@description('Optional immutable Jobs image. Empty preserves legacy provisioning and withholds the descriptor.')
param jobsImageRef string = ''

@description('Immutable Sandbox worker image, required for sandbox bootstrap')
param sandboxImageRef string = ''

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
param githubAppId string = ''

@description('GitHub App Installation ID — required')
param githubAppInstallationId string = ''

@description('CPU cores for the agent container (e.g. "1.0", "0.5")')
param agentCpu string = '1.0'

@description('Memory for the agent container (e.g. "2Gi")')
param agentMemory string = '2Gi'

@description('Maximum concurrent job executions')
@minValue(1)
@maxValue(30)
param agentMaxExecutions int = 10

@description('Job replica timeout in seconds')
@minValue(1)
param agentTimeoutSeconds int = 1800

@description('''
  Principal ID of the deployer (user or SP running this deployment).
  Granted Key Vault Secrets Officer so secrets can be uploaded post-provision.
  Required. Get with: az ad signed-in-user show --query id -o tsv
''')
param deployerPrincipalId string = ''

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

var jobsEnabled = executionBackend == 'jobs'
var selectedImageRef = jobsEnabled ? jobsImageRef : sandboxImageRef
var imageParts = split(selectedImageRef, '@sha256:')
var imageDigest = last(imageParts)
var nonHexDigest = reduce(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'], imageDigest, (remaining, digit) => replace(remaining, digit, ''))
var imageNameValid = !empty(first(imageParts)) && !contains(map(range(0, length(first(imageParts))), index => contains('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/-', substring(first(imageParts), index, 1))), false)
var descriptorReady = length(imageParts) == 2 && imageNameValid && length(imageDigest) == 64 && empty(nonHexDigest)

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

module identity './modules/identity.bicep' = if (jobsEnabled) {
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

module storage './modules/storage.bicep' = if (jobsEnabled) {
  scope: rg
  name: 'storage-module'
  params: {
    name: storageAccountName
    location: location
    tags: tags
    queueName: queueName
    roleAssignments: [
      {
        principalId:            identity!.outputs.principalId
        roleDefinitionIdOrName: roleIds.storageQueueDataReader
        principalType:          'ServicePrincipal'
      }
      {
        principalId:            identity!.outputs.principalId
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
    roleAssignments: jobsEnabled ? [
      {
        principalId:            identity!.outputs.principalId
        roleDefinitionIdOrName: roleIds.acrPull
        principalType:          'ServicePrincipal'
      }
      {
        principalId:            identity!.outputs.principalId
        roleDefinitionIdOrName: roleIds.acrPush
        principalType:          'ServicePrincipal'
      }
    ] : []
  }
}

// ---------------------------------------------------------------------------
// Key Vault
// RBAC: UAMI → Key Vault Secrets User (read secrets at runtime)
//        Deployer → Key Vault Secrets Officer (upload secrets post-provision)
// Secret VALUES are NOT created here — upload manually post-provision.
// ---------------------------------------------------------------------------

module keyvault './modules/keyvault.bicep' = if (jobsEnabled) {
  scope: rg
  name: 'keyvault-module'
  params: {
    name: keyVaultName
    location: location
    tags: tags
    roleAssignments: [
      {
        principalId:            identity!.outputs.principalId
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

module acaEnvironment 'br/public:avm/res/app/managed-environment:0.8.1' = if (jobsEnabled) {
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

module agentJob './modules/container-app-job.bicep' = if (jobsEnabled) {
  scope: rg
  name: 'agent-job-module'
  params: {
    name:                   jobName
    location:               location
    tags:                   tags
    acaEnvironmentId:       acaEnvironment!.outputs.resourceId
    acrLoginServer:         acr.outputs.loginServer
    uamiResourceId:         identity!.outputs.resourceId
    uamiClientId:           identity!.outputs.clientId
    storageAccountName:     storage!.outputs.name
    queueName:              queueName
    keyVaultName:           keyvault!.outputs.name
    githubRepo:             githubRepo
    githubAppId:            githubAppId
    githubAppInstallationId: githubAppInstallationId
    cpu:                    agentCpu
    memory:                 agentMemory
    maxExecutions:          agentMaxExecutions
    timeoutSeconds:         agentTimeoutSeconds
    containerImage:         empty(jobsImageRef) ? 'mcr.microsoft.com/hello-world:latest' : jobsImageRef
  }
}

// ---------------------------------------------------------------------------
// Outputs (parity with infra/terraform/outputs.tf)
// ---------------------------------------------------------------------------

@description('Name of the Resource Group')
output resource_group_name string = rg.name

@description('Name of the Storage Account')
output storage_account_name string = jobsEnabled ? storage!.outputs.name : ''

@description('Name of the Storage Queue')
output queue_name string = jobsEnabled ? queueName : ''

@description('Login server of the Container Registry')
output acr_login_server string = acr.outputs.loginServer

@description('Name of the ACA Managed Environment')
output container_apps_environment string = jobsEnabled ? acaEnvironment!.outputs.name : ''

@description('Name of the Container App Job')
output agent_job_name string = jobsEnabled ? agentJob!.outputs.name : ''

@description('Name of the User-Assigned Managed Identity')
output agent_identity_name string = jobsEnabled ? identity!.outputs.name : ''

@description('Client ID of the UAMI — for GitHub Actions OIDC login')
output squad_agent_client_id string = jobsEnabled ? identity!.outputs.clientId : ''

@description('Tenant ID — for GitHub Actions OIDC login')
output squad_agent_tenant_id string = tenant().tenantId

@description('Name of the Key Vault')
output key_vault_name string = jobsEnabled ? keyvault!.outputs.name : ''

@description('Resource ID of the UAMI — for downstream consumers')
output uami_resource_id string = jobsEnabled ? identity!.outputs.resourceId : ''

@description('Principal ID of the UAMI — for downstream consumers')
output uami_principal_id string = jobsEnabled ? identity!.outputs.principalId : ''

// Uses the verified Sandbox Group and separate image-pull identity model from sandbox-lab.
module sandbox './modules/sandbox.bicep' = if (!jobsEnabled) {
  scope: rg
  name: 'sandbox-module'
  params: {
    name: 'sbg-${namePrefix}-${nameSuffix}'
    nameSuffix: nameSuffix
    location: location
    tags: tags
    targetRepos: targetRepos
    registryId: acr.outputs.resourceId
  }
}

output execution_backend string = executionBackend

var descriptorOidc = map(union(targetRepos, []), repo => {
  client_id: jobsEnabled ? identity!.outputs.clientId : sandbox!.outputs.dispatcherClientId
  subject: jobsEnabled ? 'repo:${repo}:ref:refs/heads/main' : 'repo:${repo}:environment:squad-sandbox-issue'
  audience: 'api://AzureADTokenExchange'
})

@description('Non-secret backend/v1 descriptor. Null until the selected image is immutable. Does not activate repository execution.')
output platformDescriptor object? = descriptorReady ? union({
  schema_version: 'backend/v1'
  release_version: releaseVersion
  platform_id: rg.id
  backend: executionBackend
  location: location
  tenant_id: tenant().tenantId
  registry_id: acr.outputs.resourceId
  monitoring_id: monitoring.outputs.resourceId
  limits: {
    max_concurrency: agentMaxExecutions
    timeout_seconds: agentTimeoutSeconds
  }
  oidc: descriptorOidc
  protected_environments: jobsEnabled ? [] : ['squad-sandbox-issue', 'squad-publish']
}, jobsEnabled ? {
  jobs: {
    managed_environment_id: acaEnvironment!.outputs.resourceId
    job_id: agentJob!.outputs.resourceId
    storage_account_id: storage!.outputs.resourceId
    queue_name: queueName
    identity_client_id: identity!.outputs.clientId
    image_ref: jobsImageRef
    key_vault_id: keyvault!.outputs.resourceId
  }
} : {
  sandbox: {
    group_id: sandbox!.outputs.groupId
    dispatcher_client_id: sandbox!.outputs.dispatcherClientId
    image_pull_client_id: sandbox!.outputs.imagePullClientId
    image_ref: sandboxImageRef
  }
}) : null

output jobs_image_ref string = jobsEnabled ? jobsImageRef : ''

@description('Exact activation blockers. Empty means platformDescriptor is ready for schema validation.')
output platform_descriptor_missing array = descriptorReady ? [] : [
  jobsEnabled ? 'SQUAD_JOBS_IMAGE_REF/jobsImageRef: supply an immutable registry/repository@sha256 digest' : 'SQUAD_SANDBOX_IMAGE_REF/sandboxImageRef: supply an immutable registry/repository@sha256 digest'
]
