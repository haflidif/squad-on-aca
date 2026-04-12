# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Agent Bodhi initialized as Function Dev. Responsible for the Python Azure Function in `function/` — timer-triggered issue poller that fetches GitHub issues and enqueues them to Azure Storage Queue for Container App Job processing.

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
