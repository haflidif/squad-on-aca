# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Agent Cassian initialized as Tester. Responsible for testing and validation across the platform — Terraform validation, Python function tests, Docker build verification, edge cases, and CI test configuration.

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
- **2026-07-30 — Issue #9 azd/Bicep delivered:** Validated Bicep build/lint, bicepparam build, Terraform validate from `infra/terraform/`, azure.yaml parsing, hook syntax, stale Terraform paths, and parity; fixed shell hook LF enforcement via `.gitattributes`.
- **2026-07-31 — Issue #9 e2e testing tooling delivered:** Authored `infra/tests/whatif.{sh,ps1}` (what-if dry run), `infra/tests/smoke-test.{sh,ps1}` (19-assertion smoke suite with opt-in job execution test), `infra/tests/e2e.{sh,ps1}` (full provision→test→teardown loop with trap/try-finally teardown guarantee and --deploy guard). Added `docs/e2e-testing.md` and decision record. All scripts syntax-validated (bash -n + PowerShell ScriptBlock parse). Committed on `squad/9-azd-bicep-support`.
- **2026-07-31 — Issue #9 --parameters gotcha fixed:** Initial what-if scripts joined all `--parameters` values into a single space-separated string for one `--parameters` flag. `az` treats the whole blob as one parameter name → `ERROR: unrecognized template parameter '...\main.bicepparam githubAppId'`. Fix: one `--parameters` flag per value. Proved by running what-if against live sub (exit 0, 12 resources previewed).
- **2026-07-31 — Issue #9 live e2e run complete (subscription 1d2c04aa, swedencentral):** Deployed via `az deployment sub create` (not `azd provision` — `.bicepparam` has hardcoded placeholder values that `azd env set` can't override). Three defects found and fixed: (1) Container App Job fails on first deploy because ARM validates the image exists in ACR (chicken-and-egg) → fixed by using MCR placeholder image as default, postprovision hook does `az containerapp job update` after ACR build. (2) Smoke test queue check uses storage data plane API requiring Queue RBAC the deployer doesn't have → fixed to use ARM resource API. (3) KV secret error message didn't distinguish network-blocked from not-found → improved. Subscription policy forces KV `publicNetworkAccess: Disabled` overriding Bicep setting — documented as constraint. Result: 20/23 PASS (3 FAIL all KV-network-policy related). Teardown: KV purged, RG deleted. All fixes committed (commits 3c1da5d, f26b9d5).
