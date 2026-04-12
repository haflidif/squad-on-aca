# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Agent Lando initialized as Container Dev. Responsible for the agent base Dockerfile in `agents/` — container image packaging git, gh CLI, Go, Node.js, and squad-cli for running squad agents on Azure Container App Jobs.

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->

- **2026-04-12:** Converted Dockerfile to a proper multi-stage build (golang:1.23.4-bookworm → debian:bookworm-slim runtime). Pinned all base image versions. Added OCI labels. Created `.dockerignore`. This drops the full Go SDK build tooling from the runtime layer and cuts image size significantly.
- **2026-04-12:** Rewrote `entrypoint.sh` to parse `QUEUE_MESSAGE` JSON (containing `issue_number`, `agent_type`, `repo`) instead of expecting separate env vars. This aligns with the single-job design decision — agent_type comes from the queue, not from infra config. Added timestamped logging, `die()` helper, git identity config, and `|| die` guards on every critical command.
