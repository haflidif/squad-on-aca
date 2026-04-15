# Blog Source Material — Squad on ACA

> **Purpose**: Raw material for Haflidi's Blog Squad to write a compelling blog post / LinkedIn article about the squad-on-aca project. This is NOT a finished blog post — it's all the ingredients for one.
>
> **Repo**: https://github.com/haflidif/squad-on-aca
> **Author of source material**: Wedge (Lead Agent), compiled 2026-04-15
> **Target length for final post**: 2,000–3,000 words
> **Angle**: The journey and discovery — NOT cost savings as the primary hook

---

## 1. The Origin Story

### The Spark

The [Squad framework](https://bradygaster.github.io/squad/) by Brady Gaster is a multi-agent AI development system that runs inside GitHub Copilot CLI. Squad's documentation mentioned running on **AKS (Azure Kubernetes Service) with KEDA** for event-driven scaling. Someone asked the question: **"Does this work on Azure Container Apps?"**

That question was interesting because:

- **Azure Container App Jobs** are event-driven, ephemeral, and serverless-adjacent — they only run when triggered and scale to zero when idle.
- **KEDA is built into ACA** — no addon installation, no cluster configuration, no kubectl knowledge required.
- **AKS costs ~$72/month idle** (the control plane node is always running). ACA Jobs cost **$0 when idle** — you only pay for active execution time.
- The concept of ephemeral, isolated containers mapping perfectly to AI agent "jobs" — wake up, do work, shut down, no state leaks.

### The Decision to Build

Haflidi Fridthjofsson decided to see if it was possible: take the Squad multi-agent framework, wire it to Azure Container App Jobs via KEDA and Storage Queues, and build a fully serverless AI agent platform that:
1. Responds to GitHub issues
2. Wakes up an AI agent in a container
3. Writes code using GitHub Copilot CLI
4. Opens a pull request
5. Shuts down — $0 until the next issue

The entire project was built in roughly **3 days** (April 12–14, 2026), with a team of AI agents (running in Squad itself) doing much of the implementation work. The irony: **Squad agents built the platform that runs Squad agents.**

---

## 2. Architecture Overview

### The Full Flow

```
GitHub Issue (labeled squad:{agent-name})
    ↓
GitHub Actions Workflow (OIDC auth → zero secrets)
    ↓
Azure Storage Queue (message broker)
    ↓
KEDA Auto-Scaler (polls queue every 30s)
    ↓
Container App Job (ephemeral, spins up on demand)
    ↓
Entrypoint Script (MI auth → dequeue → dedup checks)
    ↓
Copilot CLI (--yolo mode → reads issue → analyzes → writes code)
    ↓
Pull Request (created by squad-aca-bot[bot])
    ↓
Enriched PR Body (agent summary, commits, decisions)
```

### Step-by-Step Narrative

1. **A developer labels a GitHub issue** with `squad:{agent-name}` (e.g., `squad:chewie` for infrastructure work). The agent name comes from Squad's casting system — this project uses Star Wars characters.

2. **A GitHub Actions workflow fires** on the `issues.labeled` event. It authenticates to Azure using OIDC federated credentials (zero secrets stored in GitHub), adds a `squad:processing` label to prevent duplicates, and enqueues a base64-encoded JSON message to an Azure Storage Queue.

3. **KEDA polls the queue every 30 seconds.** When it detects messages, it triggers an Azure Container App Job — one container per message. When the queue is empty, KEDA scales to zero. No containers running, no cost.

4. **The container boots** with a Debian-slim image containing git, GitHub CLI, Azure CLI, Node.js, and the @github/copilot npm package. It authenticates via User-Assigned Managed Identity.

5. **The entrypoint script (`entrypoint.sh`)** self-dequeues a message from the Storage Queue using `az storage message get --auth-mode login`. It deletes the message immediately (preventing reprocessing), then runs dedup checks: does a PR already exist? Does the branch already exist? Is the issue already handled?

6. **Authentication dance**: The container retrieves a GitHub App private key (PEM) from Azure Key Vault, generates a JWT (RS256, 10-minute expiry), exchanges it for a 1-hour installation token. Then retrieves a separate Copilot PAT from Key Vault (because GitHub Apps can't hold Copilot licenses).

7. **The container clones the target repo**, creates a branch (`squad/{agent-name}/issue-{N}`), fetches the issue title and body, and pipes a structured prompt to `copilot --yolo --agent squad`.

8. **Copilot reads the `.squad/team.md`** file in the repo, routes to the correct agent charter (via `@{agent-name}` mention in the prompt), and makes code changes based on the issue description.

9. **The container pushes the branch** and creates a PR with an enriched body (agent summary, diff stats, commit log, pipeline status). Labels swap from `squad:processing` → `squad:queued`.

10. **The container shuts down.** It's destroyed. No state persists. The only artifacts are the git commits and the PR.

### The `/squad revise` Feedback Loop

After a PR is created, reviewers can comment `/squad revise` on the PR. This triggers a separate workflow (`squad-revise.yml`) that:

1. Validates guards: branch pattern matches, PR was authored by the bot, commenter has write access, no concurrent revision in progress
2. Adds a `squad:revising` label
3. Collects all review comments (review-level and inline code comments)
4. Enqueues a `type: "revise"` message to the same Storage Queue
5. KEDA triggers a new container that checks out the existing branch, verifies the HEAD SHA hasn't moved (stale check), builds a revision prompt with the review feedback + diff context, runs Copilot CLI again, pushes additive commits (no force-push), and comments a revision summary on the PR

This creates a complete **issues in → PRs out → review → revise → merge** loop without ever leaving GitHub.

### Diagram Description (for accompanying visual)

A diagram should show: GitHub Issues on the left, flowing through GitHub Actions (with OIDC auth), into Azure Storage Queue (the message broker), with KEDA polling the queue and triggering Container App Jobs. The container has arrows to Key Vault (for secrets), to the GitHub API (for clone/push/PR), and to Copilot CLI (for AI coding). Pull Requests appear on the right. A feedback arrow from PR back through the revision workflow creates the loop. All Azure resources sit inside a single resource group. Identity lines (dotted) show the User-Assigned Managed Identity connecting to Storage, Key Vault, ACR, and via OIDC back to GitHub Actions.

---

## 3. The Struggles & Breakthroughs

### Struggle 1: GitHub App vs PAT — The Copilot Licensing Gap

**What we tried first**: Use a GitHub App for everything — repository operations AND Copilot CLI invocation. GitHub Apps are the "right" way to do bot authentication: org-owned, short-lived tokens, minimal scope, clear audit trail.

**Why it failed**: GitHub Apps are not "users." They're organizational identities. **GitHub Apps cannot hold Copilot licenses.** The Copilot CLI (`@github/copilot`) checks the `GITHUB_TOKEN` environment variable and validates that the associated account has an active Copilot subscription. An App token fails this check.

**What we learned**: This is a **GitHub platform limitation**, not a design problem. No amount of clever engineering can work around it — you fundamentally need a licensed user's token for Copilot.

**What we ended up doing**: A **dual-token pattern**. The container holds two tokens simultaneously:
- **App Installation Token** (from GitHub App PEM → JWT → token exchange): Used for git push, PR creation, label management, issue operations. All repository mutations show as `squad-aca-bot[bot]`.
- **Copilot PAT** (from a Copilot-licensed user, stored in Key Vault): Used exclusively for the `copilot --yolo` CLI invocation. Never used for git operations.

The entrypoint swaps tokens at runtime:
```bash
# Before Copilot: swap to Copilot PAT
export GITHUB_TOKEN="${COPILOT_TOKEN}"
copilot --yolo --agent squad

# After Copilot: swap back to App token
export GITHUB_TOKEN="${APP_TOKEN}"
git push origin "${BRANCH}"
gh pr create ...
```

**Why this matters for the blog**: This is the biggest friction point in the entire platform. If GitHub ever allows Apps to hold Copilot licenses, this complexity disappears entirely. It's a real-world example of platform limitations shaping architecture.

---

### Struggle 2: Identity-Based Auth Everywhere (No Shared Keys Allowed)

**What we tried first**: Standard connection strings for Azure Storage Queue access — the default approach in most tutorials and quickstarts.

**Why it failed**: The Azure subscription enforces `KeyBasedAuthenticationNotPermitted` on storage accounts. `allowSharedKeyAccess=false` is policy-enforced and cannot be overridden. Connection strings literally don't work. Every tutorial about KEDA + Storage Queue shows connection string auth. None of them work in this environment.

**What we learned**: Identity-based auth for everything is the right pattern, but the tooling isn't fully there yet. Each service (Function App, KEDA, Container self-dequeue) needed its own identity-based auth solution, and each was a separate battle.

**What we ended up doing**:
- **Function App**: Replaced `AzureWebJobsStorage` (connection string) with `AzureWebJobsStorage__accountName` (identity-based). Added system-assigned managed identity with Storage Blob Data Owner, Queue Data Contributor, and Storage Account Contributor roles.
- **KEDA**: Used User-Assigned Managed Identity with the `identity` field at the KEDA scale rule level (more on this below).
- **Container dequeue**: `az storage message get --auth-mode login` with `az login --identity --client-id`.
- **GitHub Actions → Queue**: OIDC federated credentials — zero secrets in GitHub repos.
- **Key Vault**: RBAC-based access, UAMI with Key Vault Secrets User role.

**The result**: Zero shared keys, zero connection strings, zero stored secrets anywhere in the platform. Every authentication is identity-based, short-lived, and least-privilege.

---

### Struggle 3: KEDA Identity Auth — The azapi Escape Hatch

**What we tried first**: Use the Azure Verified Module (AVM) for Container App Jobs with KEDA azure-queue scaler, which supports `auth[].secretRef` for authentication.

**Why it failed**: The AVM module only supports `secretRef`-based KEDA auth (connection string secret). The `azurerm` Terraform provider doesn't expose the `identity` field at the KEDA scale rule level. But since shared keys are blocked by subscription policy, `secretRef` with a connection string doesn't work.

**What we learned**: Sometimes the Terraform provider abstraction is behind the ARM API. The Azure REST API supports identity-based KEDA auth, but Terraform's `azurerm` provider hasn't caught up.

**What we ended up doing**: Dropped from the AVM module to a raw `azapi_resource` — Terraform's escape hatch for directly calling the Azure REST API. Used API version `2025-01-01` with `schema_validation_enabled = false` (because the azapi schema is behind the ARM API too). This was **multiple iterations** — first trying AVM, then trying `azurerm`, then finally going to `azapi`.

```hcl
# KEDA scale rule with identity-based auth (only possible with azapi_resource)
rules = [{
  name = "queue-scaling"
  type = "azure-queue"
  metadata = {
    queueName   = var.queue_name
    queueLength = "1"
    accountName = local.storage_account_name
  }
  identity = azurerm_user_assigned_identity.squad_agent.id  # <-- this field doesn't exist in AVM
}]
```

**Why this matters**: After deploying with identity-based KEDA auth, **14 executions triggered immediately** — the queue had been accumulating messages while the connection string auth was silently failing. The moment identity auth worked, KEDA woke up.

---

### Struggle 4: ACA Jobs Don't Pass Queue Messages to Containers

**What we tried first**: Expected KEDA to pass the queue message content as environment variables to the container, similar to how Azure Functions receive trigger data.

**Why it failed**: Azure Container App Jobs triggered by KEDA don't inject queue message content. KEDA only uses the queue to decide *when* to start a container — it doesn't pass the message to the container. The official docs don't make this obvious.

**What we learned**: The container must manage its own queue lifecycle — authenticate, dequeue, parse, delete.

**What we ended up doing**: Container self-dequeues using Azure CLI:
```bash
RAW_MSG=$(az storage message get \
  --queue-name "${QUEUE_NAME}" \
  --account-name "${AZURE_STORAGE_ACCOUNT}" \
  --auth-mode login \
  --num-messages 1 -o json)
```

This actually turned into an advantage: the container can run dedup checks between dequeue and processing. It checks for existing PRs, branches, and labels before doing any work. And it deletes the message immediately after parsing — not after processing — so a failed container doesn't cause infinite reprocessing.

---

### Struggle 5: Copilot CLI Needs an Interactive TTY

**What we tried first**: Used `gh copilot` (the GitHub CLI extension) to invoke Copilot from within the container.

**Why it failed**: `gh copilot` requires an interactive TTY — it prompts for tool call approvals. Container App Jobs have no TTY, no stdin, no way to provide interactive input. Every tool call hangs forever waiting for approval that can never come.

**What we learned**: The `gh copilot` CLI extension is designed for interactive developer use, not headless automation. But the `@github/copilot` npm package supports a `--yolo` flag that auto-approves all tool calls.

**What we ended up doing**: Switched to the `@github/copilot` npm package with `--yolo` mode:
```bash
echo "${SQUAD_PROMPT}" | copilot --yolo --agent squad
```

This is safe because:
- The container is **ephemeral** — destroyed after execution, any damage is contained
- All changes go to a **feature branch** — never to `main`
- A **human must review and merge** the PR
- If Copilot makes bad changes, the **graceful fallback** creates a diagnostic work artifact instead

---

### Struggle 6: Single Generic Job vs Per-Agent Jobs

**What we tried first**: Created 4 separate Container App Jobs — one for each agent type (backend, frontend, tester, docs). Each had hardcoded `AGENT_TYPE` environment variables and different CPU/memory configurations.

**Why it failed**: It didn't technically fail, but it was wrong. Every new agent type required a Terraform change, a new KEDA trigger, new RBAC assignments. The complexity was O(N) with the number of agents.

**What we learned**: The queue message already contains the agent type. The container image is the same for all agents. The only thing that changes is a string passed to Copilot's `--agent` flag.

**What we ended up doing**: One generic Container App Job. The queue message JSON includes `agent_type`, and `entrypoint.sh` parses it at runtime. Adding a new agent type is now a **zero-infrastructure change** — just create the label on GitHub and define the agent in `.squad/team.md`.

---

### Struggle 7: Function App Identity-Based Storage (the 503 mystery)

**What we tried first**: Standard `AzureWebJobsStorage` connection string for the Azure Function's host runtime and queue output binding.

**Why it failed**: Subscription policy blocks key-based auth. The Function App returned 503 errors because it couldn't access its own host storage.

**What we ended up doing**: Replaced `AzureWebJobsStorage` with `AzureWebJobsStorage__accountName` (identity-based), added system-assigned MI with three RBAC roles. Then created a separate `SquadStorage__queueServiceUri` connection for the queue output binding, decoupling it from the host runtime's storage.

*Note*: The Function App (timer-triggered issue poller) was later **replaced entirely** by a GitHub Actions workflow (`squad-queue.yml`). The event-driven workflow approach is superior — it triggers instantly on label events instead of polling every minute.

---

### Struggle 8: Function App → GitHub Actions Simplification

**The first approach — Azure Function App (timer-based poller):**

Bodhi (Function Dev) built a Python Azure Function with a timer trigger that polled GitHub every few minutes:
- Used `requests` library to call the GitHub API, checking for issues labeled with `squad:{member}`
- Enqueued messages to Storage Queue via identity-based output binding (`SquadStorage__queueServiceUri`)
- Required its own infrastructure: App Service Plan (Consumption/Y1), Function App, system-assigned managed identity, 3 RBAC role assignments (Blob Data Owner, Queue Data Contributor, Storage Account Contributor)

**Why we moved away:**
- **Timer-based polling is inherently delayed** — minutes between checks vs event-driven instant response
- **Infrastructure overhead** — required Azure service plan + function app + RBAC just to bridge GitHub → Queue
- **Another moving part** — separate code to maintain, test, deploy, monitor
- **Policy friction** — the subscription's `allowSharedKeyAccess=false` policy made the identity-based bindings complex (`SquadStorage__queueServiceUri` decision was necessary but verbose)

**What replaced it — GitHub Actions workflow (`squad-queue.yml`):**
- Triggers on **`issues.labeled` event** — instant response, zero polling delay
- Uses **OIDC federated credentials** — authenticates to Azure with zero secrets stored in GitHub
- Sends queue messages directly via `az storage message put --auth-mode login`
- **Zero Azure infrastructure needed** beyond the Storage Queue itself
- Single YAML file replaced: Python function code + `host.json` + `requirements.txt` + App Service Plan + Function App + 3 RBAC assignments

**The lesson:**
- Sometimes the simplest solution isn't the first one you build
- GitHub Actions is already authenticated, already event-driven, already deployed at scale
- The "obvious" bridge tool (Function App) was actually overengineered for this problem
- **This is a great example of "build it, learn from it, simplify it"** — a productive iteration, not a failure

---

## 4. The Squad Framework Integration

### How Squad Maps to ACA Jobs

Squad is a multi-agent AI development framework where specialized agents collaborate on coding tasks. Each agent has:
- A **charter** (role definition, expertise areas, constraints)
- A **history** (learnings accumulated over time)
- Access to shared **decisions** (team-level decision log)

In the ACA Jobs model, each container execution runs the full Squad framework. The prompt includes `@{agent-name}` which Squad routes to the correct agent charter. Inside one container, Squad can even spawn sub-agents if needed.

### The .squad/ Directory

The `.squad/` directory is the Squad framework's "brain" — it lives in the repository and flows through git:

```
.squad/
├── team.md              # Team roster (who's on the team, roles)
├── decisions.md         # Shared decision log (architectural choices)
├── routing.md           # How work gets dispatched
├── ceremonies.md        # Team rituals and processes
├── config.json          # Squad configuration
├── agents/
│   ├── wedge/           # Lead — architecture, code review, scope
│   │   ├── charter.md
│   │   └── history.md
│   ├── chewie/          # IaC Dev — Terraform, Azure infrastructure
│   │   ├── charter.md
│   │   └── history.md
│   ├── lando/           # Container Dev — Dockerfile, entrypoint
│   │   ├── charter.md
│   │   └── history.md
│   ├── bodhi/           # Function Dev — Python Azure Functions
│   │   ├── charter.md
│   │   └── history.md
│   ├── cassian/         # Tester — validation, edge cases
│   │   ├── charter.md
│   │   └── history.md
│   ├── ralph/           # Work Monitor — issue tracking, CI status
│   │   ├── charter.md
│   │   └── history.md
│   └── scribe/          # Session Logger — maintains team memory
│       ├── charter.md
│       └── history.md
├── casting/             # Agent name assignment system
├── identity/            # Team identity and wisdom
├── log/                 # Orchestration session logs
└── templates/           # Squad framework templates and skills
```

### Agent Names from Star Wars Universe

Squad uses a "casting" system that assigns agent names from fictional universes. This project uses **Star Wars**:

| Agent | Role | What They Do |
|-------|------|-------------|
| **Wedge** | Lead | Architecture design, code review, scope management |
| **Chewie** | IaC Dev | All Terraform infrastructure, Azure resource configuration |
| **Lando** | Container Dev | Dockerfile, entrypoint.sh, container image |
| **Bodhi** | Function Dev | Python Azure Functions, queue integration |
| **Cassian** | Tester | Testing, validation, edge cases |
| **Ralph** | Work Monitor | Issue tracking, PR status, CI monitoring |
| **Scribe** | Session Logger | Silent observer, maintains team memory and logs |

### The Scribe Pattern

Scribe is a **silent logger** agent. It doesn't write code — it observes. It maintains:
- Cross-agent context (what each agent is doing)
- Orchestration logs (session-by-session records of team activity)
- Decision history (what was decided and why)

When an agent runs in a container, it reads Scribe's logs to understand what happened in previous sessions. This creates **institutional memory** that persists across ephemeral container executions — even though each container is destroyed after use, the knowledge flows through git.

### decisions.md as Shared Brain

The `.squad/decisions.md` file is the team's collective memory. Every architectural decision is documented with:
- **Context**: What problem we were solving
- **Decision**: What we chose to do
- **Changes**: Specific files and code modified
- **Consequences**: Tradeoffs and implications

When a new container spins up, the agent reads `decisions.md` to understand the project's history. This prevents agents from re-making decisions that were already resolved or contradicting previous architectural choices.

---

## 5. What Works Well

### Event-Driven Scaling (KEDA + Scale to Zero)
KEDA polls the Storage Queue every 30 seconds. When messages appear, containers start. When the queue is empty, everything scales to zero. There are no background processes, no always-on VMs, no idle resources. You literally pay nothing when agents aren't working.

### Ephemeral Container Isolation
Each job execution gets a fresh container. No shared filesystem, no cached state, no leaking environment variables. This makes `--yolo` mode safe — even if Copilot makes destructive changes, they're contained to a disposable workspace on a feature branch that requires human review.

### GitHub-Native Workflow
The entire user experience stays in GitHub:
- **Input**: Label an issue
- **Output**: Get a PR
- **Iterate**: Comment `/squad revise`
- **Complete**: Merge the PR

No separate dashboards, no third-party tools, no context switching.

### Identity-Based Auth End-to-End
Zero shared keys. Zero connection strings. Zero stored secrets (in GitHub). Every Azure service uses Managed Identity. GitHub Actions uses OIDC. The GitHub App generates short-lived installation tokens. The only "secret" is the Copilot PAT in Key Vault, and that's a GitHub platform limitation (see Struggle 1).

### The Revision Loop
The `/squad revise` workflow creates a genuine feedback cycle. Reviewers don't have to manually edit bot-generated code — they comment on what needs to change, and a new container picks it up. The stale SHA check prevents revisions on moved branches. The `squad:revising` label prevents concurrent revision races. It's a surprisingly robust iteration pattern.

### Enriched PR Descriptions
Bot PRs include: agent summary, diff stats, commit log, pipeline status, team decisions, and a `Closes #N` reference. This makes review much easier — the reviewer knows exactly what the agent did and why.

### Graceful Fallback
If Copilot fails (auth issue, rate limit, bad prompt), the container doesn't just crash. It creates a **work artifact** (`.squad-work/issue-N.md`) with the last 50 lines of Copilot output and opens a PR anyway. Context is never lost.

---

## 6. Limitations & Honest Assessment

### GitHub App Licensing Gap (Biggest Friction)
GitHub Apps cannot hold Copilot licenses. This forces the dual-token pattern and requires maintaining a Copilot-licensed PAT in Key Vault. If the PAT expires or the license is removed, all agent runs produce fallback artifacts instead of real code. **This is the single biggest operational dependency.**

### Copilot CLI Maturity
`--yolo` mode auto-approves all tool calls. There's no structured output, no confidence scoring, no way to tell the container "only approve safe operations." The quality of output varies significantly based on prompt quality and issue complexity.

### Cold Start Time
Each container pulls the image from ACR, boots Debian, and initializes az CLI + git + gh CLI. The cold start adds 30–60 seconds before any actual work begins. For a 5-minute task, that's 10–20% overhead.

### Single-Threaded Within a Container
Each container processes one queue message (one issue) at a time. There's no fan-out within a container — if you need parallel agents on the same issue, you need multiple messages.

### Experimental / Proof-of-Concept
This is not production-hardened. There's no retry logic for Copilot failures. No Teams/Slack notifications. No multi-region redundancy. No automated PAT rotation. It works, but it's a V1 that proves the concept.

### Container Runtime Limits
ACA Jobs have a configurable timeout (default 30 minutes). Complex issues with large codebases may timeout. The container is hard-killed — no graceful shutdown, no partial PR.

### No Persistent Workspace
Every run clones the entire repo from scratch. Large repos (>1GB) increase startup time. Build caches (node_modules, .gradle) are not preserved.

---

## 7. The Potential

### Better GitHub App → Copilot Integration
If GitHub allows Apps to hold Copilot licenses (or provides an API-key-based Copilot access model), the dual-token pattern disappears. The architecture simplifies dramatically — one token, one auth flow, no Key Vault for Copilot PAT.

### Multi-Agent Fan-Out
A single container could spawn multiple agents internally, or the workflow could enqueue multiple messages for the same issue with different agent types. Imagine: one issue triggers backend, frontend, and test agents in parallel, each opening their own PR.

### Integration with GitHub Copilot Coding Agent (@copilot)
GitHub's native Copilot coding agent (the `@copilot` mention in issues) is maturing. Squad on ACA could complement it — using the Copilot agent for simple tasks and Squad's multi-agent orchestration for complex, multi-file changes.

### Community Contributions
The project is open source (MIT license). Areas for expansion:
- Multi-region deployment
- Per-agent CPU/memory tuning
- Teams/Slack notifications
- Custom agents beyond Copilot CLI (e.g., Claude, Gemini, local models)
- Retry strategies for failed runs
- Automated PAT rotation

### Other Event Sources
The architecture isn't limited to GitHub issues. Any event that can produce a Storage Queue message could trigger agents:
- PR comments (already done with `/squad revise`)
- Scheduled maintenance tasks
- CI/CD failures that need automated fixes
- Slack messages
- Azure DevOps work items
- External webhooks

---

## 8. Technical Reference

### Key Files and What They Do

| File | Purpose |
|------|---------|
| `agents/base/entrypoint.sh` | Core orchestration script (~450 lines). Handles: MI auth, dequeue, dedup, GitHub App JWT generation, token swap, Copilot invocation, PR creation, label management, revision flow. The "brain" of each container. |
| `agents/base/Dockerfile` | Multi-stage Docker build. Stage 1 (golang:1.23.4-bookworm) builds Go toolchain + gh CLI + @github/copilot. Stage 2 (debian:bookworm-slim) is the minimal runtime with git, curl, jq, openssl, python3, az CLI, Node.js 22. |
| `infra/main.tf` | Terraform infrastructure (~550 lines). ACA Environment, Storage Account + Queue, ACR, Key Vault, Function App, Container App Job (via azapi_resource), UAMI, RBAC assignments, federated identity credentials. |
| `infra/variables.tf` | All configurable parameters: resource naming, location, agent job config (CPU, memory, max executions, timeout), GitHub App credentials, target repos list. |
| `infra/github.tf` | GitHub Terraform provider managing Actions repository variables on target repos. 5 variables per repo (client ID, tenant ID, subscription ID, storage account, queue name). |
| `infra/outputs.tf` | Terraform outputs for post-deploy configuration: Key Vault name, storage account name, agent client/tenant IDs. |
| `agents/workflows/squad-queue.yml` | GitHub Actions template workflow for target repos. Triggers on `issues.labeled`, does dedup check, OIDC login, adds processing label, enqueues message. |
| `agents/workflows/squad-revise.yml` | GitHub Actions template for `/squad revise` feedback loop. 6 guard checks, collects review + inline comments, enqueues revision message. |

| `.squad/team.md` | Squad team roster — defines all agents, their roles, and project context. |
| `.squad/decisions.md` | Living decision log — every architectural choice with context, rationale, and consequences. |

### Prerequisites for Deploying

1. **Azure subscription** (with permission to create resource groups, storage accounts, container apps, key vaults)
2. **GitHub account** with active Copilot license (for the Copilot PAT)
3. **Terraform ≥ 1.5** (for infrastructure deployment)
4. **Azure CLI** (for az keyvault, az acr commands)
5. **GitHub CLI** (for workflow testing)
6. **GitHub App** created manually (Issues R/W, Pull Requests R/W, Contents R/W)
7. **Docker** (optional, for local container testing)

### Azure Services Used

| Service | Why This One |
|---------|-------------|
| **Container App Jobs** | Event-driven, scale-to-zero, KEDA built-in, no cluster management. The foundation. |
| **Azure Storage Queue** | Simple, cheap, identity-auth supported, integrates with KEDA. Message broker between GitHub and containers. |
| **Azure Container Registry** | Hosts the agent image. Basic SKU ($5/mo). Caches Docker Hub base images to avoid rate limits. |
| **Azure Key Vault** | Stores GitHub App PEM and Copilot PAT. RBAC-based, UAMI access at runtime. |
| **Log Analytics Workspace** | Required by ACA Environment. Container logs queryable via KQL. |
| **User-Assigned Managed Identity** | Single identity for the container: queue access, ACR pull, Key Vault read, OIDC federation. |
| **Federated Identity Credentials** | OIDC bridge between GitHub Actions and Azure. Zero secrets in GitHub. |

### Cost Model

| Component | Cost | Notes |
|-----------|------|-------|
| Container App Job | $0.000017/sec | Only when running |
| Storage Queue | ~$0.001/M ops | Negligible |
| Key Vault | ~$0.6/mo | Fixed |
| Container Registry | $5/mo (Basic) | Fixed |
| Log Analytics | ~$0.50/GB | Optional |

**Example**: 100 issues/month × 5 min each ≈ **~$6/month total** (infrastructure-dominant).

Compare to: AKS cluster idle = ~$72/month. App Service always-on = $15–50/month.

---

## 9. Key Quotes / Callout-Worthy Lines

> **"The docs said AKS. We asked: what about ACA?"**
> — The question that started the project.

> **"No connection strings. No shared keys. No exceptions."**
> — What happens when subscription policy forces you to do auth the right way.

> **"The container wakes up, writes code, opens a PR, and shuts down. You only pay when agents are working."**
> — The pitch in one sentence.

> **"KEDA had been failing silently for hours. The moment identity auth worked, 14 executions triggered at once."**
> — The breakthrough moment when KEDA + identity auth finally clicked.

> **"GitHub Apps can't hold Copilot licenses. That one sentence shaped the entire authentication architecture."**
> — The platform limitation that created the dual-token pattern.

> **"Squad agents built the platform that runs Squad agents."**
> — The delicious irony of the project.

> **"Each container is a clean room. Born, does its job, dies. No state leaks, no residual risk."**
> — Why --yolo mode is actually safe in this context.

> **"We started with four separate jobs — one per agent type. Then we realized the queue message already knows who it's for."**
> — The simplification that eliminated per-agent infrastructure.

> **"Issues in, PRs out. The developer never leaves GitHub."**
> — The UX pitch.

> **"The .squad/ directory is the team's brain. It flows through git, survives container death, and grows smarter with every PR."**
> — How institutional memory works in ephemeral containers.

> **"We built an Azure Function to poll GitHub. Then we realized GitHub Actions was already doing the polling for us."**
> — The Function App → GitHub Actions evolution.

> **"One YAML file replaced an entire Function App, service plan, and three RBAC assignments."**
> — The power of starting event-driven instead of timer-based.

---

## 10. Raw Data for Blog Squad

### All Files in the Repo (with descriptions)

```
squad-on-aca/
├── README.md                      # Project overview, architecture diagram, quick start, cost model
├── LICENSE                        # MIT License
├── CONTRIBUTING.md                # Contribution guide (bug reports, PRs, local dev setup)
├── CODE_OF_CONDUCT.md             # Contributor Covenant v2.1
├── SECURITY.md                    # Security disclosure policy
├── OSS_READINESS_AUDIT.md         # Open-source readiness audit results
├── AUDIT_SUMMARY.md               # Condensed audit summary
├── DETAILED_AUDIT.md              # Full audit findings
│
├── agents/
│   ├── base/
│   │   ├── Dockerfile             # Multi-stage Docker build (Go + Node.js + az CLI + Copilot)
│   │   └── entrypoint.sh          # Core agent orchestration (~450 lines bash)
│   └── workflows/
│       ├── squad-queue.yml        # Template: GitHub Actions → Storage Queue bridge
│       ├── squad-revise.yml       # Template: /squad revise feedback loop
│       └── README.md              # Workflow installation guide
│
├── infra/
│   ├── main.tf                    # Core infrastructure (ACA, Storage, ACR, Key Vault, RBAC)
│   ├── variables.tf               # All configurable parameters with validation
│   ├── outputs.tf                 # Post-deploy outputs (Key Vault name, client IDs)
│   ├── providers.tf               # azurerm, azapi, github providers
│   └── github.tf                  # GitHub Actions variables management
│

│   ├── host.json                  # Azure Functions host config
│   └── requirements.txt           # Python dependencies
│
├── docs/
│   ├── architecture.md            # Deep architecture with 3 Mermaid diagrams
│   ├── thought-process.md         # 10 decision rationales (why each choice was made)
│   ├── limitations.md             # 13 documented limitations with mitigations
│   ├── adoption-guide.md          # Full step-by-step deployment guide
│   ├── infrastructure.md          # Terraform module reference
│   ├── customization.md           # How to customize containers, agents, target repos
│   ├── troubleshooting.md         # Common issues and resolutions
│   └── faq.md                     # Frequently asked questions
│
├── .squad/                        # Squad framework directory (team brain)
│   ├── team.md                    # Team roster and project context
│   ├── decisions.md               # Architectural decision log
│   ├── routing.md                 # Work dispatch rules
│   ├── agents/                    # Per-agent charters and histories
│   │   ├── wedge/                 # Lead
│   │   ├── chewie/                # IaC Dev
│   │   ├── lando/                 # Container Dev
│   │   ├── bodhi/                 # Function Dev
│   │   ├── cassian/               # Tester
│   │   ├── ralph/                 # Work Monitor
│   │   └── scribe/                # Session Logger
│   ├── casting/                   # Agent name assignment (Star Wars universe)
│   ├── identity/                  # Team identity and accumulated wisdom
│   ├── log/                       # Orchestration session logs
│   └── templates/                 # Squad framework templates, skills, workflows
│
├── .github/
│   ├── workflows/                 # Platform workflows (label sync, heartbeat, triage)
│   └── agents/                    # GitHub agent configuration
│
└── .copilot/                      # Copilot CLI configuration and skills
```

### Full decisions.md Content

The complete `decisions.md` is included in the repo at `.squad/decisions.md`. Key decisions (in chronological order):

1. **Single Generic Container App Job** (2026-04-12) — Replaced 4 per-agent jobs with one generic job. Agent type from queue message.
2. **Identity-Based Storage Auth for Function App** (2026-04-12) — Switched to managed identity after subscription policy blocked shared keys.
3. **KEDA Scaler — Managed Identity Auth** (2026-04-12) — Dropped AVM module, used azapi_resource with identity-based KEDA auth.
4. **Container Self-Dequeues via MI** (2026-04-12) — Container manages own queue lifecycle with `az storage message get --auth-mode login`.
5. **SquadStorage Connection for Queue Output Binding** (2026-04-12) — Decoupled queue binding from host runtime storage.
6. **Replace squad-cli with gh CLI Workflow** (2026-04-13) — Removed squad-cli, uses gh CLI directly for GitHub operations.
7. **Copilot CLI --yolo with Graceful Fallback** (2026-04-13) — Auto-approve in ephemeral container; fallback work artifact on failure.
8. **GitHub App Authentication Architecture** (2026-04-13) — Replaced PAT with GitHub App for bot identity; dual-token pattern.
9. **Key Vault + GitHub App Auth for Container Job** (2026-04-13) — PEM in Key Vault, JWT → installation token flow.
10. **GitHub Provider for Actions Variables** (2026-04-13) — Terraform-managed GitHub Actions variables on target repos.
11. **`/squad revise` PR Feedback Loop** (2026-04-14) — Revision workflow with guards, stale check, additive commits.
12. **Open-Source Readiness Audit** (2026-04-14) — 10-category audit, secrets fixes, governance files.

### Links to Key Code Sections

- **Entrypoint script** (core orchestration): `agents/base/entrypoint.sh`
- **KEDA identity auth** (azapi_resource): `infra/main.tf` — search for `azapi_resource.squad_agent_job`
- **Dual-token swap**: `agents/base/entrypoint.sh` — search for `COPILOT_TOKEN`
- **GitHub App JWT generation**: `agents/base/entrypoint.sh` — search for `openssl dgst -sha256`
- **Dedup logic**: `agents/base/entrypoint.sh` — search for `squad:queued` and `squad:processing`
- **Queue workflow**: `agents/workflows/squad-queue.yml`
- **Revision workflow**: `agents/workflows/squad-revise.yml`
- **Architecture diagrams**: `docs/architecture.md` (3 Mermaid diagrams)
- **Decision rationales**: `docs/thought-process.md` (10 detailed "why" explanations)

### Repo URL

**https://github.com/haflidif/squad-on-aca**

---

## Timeline

| Date | What Happened |
|------|--------------|
| 2026-04-12 | Project created. Team hired (Star Wars cast). Core Terraform infrastructure, Dockerfile, entrypoint, Function App. Decisions: single generic job, identity-based storage, KEDA MI auth, container self-dequeue. |
| 2026-04-13 | GitHub App auth, Key Vault integration, OIDC federated credentials, Copilot CLI integration, GitHub Actions workflows (squad-queue.yml), GitHub provider for Actions variables. |
| 2026-04-14 | `/squad revise` feedback loop, comprehensive documentation (architecture, thought process, limitations, adoption guide), open-source readiness audit. |
| 2026-04-15 | OSS governance files (CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md). Blog source material compilation. |

---

*This document was compiled by Wedge (Lead Agent) from: README.md, docs/architecture.md, docs/thought-process.md, docs/limitations.md, docs/infrastructure.md, docs/faq.md, .squad/decisions.md, .squad/team.md, agents/base/entrypoint.sh, agents/workflows/squad-queue.yml, agents/workflows/squad-revise.yml, and all agent history.md files (wedge, chewie, lando, bodhi, cassian, ralph, scribe).*
