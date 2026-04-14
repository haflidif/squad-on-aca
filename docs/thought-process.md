# Thought Process

> The WHY behind every architectural decision in Squad on ACA. Each section explains the alternatives considered, the tradeoffs, and why we chose what we chose.

---

## Why Container App Jobs instead of AKS?

**Decision**: Use Azure Container App Jobs (event-driven) instead of Azure Kubernetes Service (AKS).

**Alternatives considered**:
- **AKS**: Full Kubernetes cluster, maximum flexibility
- **Azure Container Instances (ACI)**: Simple container hosting
- **App Service**: PaaS web hosting with container support
- **Azure Functions**: Serverless compute (considered for the agent itself)

**Why Container App Jobs wins**:

| Factor | AKS | Container App Jobs |
|--------|-----|--------------------|
| Idle cost | ~$72/month (node always running) | **$0** (scale to zero) |
| Complexity | kubectl, helm, ingress, cert-manager | Zero Kubernetes knowledge needed |
| Scale to zero | Requires KEDA addon + careful config | Built-in, automatic |
| Container support | Full Docker, any image | Full Docker, any image |
| Event triggers | KEDA addon | KEDA built-in |
| Timeout | Unlimited | 30 min default (configurable) |
| Setup time | Hours (cluster, RBAC, networking) | Minutes (Terraform apply) |

The **cost model is decisive**: Squad agents run for ~5 minutes per issue. Paying $72/month for an AKS cluster that sits idle 99% of the time makes no sense. Container App Jobs charge only for active execution time.

The 30-minute timeout is acceptable because Copilot CLI typically completes in under 5 minutes. If a task needs more, increase `agent_job_config.timeout_seconds`.

---

## Why KEDA + Storage Queue instead of webhooks?

**Decision**: GitHub Actions enqueue messages to Azure Storage Queue; KEDA polls and triggers containers. No webhook server.

**Alternatives considered**:
- **GitHub webhooks → API endpoint**: Webhook hits an Azure Function or API that starts the container directly
- **GitHub Actions → direct container start**: Workflow calls `az containerapp job start` directly
- **Event Grid**: Azure-native event routing

**Why queue-based wins**:

1. **Decoupling**: The workflow (producer) doesn't need to know how containers are started. It just puts a message on a queue. KEDA handles the rest.

2. **Built-in retry**: If the container infrastructure is temporarily down, messages stay in the queue (24hr TTL). Webhooks would just fail and be lost.

3. **No webhook server**: A webhook endpoint needs to be publicly accessible, TLS-terminated, authenticated, and always running. That's an entire service to maintain just to receive a JSON POST. The queue eliminates all of this.

4. **Parallelism control**: KEDA's `maxExecutions` setting caps how many containers run simultaneously. With webhooks, you'd need a separate rate limiter.

5. **Audit trail**: Messages in the queue are visible via Azure Portal or CLI. Webhook calls disappear after delivery.

6. **GitHub Actions as the bridge**: Using a workflow as the "webhook handler" is free (GitHub-hosted runners), already has OIDC auth to Azure, and can do dedup checks before enqueuing.

---

## Why a GitHub App instead of a PAT for PR operations?

**Decision**: Use a GitHub App (`squad-aca-bot[bot]`) for all repository operations (commits, PRs, labels).

**Alternatives considered**:
- **Personal Access Token (PAT)**: Simple, one token does everything
- **GitHub Actions token (`GITHUB_TOKEN`)**: Built-in, per-workflow
- **OAuth App**: App-level access

**Why GitHub App wins**:

1. **Organization-owned**: The App belongs to the org, not a person. When team members leave, the bot keeps working.

2. **Audit trail**: All commits and PRs are attributed to `squad-aca-bot[bot]`, not a personal account. This makes it clear which changes are bot-generated.

3. **Minimal scope**: The App only gets Issues (R/W), Pull Requests (R/W), and Contents (R/W). A PAT with `repo` scope gives access to *everything*.

4. **No personal credentials**: The App's private key lives in Key Vault. No one's personal GitHub password or PAT is baked into infrastructure.

5. **Installation tokens expire**: Each token lasts 1 hour and is generated on-demand. A leaked PAT works until manually revoked.

---

## Why dual-token (App + PAT) instead of single auth?

**Decision**: Use the GitHub App token for git/PR operations and a separate Copilot-licensed PAT for `copilot --yolo`.

