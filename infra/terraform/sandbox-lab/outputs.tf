output "subscription_id" {
  value = var.subscription_id
}

output "resource_group_name" {
  value = data.azurerm_resource_group.lab.name
}

output "sandbox_group_id" {
  value = azapi_resource.sandbox_group.id
}

output "sandbox_group_name" {
  value = azapi_resource.sandbox_group.name
}

output "dispatcher_principal_id" {
  value = azurerm_user_assigned_identity.dispatcher.principal_id
}

output "dispatcher_client_id" {
  value = azurerm_user_assigned_identity.dispatcher.client_id
}

output "dispatcher_tenant_id" {
  value = azurerm_user_assigned_identity.dispatcher.tenant_id
}

output "acr_id" {
  value = data.azurerm_container_registry.images.id
}

output "acr_login_server" {
  value = data.azurerm_container_registry.images.login_server
}
