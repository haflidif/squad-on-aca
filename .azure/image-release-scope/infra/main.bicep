targetScope = 'resourceGroup'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: 'crsquadacaa6b49feb'
}

output registryLoginServer string = registry.properties.loginServer
