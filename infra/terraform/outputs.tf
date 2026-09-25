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

output "key_vault_name" {
  value = azurerm_key_vault.squad.name
}

output "sandbox_group_id" {
  description = "ACA Sandbox Group resource ID when enable_aca_sandbox is true."
  value       = var.enable_aca_sandbox ? azapi_resource.sandbox_group[0].id : null
}

output "sandbox_group_name" {
  description = "ACA Sandbox Group name when enable_aca_sandbox is true."
  value       = var.enable_aca_sandbox ? azapi_resource.sandbox_group[0].name : null
}

output "sandbox_dispatcher_client_id" {
  description = "Client ID of the dedicated sandbox dispatcher UAMI when enable_aca_sandbox is true."
  value       = var.enable_aca_sandbox ? azurerm_user_assigned_identity.sandbox_dispatcher[0].client_id : null
}

output "sandbox_dispatcher_principal_id" {
  description = "Principal ID of the dedicated sandbox dispatcher UAMI when enable_aca_sandbox is true."
  value       = var.enable_aca_sandbox ? azurerm_user_assigned_identity.sandbox_dispatcher[0].principal_id : null
}

output "sandbox_defaults" {
  description = "Default per-sandbox create parameters for the dispatcher when enable_aca_sandbox is true."
  value = var.enable_aca_sandbox ? {
    cpu                  = var.sandbox_default_cpu
    memory               = var.sandbox_default_memory
    auto_suspend_seconds = var.sandbox_default_auto_suspend_seconds
  } : null
}
