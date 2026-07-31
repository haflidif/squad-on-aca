/*
  Squad on ACA — Log Analytics Workspace Module
  Wraps: br/public:avm/res/operational-insights/workspace
*/

@description('Name of the Log Analytics workspace')
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

// ---------------------------------------------------------------------------
// Log Analytics Workspace (Azure Verified Module)
// ---------------------------------------------------------------------------
module workspace 'br/public:avm/res/operational-insights/workspace:0.9.1' = {
  name: 'law-deploy'
  params: {
    name: name
    location: location
    tags: tags
    enableTelemetry: false
  }
}

@description('Resource ID of the Log Analytics workspace')
output resourceId string = workspace.outputs.resourceId

@description('Name of the Log Analytics workspace')
output name string = workspace.outputs.name
