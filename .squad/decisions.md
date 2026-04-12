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

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
