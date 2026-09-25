# --------------------------------------------------------------------------
# ACA Sandbox Group
# Feature-flagged infrastructure for the future ACA Sandbox dispatcher path.
# --------------------------------------------------------------------------
locals {
  sandbox_group_location = coalesce(var.sandbox_group_location, var.location)
  sandbox_group_name     = "sbg-${local.name_prefix}-${local.name_suffix}"
}

resource "azapi_resource" "sandbox_group" {
  count = var.enable_aca_sandbox ? 1 : 0

  type      = "Microsoft.App/sandboxGroups@2026-07-01"
  name      = local.sandbox_group_name
  location  = local.sandbox_group_location
  parent_id = azurerm_resource_group.main.id
  tags      = var.tags

  schema_validation_enabled = false
  # No body is set because no Sandbox Group properties are verified for this PR.
}

# Dedicated identity for the trusted sandbox dispatcher only.
resource "azurerm_user_assigned_identity" "sandbox_dispatcher" {
  count = var.enable_aca_sandbox ? 1 : 0

  name                = "id-sandbox-dispatcher-${local.name_suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

# RBAC: dispatcher UAMI -> SandboxGroup Data Owner at the sandbox group scope.
resource "azurerm_role_assignment" "sandbox_dispatcher_data_owner" {
  count = var.enable_aca_sandbox ? 1 : 0

  scope                = azapi_resource.sandbox_group[0].id
  role_definition_name = "Container Apps SandboxGroup Data Owner"
  principal_id         = azurerm_user_assigned_identity.sandbox_dispatcher[0].principal_id
}