**Why not just one token?**

GitHub Apps **cannot hold Copilot licenses**. The Copilot CLI (`@github/copilot`) checks the `GITHUB_TOKEN` env var and validates that the associated account has an active Copilot subscription. Since GitHub Apps are not "users," they can't have Copilot subscriptions.

This is a **GitHub platform limitation**, not a design choice. If GitHub ever allows Apps to hold Copilot licenses, the dual-token pattern can be removed.

**The swap mechanism** in `entrypoint.sh`:
```
1. Generate App token (git push, PR create)
2. Retrieve Copilot PAT from Key Vault
3. Before Copilot: export GITHUB_TOKEN="${COPILOT_TOKEN}"
4. Run Copilot CLI
5. After Copilot: export GITHUB_TOKEN="${APP_TOKEN}"
6. Push, create PR, manage labels
```

---

## Why identity-based auth everywhere?

**Decision**: All Azure service-to-service auth uses Managed Identity. No shared keys, connection strings, or stored secrets for Azure services.

**Why?**

1. **Subscription policy enforcement**: The subscription enforces `KeyBasedAuthenticationNotPermitted` on storage accounts. Shared key access is literally blocked — `allowSharedKeyAccess = false` is not optional.

2. **Zero secret rotation**: Managed Identity tokens are issued and rotated automatically by Azure AD. No one needs to remember to rotate a connection string.

3. **Least privilege**: Each identity gets exactly the RBAC roles it needs. The UAMI has Queue Data Reader (KEDA), Queue Data Contributor (dequeue), AcrPull (image pull), Key Vault Secrets User (read secrets). Nothing more.

4. **OIDC for GitHub Actions**: Workflows authenticate via OIDC federated credentials — no Azure secrets stored in GitHub. The OIDC token is exchanged for an Azure token at runtime.

5. **Defense in depth**: Even if the container is compromised, the UAMI can only read queue messages, pull images, and read two Key Vault secrets. It can't create resources, modify infrastructure, or access other subscriptions.

---

## Why `azapi_resource` instead of AVM for the Container App Job?

**Decision**: Use `azapi_resource` (raw ARM API) for the Container App Job instead of the Azure Verified Module (`avm-res-app-containerapp`).

**Why?**

The AVM module for Container App Jobs does not support **identity-based KEDA auth** at the scale rule level. The KEDA azure-queue scaler needs an `identity` field to use Managed Identity instead of a connection string secret:

```hcl
# What we need (only possible with azapi_resource):
rules = [{
  name = "queue-scaling"
  type = "azure-queue"
  metadata = { ... }
  identity = azurerm_user_assigned_identity.squad_agent.id  # NOT supported in AVM
}]
```

The AVM module only supports `auth[].secretRef` for KEDA authentication, which requires a connection string secret. Since the subscription blocks shared key access, connection strings don't work.

**Tradeoff**: We lose the validation, defaults, and ergonomics of AVM for this one resource. We mitigate by:
- Using `schema_validation_enabled = false` (the azapi schema is behind the ARM API)
- Pinning the API version (`2025-01-01`)
- Documenting the decision in `.squad/decisions.md`

All other resources (Storage, ACR, ACA Environment, Function App) still use AVM modules.

---

## Why single generic job instead of per-agent jobs?

**Decision**: One Container App Job handles all agent types (backend, frontend, tester, docs). The agent type is parsed from the queue message at runtime.

**Alternatives considered**:
- **Per-agent jobs**: `job-squad-backend`, `job-squad-frontend`, `job-squad-tester`, etc.
- **Per-agent queues**: Separate queue for each agent type

**Why single job wins**:

1. **Zero infra changes for new agents**: Adding a new agent type (e.g., `squad:security`) requires only creating the label on GitHub. No Terraform changes, no new Container App Job, no new queue.

2. **Simplified scaling**: One KEDA trigger, one queue, one scaling policy. Per-agent jobs would need per-agent KEDA configs with per-agent RBAC.

3. **Same image**: All agent types use the same container image. The entrypoint script parses `agent_type` from the message and passes `@{agent_type}` to Copilot's Squad framework, which routes to the correct agent charter.

4. **Uniform resource allocation**: All agents get the same CPU/memory (1.0 CPU, 2Gi RAM). If per-agent tuning is needed later, it moves into container logic (e.g., the entrypoint could set resource limits based on agent type).

