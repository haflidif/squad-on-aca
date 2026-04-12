# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Agent Bodhi initialized as Function Dev. Responsible for the Python Azure Function in `function/` — timer-triggered issue poller that fetches GitHub issues and enqueues them to Azure Storage Queue for Container App Job processing.

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->

### 2026-04-12: Migrated issue poller to v2 programming model

- Replaced v1 `function.json` + `__init__.py` with v2 `function_app.py` using decorators.
- Queue message schema aligned to team decision: `{issue_number, agent_type, repo, title}`.
- `agent_type` is extracted from `squad:{member}` labels — issues without one are skipped (untriaged).
- Added GitHub API pagination, retry with exponential backoff (3 retries, factor 2, respects Retry-After header).
- Added rate limit monitoring via `X-RateLimit-Remaining` header.
- Deduplication via in-memory `seen` set per invocation.
- PRs are filtered out (GitHub API returns them as issues).
- Pinned dependencies: `azure-functions==1.21.3`, `requests==2.32.3`, `urllib3==2.4.0`.
