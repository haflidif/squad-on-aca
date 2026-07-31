/*
  Squad on ACA — Key Vault Module
  Wraps: br/public:avm/res/key-vault/vault
  - Standard SKU
  - RBAC authorization ENABLED (no legacy access policies)
  - Purge protection DISABLED (dev environment — allow purge after delete)
  - Public network access ENABLED (see issue #8 for private networking)
  - Accepts role assignments (UAMI = Secrets User; deployer = Secrets Officer)

  IMPORTANT: Secret VALUES are NOT created by this module or main.bicep.
  Upload manually post-provision:
    az keyvault secret set --vault-name <name> --name "github-app-private-key" --file ./key.pem
    az keyvault secret set --vault-name <name> --name "copilot-pat" --value "<PAT>"
*/

@description('Key Vault name (globally unique, 3-24 chars)')
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('Role assignments — passed directly to the AVM module')
param roleAssignments array = []

// ---------------------------------------------------------------------------
// Key Vault (Azure Verified Module)
// ---------------------------------------------------------------------------
module vault 'br/public:avm/res/key-vault/vault:0.11.0' = {
  name: 'kv-deploy'
  params: {
    name: name
    location: location
    tags: tags
    sku: 'standard'
    enableRbacAuthorization: true
    enablePurgeProtection: false
    publicNetworkAccess: 'Enabled'
    roleAssignments: roleAssignments
    enableTelemetry: false
  }
}

@description('Resource ID of the Key Vault')
output resourceId string = vault.outputs.resourceId

@description('Name of the Key Vault')
output name string = vault.outputs.name

@description('URI of the Key Vault')
output uri string = vault.outputs.uri
