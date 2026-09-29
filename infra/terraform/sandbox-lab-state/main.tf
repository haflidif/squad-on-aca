terraform {
  required_version = ">= 1.10.0"

  backend "local" {}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.37.0, < 5.0.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id     = var.subscription_id
  storage_use_azuread = true
}

locals {
  storage_account_name = var.storage_account_name != null ? var.storage_account_name : "stsquadlab${substr(md5(var.subscription_id), 0, 10)}"
  tags = merge(var.tags, {
    owner   = "squad-on-aca"
    purpose = "sandbox-lab-state"
    lab     = "squad-aca-sandbox"
  })
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
}

resource "azurerm_storage_account" "state" {
  name                            = local.storage_account_name
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  shared_access_key_enabled       = false
  allow_nested_items_to_be_public = false
  public_network_access_enabled   = true
  tags                            = local.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 14
    }
    container_delete_retention_policy {
      days = 14
    }
  }

  network_rules {
    default_action = var.network_default_action
    bypass         = ["None"]
    ip_rules       = [for cidr in var.operator_ipv4_cidrs : endswith(cidr, "/32") ? split("/", cidr)[0] : cidr]
  }
}

resource "azurerm_storage_container" "state" {
  name                  = "sandbox-lab-state"
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
}

resource "azurerm_role_assignment" "state_operator" {
  count                = var.state_operator_principal_id == null ? 0 : 1
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.state_operator_principal_id
}
