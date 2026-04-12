resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name_suffix = random_id.suffix.hex
  name_prefix = "${var.project_name}-${var.environment}"
  # Storage account names: alphanumeric, 3-24 chars
  storage_account_name = "st${replace(var.project_name, "-", "")}${local.name_suffix}"
  acr_name             = "cr${replace(var.project_name, "-", "")}${local.name_suffix}"

  # Agent job definitions — each agent type gets its own job
  agent_jobs = {
    backend = {
      cpu    = 1.0
      memory = "2Gi"
    }
    frontend = {
      cpu    = 0.5
      memory = "1Gi"
    }
    tester = {
      cpu    = 1.0
      memory = "2Gi"
    }
    docs = {
      cpu    = 0.5
      memory = "1Gi"
    }
  }
}

# --------------------------------------------------------------------------
# Resource Group
# --------------------------------------------------------------------------
resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name_prefix}-${local.name_suffix}"
  location = var.location
  tags     = var.tags
}

# --------------------------------------------------------------------------
# Log Analytics Workspace (required by ACA Environment)
# AVM: Azure/avm-res-operationalinsights-workspace/azurerm
# --------------------------------------------------------------------------
module "log_analytics" {
  source  = "Azure/avm-res-operationalinsights-workspace/azurerm"
  version = "~> 0.5"

  name                = "law-${local.name_prefix}-${local.name_suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
  enable_telemetry    = false
}

# --------------------------------------------------------------------------
# Storage Account + Queue
# AVM: Azure/avm-res-storage-storageaccount/azurerm
# --------------------------------------------------------------------------
module "storage" {
  source  = "Azure/avm-res-storage-storageaccount/azurerm"
  version = "~> 0.6"

  name                          = local.storage_account_name
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  account_tier                  = "Standard"
  account_replication_type      = "LRS"
  shared_access_key_enabled     = true
  public_network_access_enabled = true
  tags                          = var.tags
  enable_telemetry              = false

  queues = {
    squad-work = {
      name = var.queue_name
    }
  }
}

# --------------------------------------------------------------------------
# Container Registry
# AVM: Azure/avm-res-containerregistry-registry/azurerm
# --------------------------------------------------------------------------
module "acr" {
  source  = "Azure/avm-res-containerregistry-registry/azurerm"
  version = "~> 0.5"

  name                = local.acr_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Basic"
  admin_enabled       = true
  tags                = var.tags
  enable_telemetry    = false
}

# --------------------------------------------------------------------------
# Container Apps Managed Environment
# AVM: Azure/avm-res-app-managedenvironment/azurerm
# --------------------------------------------------------------------------
module "aca_environment" {
  source  = "Azure/avm-res-app-managedenvironment/azurerm"
  version = "~> 0.4"

  name                       = "cae-${local.name_prefix}-${local.name_suffix}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = module.log_analytics.resource.id
  tags                       = var.tags
  enable_telemetry           = false
}

# --------------------------------------------------------------------------
# Container App Jobs (one per agent type)
# AVM: Azure/avm-res-app-job/azurerm
# --------------------------------------------------------------------------
module "agent_jobs" {
  source   = "Azure/avm-res-app-job/azurerm"
  version  = "~> 0.2"
  for_each = local.agent_jobs

  name                                  = "job-squad-${each.key}-${local.name_suffix}"
  location                              = azurerm_resource_group.main.location
  resource_group_name                   = azurerm_resource_group.main.name
  container_app_environment_resource_id = module.aca_environment.resource_id
  replica_timeout_in_seconds            = 1800
  tags                                  = var.tags
  enable_telemetry                      = false

  registries = [
    {
      server               = module.acr.resource.login_server
      username             = local.acr_name
      password_secret_name = "acr-password"
    }
  ]

  secrets = [
    {
      name  = "acr-password"
      value = module.acr.resource.admin_password
    },
    {
      name  = "github-token"
      value = var.github_token
    },
    {
      name  = "storage-connection"
      value = module.storage.resource.primary_connection_string
    }
  ]

  template = {
    container = {
      name   = "squad-${each.key}"
      image  = "${module.acr.resource.login_server}/squad-agent:latest"
      cpu    = each.value.cpu
      memory = each.value.memory
      env = [
        { name = "AGENT_TYPE", value = each.key },
        { name = "GITHUB_REPO", value = var.github_repo },
        { name = "GITHUB_TOKEN", secret_name = "github-token" },
        { name = "AZURE_STORAGE_CONNECTION_STRING", secret_name = "storage-connection" },
        { name = "QUEUE_NAME", value = var.queue_name },
      ]
    }
  }

  trigger_config = {
    event_trigger_config = {
      parallelism              = 1
      replica_completion_count = 1
      scale = {
        min_executions              = 0
        max_executions              = each.key == "backend" || each.key == "frontend" ? 5 : 3
        polling_interval_in_seconds = 30
        rules = [
          {
            name             = "queue-scaling"
            custom_rule_type = "azure-queue"
            metadata = {
              queueName    = var.queue_name
              queueLength  = "1"
              accountName  = local.storage_account_name
              cloud        = "AzurePublicCloud"
            }
            authentication = [
              {
                secret_name       = "storage-connection"
                trigger_parameter = "connection"
              }
            ]
          }
        ]
      }
    }
  }
}

# --------------------------------------------------------------------------
# Function App — Issue Poller (Timer Trigger)
# AVM: Azure/avm-res-web-serverfarm/azurerm (Service Plan)
# AVM: Azure/avm-res-web-site/azurerm (Function App)
# --------------------------------------------------------------------------
module "function_service_plan" {
  source  = "Azure/avm-res-web-serverfarm/azurerm"
  version = "~> 2.0"

  name      = "asp-${local.name_prefix}-${local.name_suffix}"
  location  = azurerm_resource_group.main.location
  parent_id = azurerm_resource_group.main.id
  os_type   = "Linux"

  sku = {
    name = "Y1"
  }

  tags             = var.tags
  enable_telemetry = false
}

module "function_app" {
  source  = "Azure/avm-res-web-site/azurerm"
  version = "~> 0.21"

  name                   = "func-${local.name_prefix}-${local.name_suffix}"
  location               = azurerm_resource_group.main.location
  parent_id              = azurerm_resource_group.main.id
  service_plan_resource_id = module.function_service_plan.resource_id
  kind                   = "functionapp"
  tags                   = var.tags
  enable_telemetry       = false

  site_config = {
    application_stack = {
      python = {
        python_version = "3.11"
      }
    }
  }

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME       = "python"
    AzureWebJobsStorage            = module.storage.resource.primary_connection_string
    SQUAD_QUEUE_NAME               = var.queue_name
    GITHUB_REPO                    = var.github_repo
    GITHUB_TOKEN                   = var.github_token
    SQUAD_LABELS                   = "squad"
  }
}