**Original design** had 4 separate jobs with hardcoded `AGENT_TYPE` env vars and different CPU/memory configs. This was eliminated in the "Single Generic Container App Job" decision (2026-04-12).

---

## Why container self-dequeues instead of KEDA auto-dequeue?

**Decision**: The container manages its own queue interaction (dequeue, parse, delete) instead of letting KEDA auto-dequeue.

**Why?**

1. **Deduplication**: Before doing work, the container checks:
   - Does the issue already have `squad:queued` label? (PR was already created)
   - Does the issue still have `squad:processing` label? (hasn't been handled)
   - Is there an existing open PR for this issue?
   - Is there an existing branch for this issue?
   
   These checks can't happen if KEDA auto-dequeues and passes the message as environment variables.

2. **Message deletion control**: The container deletes the message **immediately after parsing**, not after successful processing. This prevents a failed container from being retried on the same message (which would likely fail again with the same error).

3. **Empty queue handling**: KEDA may trigger a container after the queue has already been drained by a parallel container. The entrypoint detects `"[]"` or `"null"` responses and exits cleanly (`exit 0`). This is the expected "over-trigger" behavior.

4. **Message format control**: The container parses the full JSON message including revision-specific fields (`pr_number`, `branch`, `head_sha`, `feedback`). KEDA auto-dequeue only passes simple metadata.

---

## Why `--yolo` mode?

**Decision**: Run Copilot CLI with `--yolo` flag, which auto-approves all tool calls without human confirmation.

**Why this is safe**:

1. **Ephemeral container**: The container is destroyed after execution. Any damage is contained to the workspace directory, which is thrown away.

2. **No human interaction possible**: Container App Jobs have no TTY, no stdin, no way to prompt for confirmation. Without `--yolo`, every Copilot tool call would hang waiting for approval that can never come.

3. **Branch isolation**: All changes are committed to a feature branch (`squad/{agent}/issue-{N}`), never to `main`. A human must review and merge the PR.

4. **Graceful fallback**: If Copilot makes destructive changes or fails, the entrypoint creates a work artifact instead. The PR still gets created, but with a diagnostic note rather than broken code.

5. **Read-only secrets**: The Copilot PAT can only access the Copilot API. The App token has minimal scope (issues, PRs, contents). Neither can modify infrastructure or access other repos.

---

## Why Squad agent mode (`copilot --yolo --agent squad`)?

**Decision**: Use the `--agent squad` flag to invoke Squad's multi-agent orchestration framework.

**Why?**

1. **Charter-aware routing**: The prompt starts with `@{agent_type}`, which Squad routes to the correct agent charter in `.squad/team.md`. A "backend" agent gets backend-specific instructions.

2. **Multi-agent orchestration**: Inside a single container, Squad can spawn sub-agents if the charter allows. The "Lead" agent can delegate to "Tester" or "Docs" agents within the same invocation.

3. **State persistence**: Squad reads and writes `.squad/` files (decisions, history, routing). These flow through PRs back into the repo, building institutional memory over time.

4. **Consistent identity**: Without `--agent squad`, Copilot uses its default personality. With it, each invocation is grounded in the team's specific context, conventions, and history.

---

## Why ACR-cached base images instead of Docker Hub?

**Decision**: Import Docker Hub base images into ACR and reference them from there in the Dockerfile.

**Why?**

1. **Docker Hub rate limits**: Anonymous pulls are limited to 100 per 6 hours per IP. Authenticated pulls are 200. In a CI/CD environment with frequent builds, these limits are quickly hit.

2. **Reliability**: Docker Hub has had multiple outages. ACR is in the same Azure region as the build agent, eliminating cross-internet dependencies.

3. **Speed**: Pulling from ACR (same region) is faster than pulling from Docker Hub.

4. **Security scanning**: ACR can scan imported images for vulnerabilities before they're used in builds.

**One-time import**:
```bash
az acr import --name <acr> \
  --source docker.io/library/golang:1.23.4-bookworm \
  --image base/golang:1.23.4-bookworm

az acr import --name <acr> \
  --source docker.io/library/debian:bookworm-20240701-slim \
  --image base/debian:bookworm-20240701-slim
```

**Tradeoff**: Base images don't auto-update. You must re-import when upgrading Go, Debian, or Node versions. This is intentional — it pins versions for reproducibility.
