# --------------------------------------------------------------------------
# Data Sources
# --------------------------------------------------------------------------
data "azurerm_client_config" "current" {}

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
  public_network_access_enabled   = true  # See issue #8 for private networking support
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

  name                    = local.acr_name
  location                = azurerm_resource_group.main.location
  resource_group_name     = azurerm_resource_group.main.name
  sku                     = "Basic"
  admin_enabled           = true
  zone_redundancy_enabled = false
  tags                    = var.tags
  enable_telemetry        = false
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

# RBAC: UAMI → AcrPush (import base images from Docker Hub)
resource "azurerm_role_assignment" "agent_acr_push" {
  scope                = module.acr.resource_id
  role_definition_name = "AcrPush"
  principal_id         = azurerm_user_assigned_identity.squad_agent.principal_id
}

# --------------------------------------------------------------------------
# OIDC Federated Identity Credentials — GitHub Actions
# Allows workflows from target repos to authenticate as the UAMI via OIDC
# and push messages to the Storage Queue without secrets.
# --------------------------------------------------------------------------
resource "azurerm_federated_identity_credential" "github_actions" {
  for_each = toset(var.target_repos)

  name      = "ghactions-${replace(replace(each.value, "/", "-"), ".", "-")}"
  parent_id = azurerm_user_assigned_identity.squad_agent.id
  audience  = ["api://AzureADTokenExchange"]
  issuer    = "https://token.actions.githubusercontent.com"
  subject   = "repo:${each.value}:ref:refs/heads/main"
}

# --------------------------------------------------------------------------
# Azure Key Vault — GitHub App private key storage
# RBAC-based access only (no access policies)
# --------------------------------------------------------------------------
resource "azurerm_key_vault" "squad" {
  name                       = "kv-squad-${local.name_suffix}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled       = true
  purge_protection_enabled         = false # Dev environment — allow purge
  public_network_access_enabled    = true  # See issue #8 for private networking support
  tags                             = var.tags
}

# RBAC: UAMI → Key Vault Secrets User (read secrets at runtime)
resource "azurerm_role_assignment" "agent_keyvault_reader" {
  scope                = azurerm_key_vault.squad.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.squad_agent.principal_id
}

# RBAC: Deployer → Key Vault Secrets Officer (upload PEM via TF)
resource "azurerm_role_assignment" "deployer_keyvault_officer" {
  scope                = azurerm_key_vault.squad.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# NOTE: GitHub App private key is uploaded manually to Key Vault via:
#   az keyvault secret set --vault-name "kv-squad-XXXX" --name "github-app-private-key" --file ./path-to.pem
# This keeps the PEM out of Terraform state entirely.
#
# NOTE: Copilot CLI PAT is also uploaded manually (requires a Copilot-licensed user token):
#   az keyvault secret set --vault-name "kv-squad-XXXX" --name "copilot-pat" --value "<PAT>"
# The container reads this via COPILOT_TOKEN_SECRET_NAME + KEY_VAULT_NAME env vars.

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
        replicaTimeout    = var.agent_job_config.timeout_seconds
        replicaRetryLimit = 0
        triggerType       = "Event"

        secrets = []

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
              { name = "GITHUB_APP_ID", value = var.github_app_id },
              { name = "GITHUB_APP_INSTALLATION_ID", value = var.github_app_installation_id },
              { name = "KEY_VAULT_NAME", value = azurerm_key_vault.squad.name },
              { name = "KEY_VAULT_SECRET_NAME", value = "github-app-private-key" },
              { name = "QUEUE_NAME", value = var.queue_name },
              { name = "AZURE_STORAGE_ACCOUNT", value = local.storage_account_name },
              { name = "AZURE_CLIENT_ID", value = azurerm_user_assigned_identity.squad_agent.client_id },
              { name = "COPILOT_TOKEN_SECRET_NAME", value = "copilot-pat" },
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
    azurerm_role_assignment.agent_keyvault_reader,
  ]
}

