output "subscription_id" {
  value = var.subscription_id
}

output "resource_group_name" {
  value = azurerm_resource_group.lab.name
}

output "storage_account_name" {
  value = azurerm_storage_account.state.name
}

output "state_container_name" {
  value = azurerm_storage_container.state.name
}

output "backend_operator_role_assigned" {
  value = length(azurerm_role_assignment.state_operator) == 1
}
