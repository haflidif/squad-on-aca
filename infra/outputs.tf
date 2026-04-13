output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "storage_account_name" {
  value = module.storage.name
}

output "queue_name" {
  value = var.queue_name
}

output "acr_login_server" {
  value = module.acr.resource.login_server
}

output "container_apps_environment" {
  value = module.aca_environment.name
}

output "agent_job_name" {
  value = azapi_resource.squad_agent_job.name
}

output "agent_identity_name" {
  value = azurerm_user_assigned_identity.squad_agent.name
}

output "squad_agent_client_id" {
  description = "Client ID of the Squad Agent UAMI — used by GitHub Actions OIDC login"
  value       = azurerm_user_assigned_identity.squad_agent.client_id
}

output "squad_agent_tenant_id" {
  description = "Tenant ID of the Squad Agent UAMI — used by GitHub Actions OIDC login"
  value       = azurerm_user_assigned_identity.squad_agent.tenant_id
}

output "function_app_name" {
  value = module.function_app.name
}

output "key_vault_name" {
  value = azurerm_key_vault.squad.name
}
