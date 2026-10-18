locals {
  jobs_enabled     = var.execution_backend == "jobs"
  sandbox_enabled  = var.execution_backend == "sandbox" || var.enable_aca_sandbox
  descriptor_ready = var.execution_backend == "sandbox" ? var.sandbox_image_ref != "" : var.jobs_image_ref != ""
}

output "platform_descriptor" {
  description = "Non-secret backend/v1 onboarding descriptor. Null until an immutable selected-backend image is supplied; legacy mixed inventory is not an onboarding destination."
  value = local.descriptor_ready && !var.enable_aca_sandbox ? merge({
    schema_version  = "backend/v1"
    release_version = var.release_version
    platform_id     = azurerm_resource_group.main.id
    backend         = var.execution_backend
    location        = var.execution_backend == "sandbox" ? local.sandbox_group_location : var.location
    tenant_id       = data.azurerm_client_config.current.tenant_id
    registry_id     = module.acr.resource_id
    monitoring_id   = module.log_analytics.resource_id
    limits = {
      max_concurrency = var.agent_job_config.max_executions
      timeout_seconds = var.agent_job_config.timeout_seconds
    }
    oidc = [for repo in distinct(var.target_repos) : {
      client_id = local.jobs_enabled ? azurerm_user_assigned_identity.squad_agent[0].client_id : azurerm_user_assigned_identity.sandbox_dispatcher[0].client_id
      subject   = local.oidc_subjects[var.execution_backend][repo]
      audience  = "api://AzureADTokenExchange"
    }]
    protected_environments = local.jobs_enabled ? [] : ["squad-sandbox-issue", "squad-publish"]
    }, local.jobs_enabled ? {
    jobs = {
      managed_environment_id = module.aca_environment[0].resource_id
      job_id                 = azapi_resource.squad_agent_job[0].id
      storage_account_id     = module.storage[0].resource_id
      queue_name             = var.queue_name
      identity_client_id     = azurerm_user_assigned_identity.squad_agent[0].client_id
      image_ref              = var.jobs_image_ref
      key_vault_id           = azurerm_key_vault.squad[0].id
    }
    } : {
    sandbox = {
      group_id             = azapi_resource.sandbox_group[0].id
      dispatcher_client_id = azurerm_user_assigned_identity.sandbox_dispatcher[0].client_id
      image_pull_client_id = azurerm_user_assigned_identity.sandbox_image_pull[0].client_id
      image_ref            = var.sandbox_image_ref
    }
  }) : null
}

output "platform_descriptor_missing" {
  description = "Exact activation blockers. Empty means platform_descriptor is ready for schema validation."
  value = concat(
    local.descriptor_ready ? [] : [var.execution_backend == "sandbox" ? "sandbox_image_ref: supply an immutable registry/repository@sha256 digest" : "jobs_image_ref: supply an immutable registry/repository@sha256 digest"],
    var.enable_aca_sandbox ? ["enable_aca_sandbox: legacy mixed inventory cannot activate; provision a separate destination"] : []
  )
}
