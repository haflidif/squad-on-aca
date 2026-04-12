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
    random = {
      source  = "hashicorp/random"
      version = ">= 3.5.0, < 4.0.0"
    }
    modtm = {
      source  = "Azure/modtm"
      version = "~> 0.3"
    }
    time = {
      source  = "hashicorp/time"
      version = ">= 0.9.0, < 1.0.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id      = var.subscription_id
  storage_use_azuread  = true
}

provider "azapi" {}
provider "modtm" {}
provider "time" {}
