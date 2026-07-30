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
