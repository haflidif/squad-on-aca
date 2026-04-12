# Squad Decisions

## Active Decisions

### 2026-04-12: Single Generic Container App Job

**Author:** Chewie (IaC Dev)  
**Status:** Implemented

**Context:** The original infra had 4 separate Container App Jobs — one per agent type (backend, frontend, tester, docs). All used the same container image but had hardcoded `AGENT_TYPE` env vars and different CPU/memory/scaling configs.

**Decision:** Replace the 4 jobs with ONE generic `squad_agent_job`. The queue message JSON contains `agent_type`, and `entrypoint.sh` parses it at runtime. This eliminates per-type infrastructure sprawl and makes adding new agent types a zero-infra-change operation.

**Changes:**
- `infra/main.tf`: Removed `local.agent_jobs` map and `module "agent_jobs"` with `for_each`. Added `module "squad_agent_job"` — single job, no `AGENT_TYPE` env var, configurable via `var.agent_job_config`.
- `infra/variables.tf`: Added `agent_job_config` object variable with cpu (default 1.0), memory (default 2Gi), max_executions (default 10), timeout_seconds (default 1800) — all with validation rules.
- `infra/outputs.tf`: Replaced `agent_job_names` map output with scalar `agent_job_name`.

**Consequences:**
- Adding new agent types requires zero Terraform changes.
- Scaling is uniform across all agent types (0–10 max executions).
- Per-type resource tuning, if needed later, moves into container logic or queue routing.

### 2026-04-12: Identity-Based Storage Auth for Function App

**Author:** Chewie (IaC Dev)  
**Status:** Implemented

**Context:** Subscription policy enforces `KeyBasedAuthenticationNotPermitted` on storage accounts. Function App's `AzureWebJobsStorage` connection string approach was blocked.

**Decision:** Switch to identity-based storage using system-assigned managed identity. Replaced `AzureWebJobsStorage` with `AzureWebJobsStorage__accountName`. Added RBAC: Blob Data Owner, Queue Data Contributor, Storage Account Contributor.

### 2026-04-12: KEDA Scaler — Managed Identity Auth

**Author:** Coordinator  
**Status:** Implemented

**Context:** KEDA azure-queue scaler used connection string secret for auth. Subscription policy blocks shared key access (`allowSharedKeyAccess=false` enforced, cannot override). KEDA never triggered because connection string was invalid.

**Decision:** Create User-Assigned Managed Identity (UAMI) for the Container App Job. Use `identity` field at the KEDA scale rule level instead of `auth[].secretRef`. Replaced AVM job module with `azapi_resource` because azurerm provider doesn't support identity-based KEDA auth. ACR image pull also switched from admin credentials to UAMI + AcrPull role.

**Changes:**
- `azurerm_user_assigned_identity.squad_agent` created with Queue Data Reader, Queue Data Contributor, AcrPull roles
- `azapi_resource.squad_agent_job` replaces `module.squad_agent_job` (AVM)
- API version: `2025-01-01`, `schema_validation_enabled = false` (azapi schema behind ARM API)
- Storage `shared_access_key_enabled = false` (honest about policy enforcement)

**Consequences:**
- KEDA triggers correctly — 14 executions detected immediately after deploy
- No shared keys or connection strings anywhere in the platform
- azapi_resource used instead of AVM module (minor drift from AVM-everywhere pattern)

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
