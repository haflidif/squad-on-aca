# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Agent Chewie initialized as IaC Dev. Responsible for all Terraform infrastructure in `infra/` using Azure Verified Modules — ACA Environment, Container App Jobs, Storage Account + Queue, Container Registry, Function App, Log Analytics.

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->

- **2026-04-12 — Single generic Container App Job:** Replaced 4 per-agent-type jobs (backend/frontend/tester/docs) with one `module "squad_agent_job"`. AGENT_TYPE is now parsed from the queue message JSON at runtime by `entrypoint.sh`, not set as a static env var. Scaling is 0–10 via KEDA azure-queue scaler. Resource config exposed via `var.agent_job_config` (cpu, memory, max_executions, timeout_seconds) with validation rules.
- **Key files:** `infra/main.tf` (single job module), `infra/variables.tf` (agent_job_config variable), `infra/outputs.tf` (agent_job_name output).
- **Pre-existing issue noted:** `module.aca_environment` uses `log_analytics_workspace_id` which the AVM module ~>0.4 doesn't support — not fixed here, outside scope of this change.
- **2026-04-12 — Fixed ACA environment Log Analytics wiring:** The AVM module `Azure/avm-res-app-managedenvironment/azurerm ~>0.4` does NOT accept `log_analytics_workspace_id`. It expects `log_analytics_workspace = { resource_id = "..." }` (an object). Changed reference to use `module.log_analytics.resource_id` (non-sensitive output) instead of `module.log_analytics.resource.id`. Also set `zone_redundancy_enabled = false` since it defaults to `true` in the module and our dev environment doesn't need it.
- **Remaining pre-existing issue:** `module.function_service_plan` uses `sku = { name = "Y1" }` but `avm-res-web-serverfarm ~>2.0` may not accept that argument — needs separate fix.
- **2026-04-12 — Fixed all terraform validate errors:** Three fixes applied:
  1. **Service plan SKU:** `avm-res-web-serverfarm ~>2.0` uses `sku_name = "Y1"` (flat string), not `sku = { name = "Y1" }` (object). Also set `zone_balancing_enabled = false` and `worker_count = 1` since Consumption plan doesn't support these.
  2. **Function app site_config:** Added `always_on = false` — Consumption (Y1) plan does not support always-on.
  3. **Agent job output:** `avm-res-app-job ~>0.2` exports `container_app_job_name`, not `resource.name`. Fixed `outputs.tf` reference.
  - Full `terraform validate` now returns **Success**.
- **2026-04-12 — Identity-based storage auth for Function App:** Subscription policy blocks key-based auth on storage accounts (`KeyBasedAuthenticationNotPermitted`). Fixed by: (1) Set `shared_access_key_enabled = false` on storage module to align with policy. (2) Enabled system-assigned managed identity on Function App via `managed_identities = { system_assigned = true }`. (3) Replaced `AzureWebJobsStorage` (connection string) with `AzureWebJobsStorage__accountName` (identity-based). (4) Added three `azurerm_role_assignment` resources granting the Function App's MI: Storage Blob Data Owner, Storage Queue Data Contributor, and Storage Account Contributor on the storage account. Queue output binding uses the same `AzureWebJobsStorage__accountName` setting automatically.
  - **Follow-up needed:** Container App Job (`module.squad_agent_job`) still references `module.storage.resource.primary_connection_string` for its `storage-connection` secret and KEDA scaler auth — needs its own identity-based migration.
- **2026-04-13 — OIDC federated identity credentials for GitHub Actions:** Added `azurerm_federated_identity_credential.github_actions` using `for_each` over `var.target_repos`. Allows GitHub Actions workflows (running on `main` branch) from listed repos to authenticate as the existing UAMI via OIDC — no secrets needed. Subject claim: `repo:{owner/repo}:ref:refs/heads/main`. For `issues` event triggers the workflow runs on the default branch, so this subject matches. Added outputs `squad_agent_client_id` and `squad_agent_tenant_id` for workflow configuration. Existing RBAC (Storage Queue Data Contributor) covers the queue-push use case with no additional roles.
