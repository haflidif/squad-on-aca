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
