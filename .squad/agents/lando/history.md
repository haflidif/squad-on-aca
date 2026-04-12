# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Agent Lando initialized as Container Dev. Responsible for the agent base Dockerfile in `agents/` — container image packaging git, gh CLI, Go, Node.js, and squad-cli for running squad agents on Azure Container App Jobs.

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
