@description('Sandbox Group name')
param name string
param nameSuffix string
param location string
param tags object = {}
param targetRepos array = []
param registryId string

resource imagePull 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-sandbox-image-pull-${nameSuffix}'
  location: location
  tags: tags
}

resource dispatcher 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-sandbox-dispatcher-${nameSuffix}'
  location: location
  tags: tags
}

// The public Bicep type catalog does not yet describe this verified lab API.
resource group 'Microsoft.App/sandboxGroups@2026-07-01' = {
  name: name
  location: location
  tags: tags
  // Identity attachment matches the verified sandbox-lab AzAPI configuration.
  #disable-next-line BCP187
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${imagePull.id}': {}
    }
  }
}

resource dispatchOidc 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = [for repo in union(targetRepos, []): {
  parent: dispatcher
  name: 'gha-sandbox-issue-${replace(replace(replace(repo, '/', '-'), '.', '-'), '_', '-')}'
  properties: {
    audiences: ['api://AzureADTokenExchange']
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${repo}:environment:squad-sandbox-issue'
  }
}]

// Container Apps SandboxGroup Data Owner, the same role used by sandbox-lab.
resource dispatcherRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: group
  name: guid(group.id, dispatcher.id, 'sandbox-data-owner')
  properties: {
    principalId: dispatcher.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'c24cf47c-5077-412d-a19c-45202126392c')
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(registryId, '/'))
}
resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, imagePull.id, 'AcrPull')
  properties: {
    principalId: imagePull.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

output groupId string = group.id
output dispatcherClientId string = dispatcher.properties.clientId
output imagePullClientId string = imagePull.properties.clientId
