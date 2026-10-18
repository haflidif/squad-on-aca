# --------------------------------------------------------------------------
# ACA Sandbox Group
# Sandbox-only selection and backward-compatible legacy additive inventory.
# --------------------------------------------------------------------------
locals {
  sandbox_group_location = coalesce(var.sandbox_group_location, var.location)
  sandbox_group_name     = "sbg-${local.name_prefix}-${local.name_suffix}"
}

resource "azapi_resource" "sandbox_group" {
  count = local.sandbox_enabled ? 1 : 0

  type      = "Microsoft.App/sandboxGroups@2026-07-01"
  name      = local.sandbox_group_name
  location  = local.sandbox_group_location
  parent_id = azurerm_resource_group.main.id
  tags      = var.tags

  schema_validation_enabled = false
  # Match the verified lab identity attachment, without inventing group properties.
  dynamic "identity" {
    for_each = var.execution_backend == "sandbox" ? [1] : []
    content {
      type         = "UserAssigned"
      identity_ids = [azurerm_user_assigned_identity.sandbox_image_pull[0].id]
    }
  }

  lifecycle {
    precondition {
      condition     = !(var.enable_aca_sandbox && var.execution_backend == "sandbox")
      error_message = "enable_aca_sandbox is a legacy additive mode. Do not combine it with execution_backend=sandbox; provision a separate destination."
    }
    precondition {
      condition     = var.execution_backend != "sandbox" || var.sandbox_image_ref != ""
      error_message = "Sandbox selection requires sandbox_image_ref pinned to a SHA-256 digest."
    }
  }
}

# Dedicated identity for the trusted sandbox dispatcher only.
resource "azurerm_user_assigned_identity" "sandbox_dispatcher" {
  count = local.sandbox_enabled ? 1 : 0

  name                = "id-sandbox-dispatcher-${local.name_suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

# RBAC: dispatcher UAMI -> SandboxGroup Data Owner at the sandbox group scope.
resource "azurerm_role_assignment" "sandbox_dispatcher_data_owner" {
  count = local.sandbox_enabled ? 1 : 0

  scope                = azapi_resource.sandbox_group[0].id
  role_definition_name = "Container Apps SandboxGroup Data Owner"
  principal_id         = azurerm_user_assigned_identity.sandbox_dispatcher[0].principal_id
}


# GitHub Actions OIDC for the opt-in issue workflow's protected environment.
resource "azurerm_federated_identity_credential" "sandbox_issue_environment" {
  for_each = local.sandbox_enabled ? toset(var.target_repos) : toset([])

  name      = "gha-sandbox-issue-${replace(each.value, "/[^A-Za-z0-9-]/", "-")}"
  parent_id = azurerm_user_assigned_identity.sandbox_dispatcher[0].id
  audience  = ["api://AzureADTokenExchange"]
  issuer    = "https://token.actions.githubusercontent.com"
  subject   = "repo:${each.value}:environment:squad-sandbox-issue"
}

resource "azurerm_user_assigned_identity" "sandbox_image_pull" {
  count               = var.execution_backend == "sandbox" ? 1 : 0
  name                = "id-sandbox-image-pull-${local.name_suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

resource "azurerm_role_assignment" "sandbox_image_pull" {
  count                = var.execution_backend == "sandbox" ? 1 : 0
  scope                = module.acr.resource_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.sandbox_image_pull[0].principal_id
}
