# --------------------------------------------------------------------------
# GitHub Actions Repository Variables
# Sets the variables that squad-queue.yml needs on each target repo.
# Replaces manual `gh variable set` — Terraform owns these going forward.
# --------------------------------------------------------------------------

locals {
  # Map of repo full name → repo short name for GitHub resources
  target_repo_names = { for repo in var.target_repos : repo => split("/", repo)[1] }
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
