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
