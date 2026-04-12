resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name_suffix = random_id.suffix.hex
  name_prefix = "${var.project_name}-${var.environment}"
  # Storage account names: alphanumeric, 3-24 chars
  storage_account_name = "st${replace(var.project_name, "-", "")}${local.name_suffix}"
  acr_name             = "cr${replace(var.project_name, "-", "")}${local.name_suffix}"
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

  log_analytics_workspace_internet_ingestion_enabled = true
  log_analytics_workspace_internet_query_enabled     = true
}

# --------------------------------------------------------------------------
# Storage Account + Queue
# AVM: Azure/avm-res-storage-storageaccount/azurerm
# --------------------------------------------------------------------------
module "storage" {
  source  = "Azure/avm-res-storage-storageaccount/azurerm"
  version = "~> 0.6"

  name                            = local.storage_account_name
  location                        = azurerm_resource_group.main.location
  resource_group_name             = azurerm_resource_group.main.name
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  shared_access_key_enabled       = false # Enforced by subscription policy
  public_network_access_enabled   = true
  default_to_oauth_authentication = true
  tags                            = var.tags
  enable_telemetry                = false

  network_rules = {
    default_action = "Allow"
    bypass         = ["AzureServices"]
  }

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
  sku                      = "Basic"
  admin_enabled            = true
  zone_redundancy_enabled  = false
  tags                     = var.tags
  enable_telemetry         = false
}

# --------------------------------------------------------------------------
# Container Apps Managed Environment
# AVM: Azure/avm-res-app-managedenvironment/azurerm
# --------------------------------------------------------------------------
module "aca_environment" {
  source  = "Azure/avm-res-app-managedenvironment/azurerm"
  version = "~> 0.4"

  name                = "cae-${local.name_prefix}-${local.name_suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
  enable_telemetry    = false

  zone_redundancy_enabled = false

  log_analytics_workspace = {
    resource_id = module.log_analytics.resource_id
  }
}

# --------------------------------------------------------------------------
# User-Assigned Managed Identity for Container App Job
# Used for KEDA scaling (queue auth) and ACR image pull — no shared keys needed
# --------------------------------------------------------------------------
resource "azurerm_user_assigned_identity" "squad_agent" {
  name                = "id-squad-agent-${local.name_suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

# RBAC: UAMI → Storage Queue Data Reader (KEDA scaler reads queue length)
resource "azurerm_role_assignment" "agent_queue_reader" {
  scope                = module.storage.resource_id
  role_definition_name = "Storage Queue Data Reader"
  principal_id         = azurerm_user_assigned_identity.squad_agent.principal_id
}

# RBAC: UAMI → Storage Queue Data Contributor (agent dequeues messages at runtime)
resource "azurerm_role_assignment" "agent_queue_contributor" {
  scope                = module.storage.resource_id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = azurerm_user_assigned_identity.squad_agent.principal_id
}

# RBAC: UAMI → AcrPull (pull agent image without admin credentials)
resource "azurerm_role_assignment" "agent_acr_pull" {
  scope                = module.acr.resource_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.squad_agent.principal_id
}

# --------------------------------------------------------------------------
# Container App Job — Generic Squad Agent
# Uses azapi_resource because azurerm doesn't support identity-based KEDA auth.
# One job handles all agent types; AGENT_TYPE is parsed from queue message
# at runtime by entrypoint.sh.
# --------------------------------------------------------------------------
resource "azapi_resource" "squad_agent_job" {
  type      = "Microsoft.App/jobs@2025-01-01"
  name      = "job-squad-agent-${local.name_suffix}"
  location  = azurerm_resource_group.main.location
  parent_id = azurerm_resource_group.main.id
  tags      = var.tags

  schema_validation_enabled = false # azapi schema doesn't know about identity-based KEDA auth yet

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.squad_agent.id]
  }

  body = {
    properties = {
      environmentId = module.aca_environment.resource_id

      configuration = {
        replicaTimeout  = var.agent_job_config.timeout_seconds
        replicaRetryLimit = 0
        triggerType     = "Event"

        secrets = [
          {
            name  = "github-token"
            value = var.github_token
          }
        ]

        registries = [
          {
            server   = module.acr.resource.login_server
            identity = azurerm_user_assigned_identity.squad_agent.id
          }
        ]

        eventTriggerConfig = {
          parallelism            = 1
          replicaCompletionCount = 1
          scale = {
            minExecutions   = 0
            maxExecutions   = var.agent_job_config.max_executions
            pollingInterval = 30
            rules = [
              {
                name = "queue-scaling"
                type = "azure-queue"
                metadata = {
                  queueName   = var.queue_name
                  queueLength = "1"
                  accountName = local.storage_account_name
                }
                identity = azurerm_user_assigned_identity.squad_agent.id
              }
            ]
          }
        }
      }

      template = {
        containers = [
          {
            name  = "squad-agent"
            image = "${module.acr.resource.login_server}/squad-agent:latest"
            resources = {
              cpu    = var.agent_job_config.cpu
              memory = var.agent_job_config.memory
            }
            env = [
              { name = "GITHUB_REPO", value = var.github_repo },
              { name = "GITHUB_TOKEN", secretRef = "github-token" },
              { name = "QUEUE_NAME", value = var.queue_name },
              { name = "AZURE_STORAGE_ACCOUNT", value = local.storage_account_name },
              { name = "AZURE_CLIENT_ID", value = azurerm_user_assigned_identity.squad_agent.client_id },
            ]
          }
        ]
      }
    }
  }

  depends_on = [
    azurerm_role_assignment.agent_queue_reader,
    azurerm_role_assignment.agent_queue_contributor,
    azurerm_role_assignment.agent_acr_pull,
  ]
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
  sku_name  = "Y1"

  # Consumption plan does not support zone balancing or multiple workers
  zone_balancing_enabled = false
  worker_count           = 1

  tags             = var.tags
  enable_telemetry = false
}

