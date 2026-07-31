/*
  Squad on ACA — Storage Account + Queue Module
  Wraps: br/public:avm/res/storage/storage-account
  - Shared key access DISABLED (identity-based auth only)
  - Default OAuth auth ENABLED
  - Public network access ENABLED (see issue #8 for private networking)
  - Network default Allow + AzureServices bypass
  - Creates the named queue
  - Accepts role assignments (Storage Queue Data Reader/Contributor for UAMI)
*/

@description('Storage account name (lowercase alphanumeric, 3-24 chars)')
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('Name of the queue to create')
param queueName string

@description('Role assignments — passed directly to the AVM module')
param roleAssignments array = []

// ---------------------------------------------------------------------------
// Storage Account (Azure Verified Module)
// ---------------------------------------------------------------------------
module storageAccount 'br/public:avm/res/storage/storage-account:0.18.0' = {
  name: 'storage-deploy'
  params: {
    name: name
    location: location
    tags: tags
    skuName: 'Standard_LRS'
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
    queueServices: {
      queues: [
        { name: queueName }
      ]
    }
    roleAssignments: roleAssignments
    enableTelemetry: false
  }
}

@description('Resource ID of the storage account')
output resourceId string = storageAccount.outputs.resourceId

@description('Name of the storage account')
output name string = storageAccount.outputs.name
