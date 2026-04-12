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
