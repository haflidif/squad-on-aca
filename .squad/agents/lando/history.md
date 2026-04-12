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
- **2026-04-13:** Rewrote `entrypoint.sh` to self-dequeue from Azure Storage Queue using `az storage message get --auth-mode login` (Managed Identity). ACA event-triggered jobs do NOT pass queue messages as env vars — the container must pull the message itself. Added base64 decode of message content, delete-after-parse to prevent reprocessing, and clean exit on empty queue (KEDA race). Added `azure-cli` to Dockerfile runtime stage via pip. Ensured all shell scripts use LF line endings to avoid CRLF breakage in bash line continuations.
- **2026-04-13:** Replaced `squad work` (squad-cli) with a gh-CLI-based workflow in `entrypoint.sh`. Removed `@bradygaster/squad-cli` and Node.js from the Dockerfile — neither is needed anymore. `gh copilot` CLI extension requires an interactive TTY so it cannot work headlessly in a container job. Instead, the entrypoint now reads the issue via `gh issue view`, creates a structured work artifact in `.squad-work/`, commits it, and opens a PR with a status table. This proves the full e2e pipeline works. Documented three future integration paths for actual AI coding: Copilot API, GitHub Models API, and Copilot Coding Agent.
- **2026-04-13:** Integrated GitHub Copilot CLI (`@github/copilot`) into the container. Added Node.js 22 back to both Dockerfile stages and installed the copilot package globally. The entrypoint now pipes issue context to `copilot --yolo` for headless AI coding. Used `set +e` / `PIPESTATUS` to capture copilot failures without killing the script. Falls back to a work artifact (with copilot output log) if copilot fails, so PRs always get created. PR body dynamically reflects whether copilot or fallback was used.
