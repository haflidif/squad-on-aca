/*
  Squad on ACA — Container Registry Module
  Wraps: br/public:avm/res/container-registry/registry
  - Basic SKU
  - Admin enabled (needed for image push from local dev)
  - Zone redundancy disabled (Basic SKU doesn't support it anyway)
  - Accepts role assignments (AcrPull/AcrPush for UAMI)
*/

@description('Container Registry name (lowercase alphanumeric, 5-50 chars)')
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('Role assignments — passed directly to the AVM module')
param roleAssignments array = []

// ---------------------------------------------------------------------------
// Container Registry (Azure Verified Module)
// ---------------------------------------------------------------------------
module registry 'br/public:avm/res/container-registry/registry:0.6.0' = {
  name: 'acr-deploy'
  params: {
    name: name
    location: location
    tags: tags
    acrSku: 'Basic'
    acrAdminUserEnabled: true
    zoneRedundancy: 'Disabled'
    roleAssignments: roleAssignments
    enableTelemetry: false
  }
}

@description('Resource ID of the Container Registry')
output resourceId string = registry.outputs.resourceId

@description('Name of the Container Registry')
output name string = registry.outputs.name

@description('Login server FQDN of the Container Registry')
output loginServer string = registry.outputs.loginServer
