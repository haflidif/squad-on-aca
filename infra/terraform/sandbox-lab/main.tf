terraform {
  required_version = ">= 1.10.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.37.0, < 5.0.0"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.6"
    }
  }

  backend "azurerm" {}
}

provider "azurerm" {
  features {}
  subscription_id     = var.subscription_id
  storage_use_azuread = true
}

provider "azapi" {}

data "azurerm_resource_group" "lab" {
  name = var.resource_group_name
}

data "azurerm_container_registry" "images" {
  name                = var.acr_name
  resource_group_name = var.acr_resource_group_name
}

locals {
  tags = merge(var.tags, {
    owner   = "squad-on-aca"
    purpose = "sandbox-lab-dispatch"
    lab     = "squad-aca-sandbox"
  })
}

resource "azapi_resource" "sandbox_group" {
  type                      = "Microsoft.App/sandboxGroups@2026-07-01"
  name                      = var.sandbox_group_name
  location                  = var.location
  parent_id                 = data.azurerm_resource_group.lab.id
  tags                      = local.tags
  schema_validation_enabled = false
}

resource "azurerm_user_assigned_identity" "dispatcher" {
  name                = var.dispatcher_identity_name
  location            = var.location
  resource_group_name = data.azurerm_resource_group.lab.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "dispatcher_data_owner" {
  scope                = azapi_resource.sandbox_group.id
  role_definition_name = "Container Apps SandboxGroup Data Owner"
  principal_id         = azurerm_user_assigned_identity.dispatcher.principal_id
}

resource "azurerm_federated_identity_credential" "dispatch_environment" {
  name                = "fic-squad-sandbox-dispatch"
  resource_group_name = data.azurerm_resource_group.lab.name
  parent_id           = azurerm_user_assigned_identity.dispatcher.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  subject             = "repo:AzureViking/squad-on-aca-sandbox-lab:environment:squad-sandbox-dispatch"
}

resource "azurerm_role_assignment" "image_pull" {
  count                = var.image_pull_principal_id == null ? 0 : 1
  scope                = data.azurerm_container_registry.images.id
  role_definition_name = "AcrPull"
  principal_id         = var.image_pull_principal_id
}
