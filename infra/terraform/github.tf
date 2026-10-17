# --------------------------------------------------------------------------
# GitHub Actions Repository Variables
# Sets the variables that squad-queue.yml needs on each target repo.
# Replaces manual `gh variable set` — Terraform owns these going forward.
# --------------------------------------------------------------------------

locals {
  # Map of repo full name → repo short name for GitHub resources
  target_repo_names = { for repo in var.target_repos : repo => split("/", repo)[1] }
  sandbox_labels = {
    "sandbox-run"        = { color = "1D76DB", description = "Opt in to the ACA Sandbox issue workflow" }
    "sandbox:processing" = { color = "FBCA04", description = "Sandbox work is being dispatched" }
    "sandbox:queued"     = { color = "0052CC", description = "Sandbox draft PR is ready for review" }
    "sandbox:revising"   = { color = "5319E7", description = "Sandbox PR revision is in progress" }
    "sandbox:ready"      = { color = "0E8A16", description = "Sandbox run completed successfully" }
    "sandbox:failed"     = { color = "B60205", description = "Sandbox run failed" }
  }
  sandbox_repo_labels = {
    for pair in setproduct(keys(local.target_repo_names), keys(local.sandbox_labels)) :
    "${pair[0]}:${pair[1]}" => {
      repository  = local.target_repo_names[pair[0]]
      name        = pair[1]
      color       = local.sandbox_labels[pair[1]].color
      description = local.sandbox_labels[pair[1]].description
    }
  }
}

resource "github_actions_variable" "squad_azure_client_id" {
  for_each      = local.target_repo_names
  repository    = each.value
  variable_name = "SQUAD_AZURE_CLIENT_ID"
  value         = azurerm_user_assigned_identity.squad_agent.client_id
}

resource "github_actions_variable" "squad_azure_tenant_id" {
  for_each      = local.target_repo_names
  repository    = each.value
  variable_name = "SQUAD_AZURE_TENANT_ID"
  value         = data.azurerm_client_config.current.tenant_id
}

resource "github_actions_variable" "squad_azure_subscription_id" {
  for_each      = local.target_repo_names
  repository    = each.value
  variable_name = "SQUAD_AZURE_SUBSCRIPTION_ID"
  value         = var.subscription_id
}

resource "github_actions_variable" "squad_storage_account" {
  for_each      = local.target_repo_names
  repository    = each.value
  variable_name = "SQUAD_STORAGE_ACCOUNT"
  value         = module.storage.name
}

resource "github_actions_variable" "squad_queue_name" {
  for_each      = local.target_repo_names
  repository    = each.value
  variable_name = "SQUAD_QUEUE_NAME"
  value         = var.queue_name
}



resource "github_issue_label" "sandbox_flow" {
  for_each    = local.sandbox_repo_labels
  repository  = each.value.repository
  name        = each.value.name
  color       = each.value.color
  description = each.value.description
}

# Keep the sandbox issue workflow disabled until its separate resources and
# protected GitHub environments have been configured by the repository owner.
resource "github_actions_variable" "squad_issue_flow_enabled" {
  for_each      = local.target_repo_names
  repository    = each.value
  variable_name = "SQUAD_ISSUE_FLOW_ENABLED"
  value         = "false"
}

resource "github_actions_variable" "squad_issue_opt_in_number" {
  for_each      = local.target_repo_names
  repository    = each.value
  variable_name = "SQUAD_ISSUE_OPT_IN_NUMBER"
  value         = var.squad_issue_opt_in_number
}

resource "github_actions_variable" "squad_github_app_id" {
  for_each      = local.target_repo_names
  repository    = each.value
  variable_name = "SQUAD_GITHUB_APP_ID"
  value         = var.github_app_id
}

resource "github_actions_variable" "squad_github_app_installation_id" {
  for_each      = local.target_repo_names
  repository    = each.value
  variable_name = "SQUAD_GITHUB_APP_INSTALLATION_ID"
  value         = var.github_app_installation_id
}

resource "github_actions_variable" "sandbox_group_name" {
  for_each      = var.enable_aca_sandbox ? local.target_repo_names : {}
  repository    = each.value
  variable_name = "SQUAD_SANDBOX_GROUP_NAME"
  value         = local.sandbox_group_name
}

resource "github_actions_variable" "sandbox_region" {
  for_each      = var.enable_aca_sandbox ? local.target_repo_names : {}
  repository    = each.value
  variable_name = "SQUAD_SANDBOX_REGION"
  value         = local.sandbox_group_location
}

resource "github_actions_variable" "sandbox_resource_group_name" {
  for_each      = var.enable_aca_sandbox ? local.target_repo_names : {}
  repository    = each.value
  variable_name = "SQUAD_SANDBOX_RESOURCE_GROUP_NAME"
  value         = azurerm_resource_group.main.name
}

resource "github_actions_variable" "sandbox_azure_client_id" {
  for_each      = var.enable_aca_sandbox ? local.target_repo_names : {}
  repository    = each.value
  variable_name = "SQUAD_SANDBOX_AZURE_CLIENT_ID"
  value         = azurerm_user_assigned_identity.sandbox_dispatcher[0].client_id
}

resource "github_actions_variable" "sandbox_azure_tenant_id" {
  for_each      = var.enable_aca_sandbox ? local.target_repo_names : {}
  repository    = each.value
  variable_name = "SQUAD_SANDBOX_AZURE_TENANT_ID"
  value         = data.azurerm_client_config.current.tenant_id
}

resource "github_actions_variable" "sandbox_azure_subscription_id" {
  for_each      = var.enable_aca_sandbox ? local.target_repo_names : {}
  repository    = each.value
  variable_name = "SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID"
  value         = var.subscription_id
}

resource "github_actions_variable" "sandbox_image_ref" {
  for_each      = var.enable_aca_sandbox && var.sandbox_image_ref != "" ? local.target_repo_names : {}
  repository    = each.value
  variable_name = "SQUAD_SANDBOX_IMAGE_REF"
  value         = var.sandbox_image_ref
}
