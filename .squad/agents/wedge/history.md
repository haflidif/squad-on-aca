# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Agent Wedge initialized as Lead. Responsible for architecture, code review, documentation, and scope management across the squad-on-aca platform.

Key project components:
- `infra/` — Terraform infrastructure using Azure Verified Modules (ACA Environment, Container App Jobs, Storage, ACR, Function App, Log Analytics)
- `agents/` — Agent base Dockerfile with git, gh CLI, Go, Node.js, squad-cli
- `function/` — Python Azure Function (timer-triggered issue poller → Storage Queue)
- `.github/` — GitHub Actions workflows for Ralph heartbeat and event-driven triage

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
### 2026-04-12: README v2 — Single Job + Event Flow + Two-Repo Architecture
- Updated README to reflect single generic Container App Job decision (eliminated 4 hardcoded job diagram)
- Added "How It Works" section explaining 7-step event flow: issue creation → Ralph triage → Function polling → queue → KEDA scaling → agent work → Scribe logging
- Added "Two-Repo Architecture" section clarifying separation: squad-on-aca (platform) vs app repos (where agents work)
- Introduced MVP status badge to set expectations
- Kept AVM modules table and cost breakdown for reference
- Architecture diagram now shows single generic job, eliminating confusion about per-type infrastructure

### 2026-04-14: Comprehensive docs/ Folder — Adoption-Ready Documentation
- Created `docs/architecture.md` — deep architecture docs with 3 Mermaid diagrams (E2E sequence, component diagram, entrypoint flowchart), dual-auth pattern explanation, KEDA scaling model, message flow architecture, RBAC matrix, and container image architecture.
- Created `docs/thought-process.md` — 10 detailed decision rationales covering Container App Jobs vs AKS, KEDA+queue vs webhooks, GitHub App vs PAT, dual-token pattern, identity-based auth, azapi vs AVM, single generic job, self-dequeue, yolo mode, Squad agent mode, and ACR caching.
- Created `docs/limitations.md` — 13 documented limitations categorized by severity (critical/operational/minor) with mitigations: Copilot PAT dependency, runtime limits, no persistent workspace, manual secrets, Docker Hub rates, single queue, no retry, OIDC per-repo, App installation scope, Windows quirks, Squad state conflicts, branch collisions, PR body limits.
- Created `docs/adoption-guide.md` — full step-by-step guide: prerequisites checklist, GitHub App creation, Terraform configuration, infrastructure deployment, secret upload, container build, workflow installation, E2E testing, adding repos, customization, revision loop setup, troubleshooting, and cost worksheet.
