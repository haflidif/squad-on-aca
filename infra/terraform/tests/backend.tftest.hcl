mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id = "00000000-0000-0000-0000-000000000001"
      object_id = "00000000-0000-0000-0000-000000000002"
    }
  }
  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/example"
    }
  }
  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/example/providers/Microsoft.ManagedIdentity/userAssignedIdentities/example"
      client_id    = "00000000-0000-0000-0000-000000000003"
      principal_id = "00000000-0000-0000-0000-000000000004"
      tenant_id    = "00000000-0000-0000-0000-000000000001"
    }
  }
}
# AzAPI has ephemeral resources in AVM dependencies, which Terraform cannot mock.
# All root AzAPI resources and AVM modules are overridden below; no Azure calls occur.
provider "azapi" {
  subscription_id            = "00000000-0000-0000-0000-000000000001"
  tenant_id                  = "00000000-0000-0000-0000-000000000001"
  client_id                  = "00000000-0000-0000-0000-000000000003"
  client_secret              = "synthetic-offline-test-value"
  use_cli                    = false
  use_msi                    = false
  skip_provider_registration = true
}

override_resource {
  target = azapi_resource.squad_agent_job[0]
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/example/providers/Microsoft.App/jobs/example"
  }
}
override_resource {
  target = azapi_resource.sandbox_group[0]
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/example/providers/Microsoft.App/sandboxGroups/example"
  }
}
mock_provider "github" {}
mock_provider "random" {}
mock_provider "modtm" {}
mock_provider "time" {}

override_module {
  target = module.acr
  outputs = {
    resource_id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/example/providers/Microsoft.ContainerRegistry/registries/example"
    resource    = { login_server = "example.azurecr.io" }
  }
}
override_module {
  target = module.log_analytics
  outputs = {
    resource_id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/example/providers/Microsoft.OperationalInsights/workspaces/example"
  }
}
override_module {
  target = module.storage[0]
  outputs = {
    name        = "examplestorage"
    resource_id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/example/providers/Microsoft.Storage/storageAccounts/example"
  }
}
override_module {
  target = module.aca_environment[0]
  outputs = {
    name        = "example-environment"
    resource_id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/example/providers/Microsoft.App/managedEnvironments/example"
  }
}

variables {
  subscription_id            = "00000000-0000-0000-0000-000000000001"
  github_token               = "synthetic-test-token"
  github_app_id              = "1"
  github_app_installation_id = "2"
}

run "default_jobs" {
  command = plan
  assert {
    condition     = length(azapi_resource.squad_agent_job) == 1 && length(azapi_resource.sandbox_group) == 0
    error_message = "Omitted selector must keep Jobs only."
  }
  assert {
    condition     = azapi_resource.squad_agent_job[0].body.properties.template.containers[0].image == "example.azurecr.io/squad-agent:latest"
    error_message = "Default Jobs image must not change."
  }
  assert {
    condition     = output.platform_descriptor == null
    error_message = "Mutable legacy image must not produce a ready descriptor."
  }
}

run "pinned_jobs" {
  command = plan
  variables {
    jobs_image_ref = "example.azurecr.io/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition     = output.platform_descriptor.backend == "jobs" && contains(keys(output.platform_descriptor), "jobs") && !contains(keys(output.platform_descriptor), "sandbox")
    error_message = "Jobs descriptor must include only the selected backend."
  }
  assert {
    condition     = output.platform_descriptor.jobs.image_ref == azapi_resource.squad_agent_job[0].body.properties.template.containers[0].image
    error_message = "Descriptor and deployed Jobs image must match."
  }
}

run "sandbox_only" {
  command = plan
  variables {
    execution_backend          = "sandbox"
    sandbox_image_ref          = "example.azurecr.io/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    github_app_id              = ""
    github_app_installation_id = ""
  }
  assert {
    condition     = length(azapi_resource.squad_agent_job) == 0 && length(module.storage) == 0 && length(module.aca_environment) == 0 && length(azurerm_key_vault.squad) == 0 && length(azurerm_user_assigned_identity.squad_agent) == 0
    error_message = "Sandbox must not create Jobs, queue, managed environment, vault, or Job identity."
  }
  assert {
    condition     = length(azapi_resource.sandbox_group) == 1 && length(azurerm_user_assigned_identity.sandbox_dispatcher) == 1 && length(azurerm_user_assigned_identity.sandbox_image_pull) == 1
    error_message = "Sandbox must use separate dispatcher and image-pull identities."
  }
  assert {
    condition     = output.platform_descriptor.backend == "sandbox" && contains(keys(output.platform_descriptor), "sandbox") && !contains(keys(output.platform_descriptor), "jobs")
    error_message = "Sandbox descriptor must include only the selected backend."
  }
}

run "legacy_additive" {
  command = plan
  variables { enable_aca_sandbox = true }
  assert {
    condition     = length(azapi_resource.squad_agent_job) == 1 && length(azapi_resource.sandbox_group) == 1 && length(azurerm_user_assigned_identity.sandbox_image_pull) == 0 && output.platform_descriptor == null
    error_message = "Legacy additive installs must keep mixed inventory and not claim destination readiness."
  }
}

run "reject_mixed_selector" {
  command = plan
  variables {
    enable_aca_sandbox = true
    execution_backend  = "sandbox"
    sandbox_image_ref  = "example.azurecr.io/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [azapi_resource.sandbox_group]
}

run "reject_plural" {
  command = plan
  variables { execution_backend = "sandboxes" }
  expect_failures = [var.execution_backend]
}

run "reject_missing_sandbox_image" {
  command = plan
  variables { execution_backend = "sandbox" }
  expect_failures = [azapi_resource.sandbox_group]
}
