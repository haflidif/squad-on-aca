/*
  Squad on ACA — Container App Job Module
  Raw resource: Microsoft.App/jobs@2025-01-01

  Uses a raw ARM resource (not AVM) because the AVM Container App Job module
  does not support identity-based KEDA scaler auth. This mirrors the Terraform
  design which uses azapi_resource for the same reason.

  KEDA azure-queue scaler uses the UAMI resource ID (not client ID) for
  identity-based auth — this is required for shared-key-disabled storage.

  NOTE: GitHub Actions repository variables (SQUAD_AZURE_CLIENT_ID, etc.)
  are managed via a post-provision gh CLI step run by Lando — Bicep cannot
  manage GitHub resources.
*/

@description('Name of the Container App Job')
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('Resource ID of the ACA Managed Environment')
param acaEnvironmentId string

@description('Login server of the Container Registry')
param acrLoginServer string

@description('Resource ID of the User-Assigned Managed Identity')
param uamiResourceId string

@description('Client ID of the User-Assigned Managed Identity (for AZURE_CLIENT_ID env var)')
param uamiClientId string

@description('Name of the storage account (used in KEDA scaler metadata + env var)')
param storageAccountName string

@description('Name of the queue to poll for work items')
param queueName string

@description('Name of the Key Vault (for KEY_VAULT_NAME env var)')
param keyVaultName string

@description('GitHub repository in owner/repo format')
param githubRepo string

@description('GitHub App ID (numeric string)')
param githubAppId string

@description('GitHub App Installation ID')
param githubAppInstallationId string

@description('CPU cores for the container (e.g. "1.0", "0.5")')
param cpu string = '1.0'

@description('Memory for the container (e.g. "2Gi")')
param memory string = '2Gi'

@description('Maximum concurrent job executions')
param maxExecutions int = 10

@description('Job replica timeout in seconds')
param timeoutSeconds int = 1800

@description('''
  Initial container image for the job.
  Defaults to a public MCR placeholder so provisioning succeeds even before the
  postprovision hook has pushed squad-agent:latest to ACR.

  ARM validates the container image is reachable at provision time.  The private
  ACR image does not exist on first deploy (chicken-and-egg), so using a public
  MCR image here lets the job provision cleanly.

  After azd provision (or az deployment sub create), the postprovision hook runs
  az acr build to push squad-agent:latest, then az containerapp job update to
  point the job at the real image.  Subsequent executions use squad-agent:latest.
''')
param containerImage string = 'mcr.microsoft.com/hello-world:latest'

// ---------------------------------------------------------------------------
// Container App Job (raw Microsoft.App/jobs resource)
// Identity-based KEDA auth: uamiResourceId used in scaler rule identity field.
// Depends on: storage RBAC, ACR pull RBAC, and KV secrets RBAC being applied
// before this job is provisioned (enforced by consuming module outputs in main.bicep).
// ---------------------------------------------------------------------------
resource squadAgentJob 'Microsoft.App/jobs@2025-01-01' = {
  name: name
  location: location
  tags: tags

  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uamiResourceId}': {}
    }
  }

  properties: {
    environmentId: acaEnvironmentId

    configuration: {
      replicaTimeout: timeoutSeconds
      replicaRetryLimit: 0
      triggerType: 'Event'
      secrets: []

      registries: [
        {
          server: acrLoginServer
          identity: uamiResourceId
        }
      ]

      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: maxExecutions
          pollingInterval: 30
          rules: [
            {
              name: 'queue-scaling'
              type: 'azure-queue'
              metadata: {
                queueName: queueName
                queueLength: '1'
                accountName: storageAccountName
              }
              auth: []
              identity: uamiResourceId
            }
          ]
        }
      }
    }

    template: {
      containers: [
        {
          name: 'squad-agent'
          image: containerImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            { name: 'GITHUB_REPO', value: githubRepo }
            { name: 'GITHUB_APP_ID', value: githubAppId }
            { name: 'GITHUB_APP_INSTALLATION_ID', value: githubAppInstallationId }
            { name: 'KEY_VAULT_NAME', value: keyVaultName }
            { name: 'KEY_VAULT_SECRET_NAME', value: 'github-app-private-key' }
            { name: 'QUEUE_NAME', value: queueName }
            { name: 'AZURE_STORAGE_ACCOUNT', value: storageAccountName }
            { name: 'AZURE_CLIENT_ID', value: uamiClientId }
            { name: 'COPILOT_TOKEN_SECRET_NAME', value: 'copilot-pat' }
          ]
        }
      ]
    }
  }
}

@description('Resource ID of the Container App Job')
output resourceId string = squadAgentJob.id

@description('Name of the Container App Job')
output name string = squadAgentJob.name
