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
  value = module.squad_agent_job.container_app_job_name
}

output "function_app_name" {
  value = module.function_app.name
}
