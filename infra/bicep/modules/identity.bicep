/*
  Squad on ACA — User-Assigned Managed Identity Module
  Wraps: br/public:avm/res/managed-identity/user-assigned-identity
  - Creates federated identity credentials for GitHub Actions OIDC per target repo
  - subject: repo:{repo}:ref:refs/heads/main
  - audience: api://AzureADTokenExchange
  - issuer: https://token.actions.githubusercontent.com
*/

@description('Name of the User-Assigned Managed Identity')
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('GitHub repos (owner/repo) to create federated credentials for. One credential per repo.')
param targetRepos array = []

// Build federated identity credentials: one per target repo
var federatedIdentityCredentials = [for repo in targetRepos: {
  name: replace(replace(replace(repo, '/', '-'), '.', '-'), '_', '-')
  audiences: ['api://AzureADTokenExchange']
  issuer: 'https://token.actions.githubusercontent.com'
  subject: 'repo:${repo}:ref:refs/heads/main'
}]

// ---------------------------------------------------------------------------
// User-Assigned Managed Identity (Azure Verified Module)
// ---------------------------------------------------------------------------
module identity 'br/public:avm/res/managed-identity/user-assigned-identity:0.4.0' = {
  name: 'identity-deploy'
  params: {
    name: name
    location: location
    tags: tags
    federatedIdentityCredentials: federatedIdentityCredentials
    enableTelemetry: false
  }
}

@description('Resource ID of the UAMI')
output resourceId string = identity.outputs.resourceId

@description('Name of the UAMI')
output name string = identity.outputs.name

@description('Principal ID (object ID) of the UAMI — used for role assignments')
output principalId string = identity.outputs.principalId

@description('Client ID of the UAMI — used by AZURE_CLIENT_ID env var and OIDC login')
output clientId string = identity.outputs.clientId
