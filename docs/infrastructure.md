# Infrastructure

> Terraform modules, key architectural decisions, and infrastructure details for Squad on ACA.

---

## Terraform Modules

Squad on ACA uses Microsoft's Azure Verified Modules (AVM) for infrastructure consistency:

| Module | Purpose | Notes |
|--------|---------|-------|
| `azure/avm-res-operationalinsights-workspace` | Log Analytics (required by ACA environment) | Telemetry disabled for cost |
| `azure/avm-res-storage-storageaccount` | Storage account + queues | RBAC-based auth, no shared keys |
| `azure/avm-res-containerregistry-registry` | Container Registry (Basic) | Hosts `squad-agent:latest` image |
| `azure/avm-res-app-managedenvironment` | ACA Managed Environment | Provides KEDA, Log Analytics integration |
| `azapi_resource` (Container App Job) | Generic squad agent job | Custom `azapi_resource` due to identity-based KEDA auth not in AVM |

---

## Key Decisions

These decisions are also captured in `.squad/decisions.md`:

- **Single Generic Job**: One Container App Job handles all agent types. Agent type comes from queue message. Adding new agents = zero infrastructure changes. Agent names come from Squad's casting system, defined in `.squad/team.md`.
- **UAMI for Scaling**: KEDA uses Managed Identity for auth (no connection strings). Storage account blocks shared keys per subscription policy.
- **Container Self-Dequeue**: Each container manages its own queue interaction (dequeue, delete). Enables dedup checks and failsafe behavior.
- **Dual Auth Pattern**: App token for git/PR ops, Copilot PAT for `copilot --yolo`. Both stored in Key Vault, swapped at runtime.
- **Graceful Fallback**: If Copilot fails, work artifact is created so PR still gets made.

---

## Architecture Decisions

Full decision log is in `.squad/decisions.md`. Key architectural choices:

1. **Single Generic Job** — All agent types run on one Container App Job; agent type comes from queue message
2. **Identity-Based Auth Everywhere** — No shared keys, all Azure API calls use Managed Identity
3. **KEDA + Storage Queue** — Event-driven scaling; KEDA polls every 30s
4. **Container Self-Dequeue** — Container owns queue interaction; enables dedup and failsafe
5. **Copilot CLI --yolo** — Ephemeral container is safe to run with yolo mode; graceful fallback on failure
6. **Dual Auth (App token + Copilot PAT)** — GitHub Apps can't hold licenses; use PAT for `copilot` CLI only

---

## Component Overview

### Azure Container App Job
- **Event-driven**: Triggered by KEDA when a message appears in the queue
- **Ephemeral**: Runs on-demand, no idle resources
- **Identity-based auth**: Uses User-Assigned Managed Identity (UAMI) for all Azure API calls—zero shared keys
- **Scaling**: 0 to N parallel executions (configurable, default 10)
- **Timeout**: Configurable per-job (default 30 minutes)

### Azure Storage Queue
- **Message broker**: GitHub Actions enqueues work, container dequeues
- **Message format**: Base64-encoded JSON
  ```json
  {
    "issue_number": 42,
    "agent_type": "{agent-name}",
    "repo": "owner/repo",
    "title": "Issue title"
  }
  ```
  > **Note**: `agent_type` is extracted from the label name (e.g., `squad:{agent-name}` → `{agent-name}`). Agent names come from your team's `.squad/team.md`, created during Squad initialization.
- **TTL**: 24 hours per message
- **Auth**: Identity-based (UAMI), no shared keys

### GitHub Actions Workflow (`squad-queue.yml`)
- **Trigger**: Issue labeled `squad:*` (e.g., `squad:{agent-name}` — agent names come from your team's `.squad/team.md`)
- **Steps**:
  1. Dedup check (skip if `squad:processing` label already set)
  2. OIDC login to Azure (federated credentials, zero secrets)
  3. Add `squad:processing` label to prevent duplicate processing
  4. Extract agent type from label name (e.g., `squad:{agent-name}` → `{agent-name}`)
  5. Enqueue message to Storage Queue with identity-based auth
- **Permissions**: `id-token: write`, `issues: write`, `contents: read`

### GitHub App (`squad-aca-bot[bot]`)
- **Purpose**: Bot identity for all PR operations (create, comment)
- **Private key**: Stored in Azure Key Vault, never written to disk
- **Auth flow**:
  1. Container retrieves PEM from Key Vault
  2. Generate JWT (10-minute expiry)
  3. Exchange JWT for installation access token (1-hour expiry)
  4. Use token for git push, PR creation, label management
- **One app per environment**: Simplifies permission model

### Azure Key Vault
- **Secrets stored**:
  - `github-app-private-key`: GitHub App PEM (uploaded manually via `az keyvault secret set`)
  - `copilot-pat`: Copilot-licensed GitHub PAT (uploaded manually)
- **Access**: RBAC-based, no access policies
- **UAMI permissions**: Key Vault Secrets User (read-only at runtime)

### Dual Auth Pattern
GitHub Apps cannot hold Copilot licenses. Squad on ACA uses a dual-token approach:
- **App token** (from GitHub App installation): git push, PR creation, issue operations
- **Copilot PAT** (from a Copilot-licensed user): `copilot --yolo` CLI invocation only
- Both are stored in Key Vault; the container swaps them as needed during execution

### Container Image
- **Base**: `debian:bookworm-slim` (minimal runtime)
- **Tooling**:
  - `gh` CLI (GitHub operations)
  - `git` (repository cloning, commits)
  - `@github/copilot` CLI (AI coding)
  - `az` CLI + Python (Azure authentication)
  - `jq` (JSON parsing)
  - `openssl` (JWT generation)
- **Entrypoint**: `entrypoint.sh` orchestrates the entire workflow

### Container Entrypoint (`agents/base/entrypoint.sh`)
The entrypoint implements the core agent lifecycle:
1. **MI login**: `az login --identity --client-id`
2. **Dequeue**: Read one message from Storage Queue
3. **Dedup checks**: Verify `squad:processing` label, no existing PR/branch, prevent race conditions
4. **Git identity**: Configure `user.name` = `squad-aca-bot[bot]`
5. **Clone repo**: `gh repo clone {owner/repo}`
6. **Create branch**: `squad/{agent_type}/issue-{issue_number}`
7. **Fetch issue**: Get title, body, labels from GitHub API
8. **Run Copilot**: `copilot --yolo --agent squad` (reads issue body, makes changes)
9. **Fallback**: If Copilot fails, create work artifact in `.squad-work/`
10. **Team state**: Commit any `.squad/` changes (decisions, history)
11. **Push + PR**: Push branch, create PR with enriched body
12. **Label swap**: Remove `squad:processing`, add `squad:queued`