module "function_app" {
  source  = "Azure/avm-res-web-site/azurerm"
  version = "~> 0.21"

  name                          = "func-${local.name_prefix}-${local.name_suffix}"
  location                      = azurerm_resource_group.main.location
  parent_id                     = azurerm_resource_group.main.id
  service_plan_resource_id      = module.function_service_plan.resource_id
  kind                          = "functionapp"
  public_network_access_enabled = true
  tags                          = var.tags
  enable_telemetry              = false

  managed_identities = {
    system_assigned = true
  }

  site_config = {
    always_on = false # Required for Consumption (Y1) plan
    application_stack = {
      python = {
        python_version = "3.11"
      }
    }
  }

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME         = "python"
    AzureWebJobsStorage__accountName = module.storage.name
    AzureWebJobsFeatureFlags         = "EnableWorkerIndexing"
    WEBSITE_RUN_FROM_PACKAGE         = "https://${module.storage.name}.blob.core.windows.net/function-releases/squad-function.zip"
    SquadStorage__queueServiceUri    = "https://${module.storage.name}.queue.core.windows.net"
    SQUAD_QUEUE_NAME                 = var.queue_name
    GITHUB_REPO                      = var.github_repo
    GITHUB_TOKEN                     = var.github_token
    SQUAD_LABELS                     = "squad"
  }
}

# --------------------------------------------------------------------------
# RBAC: Function App → Storage Account (identity-based access)
# --------------------------------------------------------------------------
resource "azurerm_role_assignment" "func_storage_blob_owner" {
  scope                = module.storage.resource_id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = module.function_app.system_assigned_mi_principal_id
}

resource "azurerm_role_assignment" "func_storage_queue_contributor" {
  scope                = module.storage.resource_id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = module.function_app.system_assigned_mi_principal_id
}

resource "azurerm_role_assignment" "func_storage_account_contributor" {
  scope                = module.storage.resource_id
  role_definition_name = "Storage Account Contributor"
  principal_id         = module.function_app.system_assigned_mi_principal_id
}
