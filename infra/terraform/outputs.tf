output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "storage_account_name" {
  value = local.jobs_enabled ? module.storage[0].name : null
}

output "queue_name" {
  value = local.jobs_enabled ? var.queue_name : null
}

output "acr_login_server" {
  value = module.acr.resource.login_server
}

output "container_apps_environment" {
  value = local.jobs_enabled ? module.aca_environment[0].name : null
}

output "agent_job_name" {
  value = local.jobs_enabled ? azapi_resource.squad_agent_job[0].name : null
}

output "agent_identity_name" {
  value = local.jobs_enabled ? azurerm_user_assigned_identity.squad_agent[0].name : null
}

output "squad_agent_client_id" {
  description = "Client ID of the Squad Agent UAMI — used by GitHub Actions OIDC login"
  value       = local.jobs_enabled ? azurerm_user_assigned_identity.squad_agent[0].client_id : null
}

output "squad_agent_tenant_id" {
  description = "Tenant ID of the Squad Agent UAMI — used by GitHub Actions OIDC login"
  value       = local.jobs_enabled ? azurerm_user_assigned_identity.squad_agent[0].tenant_id : null
}

output "key_vault_name" {
  value = local.jobs_enabled ? azurerm_key_vault.squad[0].name : null
}

output "sandbox_group_id" {
  description = "ACA Sandbox Group resource ID when Sandbox infrastructure is selected or the legacy additive flag is enabled."
  value       = local.sandbox_enabled ? azapi_resource.sandbox_group[0].id : null
}

output "sandbox_group_name" {
  description = "ACA Sandbox Group name when Sandbox infrastructure is selected or the legacy additive flag is enabled."
  value       = local.sandbox_enabled ? azapi_resource.sandbox_group[0].name : null
}

output "sandbox_dispatcher_client_id" {
  description = "Client ID of the dedicated sandbox dispatcher UAMI when Sandbox infrastructure is selected or the legacy additive flag is enabled."
  value       = local.sandbox_enabled ? azurerm_user_assigned_identity.sandbox_dispatcher[0].client_id : null
}

output "sandbox_dispatcher_principal_id" {
  description = "Principal ID of the dedicated sandbox dispatcher UAMI when Sandbox infrastructure is selected or the legacy additive flag is enabled."
  value       = local.sandbox_enabled ? azurerm_user_assigned_identity.sandbox_dispatcher[0].principal_id : null
}

output "sandbox_defaults" {
  description = "Default per-sandbox create parameters for the dispatcher when Sandbox infrastructure is selected or the legacy additive flag is enabled."
  value = local.sandbox_enabled ? {
    cpu                  = var.sandbox_default_cpu
    memory               = var.sandbox_default_memory
    auto_suspend_seconds = var.sandbox_default_auto_suspend_seconds
  } : null
}
