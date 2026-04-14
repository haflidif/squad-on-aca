# Squad on ACA

> Run [Squad](https://bradygaster.github.io/squad/) AI agents on Azure Container App Jobs — $0 idle cost, full multi-agent orchestration.

Squad on ACA is a serverless platform for running Squad AI coding agents on Azure Container App Jobs. Instead of running a full Kubernetes cluster or always-on VMs, each agent run spins up an ephemeral container, does its work, and shuts down. **You only pay when agents are actively working.**

---

## What is This?

Squad on ACA enables collaborative AI-driven development by automating issue resolution through serverless containers. Label a GitHub issue with `squad:{agent-name}`, and a dedicated AI agent wakes up, analyzes the issue, makes code changes, and creates a pull request—all without any idle compute costs.

Built on open standards:
- **[Squad](https://bradygaster.github.io/squad/)** — Multi-agent orchestration framework
- **[GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-cli)** — AI-powered coding
- **[Azure Container App Jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs)** — Event-driven serverless containers
- **[KEDA](https://keda.sh/)** — Kubernetes Event Driven Autoscaling (built into ACA)
- **[GitHub Apps](https://docs.github.com/en/apps/creating-github-apps)** — Secure bot identity

---

## Architecture

```
GitHub Issue (squad:{agent-name} label)
    ↓
GitHub Actions Workflow
  (OIDC auth → zero secrets)
    ↓
Azure Storage Queue
  (message broker)
    ↓
KEDA Auto-Scaler
  (polls queue every 30s)
    ↓
Container App Job (ephemeral)
  (spins up when queue is not empty)
    ↓
Entrypoint Script
  (MI auth → dequeue → dedup checks)
    ↓
Copilot CLI (--yolo)
  (read issue → analyze → code changes)
    ↓
Pull Request
  (created by squad-aca-bot[bot])
    ↓
Enriched PR Body
  (agent summary, commits, decisions)
```

### Component Overview

#### **Azure Container App Job**
- **Event-driven**: Triggered by KEDA when a message appears in the queue
- **Ephemeral**: Runs on-demand, no idle resources
- **Identity-based auth**: Uses User-Assigned Managed Identity (UAMI) for all Azure API calls—zero shared keys
- **Scaling**: 0 to N parallel executions (configurable, default 10)
- **Timeout**: Configurable per-job (default 30 minutes)

#### **Azure Storage Queue**
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
  > **Note**: `agent_type` is extracted from the label name (e.g., `squad:ripley` → `ripley`). Agent names come from your team's `.squad/team.md`, created during Squad initialization.
- **TTL**: 24 hours per message
- **Auth**: Identity-based (UAMI), no shared keys

#### **GitHub Actions Workflow** (`squad-queue.yml`)
- **Trigger**: Issue labeled `squad:*` (e.g., `squad:{agent-name}` — agent names come from your team's `.squad/team.md`)
- **Steps**:
  1. Dedup check (skip if `squad:processing` label already set)
  2. OIDC login to Azure (federated credentials, zero secrets)
  3. Add `squad:processing` label to prevent duplicate processing
  4. Extract agent type from label name (e.g., `squad:{agent-name}` → `{agent-name}`)
  5. Enqueue message to Storage Queue with identity-based auth
- **Permissions**: `id-token: write`, `issues: write`, `contents: read`

#### **GitHub App** (`squad-aca-bot[bot]`)
- **Purpose**: Bot identity for all PR operations (create, comment)
- **Private key**: Stored in Azure Key Vault, never written to disk
- **Auth flow**:
  1. Container retrieves PEM from Key Vault
  2. Generate JWT (10-minute expiry)
  3. Exchange JWT for installation access token (1-hour expiry)
  4. Use token for git push, PR creation, label management
- **One app per environment**: Simplifies permission model

#### **Azure Key Vault**
- **Secrets stored**:
  - `github-app-private-key`: GitHub App PEM (uploaded manually via `az keyvault secret set`)
  - `copilot-pat`: Copilot-licensed GitHub PAT (uploaded manually)
- **Access**: RBAC-based, no access policies
- **UAMI permissions**: Key Vault Secrets User (read-only at runtime)

#### **Dual Auth Pattern**
GitHub Apps cannot hold Copilot licenses. Squad on ACA uses a dual-token approach:
- **App token** (from GitHub App installation): git push, PR creation, issue operations
- **Copilot PAT** (from a Copilot-licensed user): `copilot --yolo` CLI invocation only
- Both are stored in Key Vault; the container swaps them as needed during execution

#### **Container Image**
- **Base**: `debian:bookworm-slim` (minimal runtime)
- **Tooling**:
  - `gh` CLI (GitHub operations)
  - `git` (repository cloning, commits)
  - `@github/copilot` CLI (AI coding)
  - `az` CLI + Python (Azure authentication)
  - `jq` (JSON parsing)
  - `openssl` (JWT generation)
- **Entrypoint**: `entrypoint.sh` orchestrates the entire workflow

#### **Container Entrypoint** (`agents/base/entrypoint.sh`)
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

---

## Key Features

✅ **$0 Idle Cost** — Containers only run when issues are labeled. No background processes, no always-on VMs.

✅ **Full Squad Multi-Agent Orchestration** — Each container runs the full Squad framework. Agents can read `.squad/team.md`, dispatch work among team members, and persist learnings.

✅ **Charter-Aware Agents** — Agents read team charter and decision history from `.squad/` repo state. Charter-driven routing via `@{agent-name}` mentions. Agent names come from Squad's casting system — initialized locally via `copilot --agent squad` and committed to `.squad/team.md`.

✅ **Enriched PR Descriptions** — PR body includes:
- Agent summary (last 20 lines of Copilot output)
- Diff stats (files changed, insertions, deletions)
- Commit log (all commits on the branch)
- Team decisions (from `.squad/decisions/inbox/`)
- Pipeline status table (each step's success/failure)

✅ **Team State Persistence** — `.squad/decisions.md` and `.squad/history.md` flow through PRs back into the repo. Decisions made by agents are preserved and available to future runs.

✅ **Two-Layer Label System** — Squad creates agent labels (`squad:{agent-name}`) automatically during `squad init` as part of its [label taxonomy](https://bradygaster.github.io/squad/docs/features/labels/). The platform adds its own operational labels (`squad:processing`, `squad:queued`) via the container entrypoint for dedup and status tracking.

✅ **Identity-Based Auth Everywhere** — No shared keys, no connection strings. All Azure services authenticated via Managed Identity. GitHub ops use temporary tokens (10-minute JWT, 1-hour installation token).

✅ **Graceful Fallback** — If Copilot CLI fails, a work artifact is created. PR still gets created so context isn't lost. Teams can investigate or retry.

---

## Prerequisites

Before starting, ensure you have:

- **Azure subscription** with:
  - Minimum resource quotas (ACR Basic, Storage Standard-LRS, ACA basic environment)
  - Capability to create user-assigned managed identities
- **GitHub account** with:
  - Admin access to at least one repository (for testing)
  - Ability to create a GitHub App
  - GitHub Copilot license (for the PAT you'll upload)
- **Local tools**:
  - Terraform >= 1.5
  - Azure CLI (`az`) logged in with subscription owner access
  - `gh` CLI (GitHub CLI)
- **Manual setup** (one-time):
  - Create a GitHub App (documented below)
  - Upload GitHub App private key to Key Vault
  - Upload Copilot PAT to Key Vault

---

## Quick Start

### 1. Clone This Repository

```bash
git clone https://github.com/haflidif/squad-on-aca.git
cd squad-on-aca
```

### 2. Create a GitHub App (Manual, One-Time)

1. Go to your GitHub organization settings or personal settings → **Developer settings** → **GitHub Apps** → **New GitHub App**
2. Fill in the form:
   - **App name**: `squad-aca-bot` (or your preference)
   - **Homepage URL**: `https://github.com/haflidif/squad-on-aca`
   - **Webhook**: Uncheck "Active" (we don't use webhooks)
3. **Permissions** (required):
   - **Repository**:
     - Issues: Read & write
     - Pull Requests: Read & write
     - Contents: Read & write (for commits)
   - **Account**:
     - Nothing (no account-level permissions needed)
4. **Where can this app be installed?**: Select your target organization or "Any account"
5. Click **Create GitHub App**
6. Note down:
   - **App ID** (e.g., `123456`)
   - **Installation ID**: Go to **Install App** → click on your org → check URL for `installation_id` (e.g., `98765432`)

### 3. Download GitHub App Private Key

1. On the GitHub App settings page, scroll to **Private keys**
2. Click **Generate a private key**
3. Save the `.pem` file securely

### 4. Deploy Infrastructure with Terraform

```bash
cd infra

# Configure variables
cat > terraform.tfvars <<EOF
project_name                 = "squad"
environment                  = "dev"
location                     = "eastus"
subscription_id              = "YOUR_AZURE_SUBSCRIPTION_ID"
github_app_id                = "123456"
github_app_installation_id   = "98765432"
target_repos                 = ["your-org/your-repo"]
queue_name                   = "squad-work-queue"
EOF

# Set the GitHub token as an environment variable (never write secrets to files)
# PowerShell:
$env:TF_VAR_github_token = "YOUR_GITHUB_PAT_FOR_REPO_VARIABLES"

# Or Bash/Linux/macOS:
export TF_VAR_github_token="YOUR_GITHUB_PAT_FOR_REPO_VARIABLES"

# Initialize and apply
terraform init
terraform apply
```

**Important notes**:
- **Never write secrets to files.** Use environment variables instead:
  - **PowerShell**: `$env:TF_VAR_github_token = "ghp_..."`
  - **Bash/Linux/macOS**: `export TF_VAR_github_token="ghp_..."`
  - Terraform automatically reads `TF_VAR_*` environment variables and maps them to variables.
- The `github_token` is a temporary PAT used only to set repository variables (SQUAD_AZURE_CLIENT_ID, etc.). It's not stored in state or infrastructure.
- `target_repos` is a list of `owner/repo` strings. You can add multiple repos.
- The token should have `repo:admin` and `workflow` permissions.

### 5. Upload Secrets to Azure Key Vault

After Terraform completes, retrieve the Key Vault name from outputs:

```bash
# From Terraform outputs:
KV_NAME=$(terraform output -raw key_vault_name)

# Upload GitHub App private key
az keyvault secret set \
  --vault-name "${KV_NAME}" \
  --name "github-app-private-key" \
  --file /path/to/downloaded-private-key.pem

# Upload Copilot PAT (must be from a Copilot-licensed user)
az keyvault secret set \
  --vault-name "${KV_NAME}" \
  --name "copilot-pat" \
  --value "YOUR_COPILOT_LICENSED_PAT"
```

### 6. Build and Push Container Image

```bash
# From repo root
cd agents/base

# Get ACR login server from Terraform
ACR_LOGINSERVER=$(terraform output -raw acr_login_server)

# Build image
docker build -t squad-agent:latest .

# Push to ACR
az acr login --name <acr-name>
docker tag squad-agent:latest "${ACR_LOGINSERVER}/squad-agent:latest"
docker push "${ACR_LOGINSERVER}/squad-agent:latest"
```

### 7. Install Workflow Template on Target Repos

For each repo in `target_repos`, add the workflow:

```bash
# Copy the workflow to the target repo
cp agents/workflows/squad-queue.yml /path/to/target-repo/.github/workflows/squad-queue.yml
cd /path/to/target-repo
git add .github/workflows/squad-queue.yml
git commit -m "feat: add squad issue queue workflow"
git push
```

Terraform already set the repository variables, so the workflow will have everything it needs.

### 8. Test It!

1. Go to your target repo on GitHub
2. Create or pick an open issue
3. Add a label matching one of your agent names from `.squad/team.md` (e.g., `squad:{agent-name}`)
4. Watch the workflow run → Container spins up → PR gets created!

---

## GitHub App Setup (Detailed)

The GitHub App is the identity for all PR operations. Here's why we use one instead of a personal account:

- **Organization-owned**: Survives personnel changes
- **Audit trail**: All bot activity is attributed to the app
- **Limited scope**: Permissions are minimal (issues, PRs, contents)
- **No personal credentials**: The app's private key is kept in Key Vault, never in code or environment files

### App Permissions (Minimum Required)

| Resource | Permission | Scope | Why |
|----------|-----------|-------|-----|
| Issues | Read & write | Repository | Add/remove labels, edit issue |
| Pull Requests | Read & write | Repository | Create PR, add comment |
| Contents | Read & write | Repository | Clone repo, commit, push |

### Installation

After creating the app:
1. Go to the app's **Install App** tab
2. Click on your organization/account
3. Select which repos to install on (or all repos)
4. Authorization complete!

The `GITHUB_APP_INSTALLATION_ID` is the ID from step 3 (check the URL after installation).

---

## Cost Model

### Pricing Breakdown

| Component | Cost | Conditions |
|-----------|------|-----------|
| **Container App Job** | $0.000017 / second | Only charged when running |
| **Storage Queue** | ~$0.001 / million ops | Negligible; each issue = ~3 ops (dequeue, delete, 1 message) |
| **Key Vault** | ~$0.6 / month | Fixed cost, shared across all deployments |
| **Container Registry** | $5 / month (Basic) | Fixed cost for image storage |
| **Log Analytics** | ~$0.50 / GB ingested | Optional; logging is minimal |

### Example Costs

**Scenario**: 100 issues per month, 5 minutes per issue run

- Container time: 100 issues × 5 min × $0.000017/sec = **~$0.05**
- Storage Queue: 100 × 3 ops = 300 ops ≈ **$0.00003**
- Infrastructure (ACR, KV, LAW): **~$6/month**
- **Total: ~$6/month** (infrastructure-dominant; agent runtime is negligible)

**Compare to alternatives**:
- Kubernetes cluster (AKS): ~$0.10/hour × 24 × 30 = **$72/month** (idle cost)
- App Service (always-on): ~$15-50/month (depending on tier)
- **Squad on ACA: $6/month** ✅

---

## How It Works (E2E Walkthrough)

### Step 1: Issue Labeling

```
User labels GitHub issue #42 with "squad:{agent-name}"
↓
GitHub fires "issues.labeled" webhook
↓
Repository has .github/workflows/squad-queue.yml (installed in step 7)
```

### Step 2: GitHub Actions Workflow

```
Workflow runs: "Squad Issue Queue"
  - Dedup check: Is "squad:processing" already on #42? No → continue
  - OIDC login: Request federated token for this repo/action combo
  - Auth to Azure: Exchange OIDC token for Azure token (no secrets!)
  - Add label: gh issue edit #42 --add-label "squad:processing"
  - Build message:
    {
      "issue_number": 42,
      "agent_type": "{agent-name}",
      "repo": "your-org/your-repo",
      "title": "Issue title"
    }
  - Base64 encode & queue: az storage message put (using MI auth)
  - Done ✅
```

### Step 3: KEDA Polling

```
KEDA in Container App Environment polls queue every 30 seconds
  ↓
Detects 1 message on squad-work-queue
  ↓
Starts 1 replica of "squad_agent_job" Container App Job
  ↓
Container pulls image from ACR (using UAMI + AcrPull role)
  ↓
Entrypoint script runs
```

### Step 4: Container Entrypoint Orchestration

```
Container starts:
  - az login --identity --client-id UAMI_ID ✅
  - az storage message get (dequeue) ✅
  - Check for squad:processing label ✅
  - Check for existing PR ✅
  - Check for existing branch ✅
  - git config user.name/user.email
  - gh repo clone your-org/your-repo
  - Create branch: squad/{agent-name}/issue-42
```

### Step 5: Copilot CLI Runs

```
Read .squad/team.md to find "{agent-name}" agent's charter
  ↓
Run Copilot CLI:
  echo "Resolve issue #42..." | copilot --yolo --agent squad
  ↓
Copilot reads issue body, analyzes, writes code changes
  ↓
Copilot commits changes: "squad({agent-name}): ..."
```

### Step 6: PR Creation & Label Update

```
Entrypoint detects commits:
  - Stage any uncommitted changes
  - Commit if needed
  ↓
Check .squad/ for state changes (decisions.md, history.md)
  - Commit if found
  ↓
git push origin squad/{agent-name}/issue-42
  ↓
gh pr create \
  --title "squad({agent-name}): resolve issue #42" \
  --body "## Agent Summary\n..." \
  --base main \
  --head squad/{agent-name}/issue-42
  ↓
gh issue edit #42 --remove-label squad:processing --add-label squad:queued
```

### Step 7: Human Review

```
PR #1000 created:
  - Title: "squad({agent-name}): resolve issue #42"
  - Body includes:
    - Agent summary (Copilot output)
    - Diff stats
    - Commits made
    - Team decisions
    - Pipeline status
  ↓
Human reviews changes
  ↓
Merge PR → changes land on main
  ↓
Issue #42 closes (if PR body includes "Closes #42")
```

### Step 8: Container Cleanup

```
Container exits with code 0 (success)
  ↓
KEDA detects queue is empty
  ↓
No more containers start (scaling to 0)
  ↓
No idle costs! ✅
```

---

## Infrastructure

### Terraform Modules

Squad on ACA uses Microsoft's Azure Verified Modules (AVM) for infrastructure consistency:

| Module | Purpose | Notes |
|--------|---------|-------|
| `azure/avm-res-operationalinsights-workspace` | Log Analytics (required by ACA environment) | Telemetry disabled for cost |
| `azure/avm-res-storage-storageaccount` | Storage account + queues | RBAC-based auth, no shared keys |
| `azure/avm-res-containerregistry-registry` | Container Registry (Basic) | Hosts `squad-agent:latest` image |
| `azure/avm-res-app-managedenvironment` | ACA Managed Environment | Provides KEDA, Log Analytics integration |
| `azure/avm-res-web-serverfarm` | App Service Plan (Consumption/Y1) | For Function App (issue poller) |
| `azure/avm-res-web-site` | Function App | Python 3.11, identity-based storage |
| `azapi_resource` (Container App Job) | Generic squad agent job | Custom `azapi_resource` due to identity-based KEDA auth not in AVM |

### Key Decisions (Captured in `.squad/decisions.md`)

- **Single Generic Job**: One Container App Job handles all agent types. Agent type comes from queue message. Adding new agents = zero infrastructure changes. Agent names come from Squad's casting system, defined in `.squad/team.md`.
- **UAMI for Scaling**: KEDA uses Managed Identity for auth (no connection strings). Storage account blocks shared keys per subscription policy.
- **Container Self-Dequeue**: Each container manages its own queue interaction (dequeue, delete). Enables dedup checks and failsafe behavior.
- **Dual Auth Pattern**: App token for git/PR ops, Copilot PAT for `copilot --yolo`. Both stored in Key Vault, swapped at runtime.
- **Graceful Fallback**: If Copilot fails, work artifact is created so PR still gets made.

---

## Target Repo Setup

To onboard a new GitHub repository to Squad on ACA:

### 1. Add Workflow

```bash
# Copy the workflow template to your target repo
cp agents/workflows/squad-queue.yml \
   your-repo/.github/workflows/squad-queue.yml
```

The workflow looks for repository variables (set automatically by Terraform):
- `SQUAD_AZURE_CLIENT_ID`
- `SQUAD_AZURE_TENANT_ID`
- `SQUAD_AZURE_SUBSCRIPTION_ID`
- `SQUAD_STORAGE_ACCOUNT`
- `SQUAD_QUEUE_NAME`

### 2. Federated Credential (If Manual Setup)

If you're not using Terraform to set up OIDC, add a federated credential to the UAMI:

```bash
az identity federated-credential create \
  --identity-name "id-squad-agent-XXXX" \
  --resource-group "rg-squad-dev-XXXX" \
  --issuer "https://token.actions.githubusercontent.com" \
  --subject "repo:your-org/your-repo:ref:refs/heads/main" \
  --audience "api://AzureADTokenExchange"
```

### 3. Labels

There are two categories of labels — created by different systems:

**Agent labels — created by Squad (the framework)**

When you run `squad init` or `squad upgrade` on a target repo, Squad automatically creates labels from its [label taxonomy](https://bradygaster.github.io/squad/docs/features/labels/), including:
- `squad:{agent-name}` — one per team member, derived from `.squad/team.md` (allows multiple per issue for pair work)
- `go:*` — verdict labels (yes/no/needs-research) — mutually exclusive
- `type:*` — issue category — mutually exclusive
- `priority:*` — urgency — mutually exclusive
- `release:*` — release target — mutually exclusive

Squad also creates automation workflows to maintain these labels:
- `sync-squad-labels.yml` — keeps labels in sync with the team roster
- `label-enforcement.yml` — enforces mutual exclusivity within namespaces
- `squad-heartbeat.yml` — periodic triage and auto-assignment

> **This platform only uses `squad:{agent-name}` labels** to trigger agent runs. The other namespaces are part of Squad's broader project management features.

**Pipeline labels — created by the container entrypoint**

The entrypoint auto-creates these operational labels if they don't exist:
- `squad:processing` — Agent is actively working on this issue
- `squad:queued` — PR created, awaiting review

These are **not** part of Squad's label taxonomy — they're platform-specific labels added by Squad on ACA for deduplication and lifecycle tracking.

**If labels are missing**

If you need to create agent labels manually (e.g., on a repo where `squad init` hasn't been run yet):

```bash
gh label create "squad:{agent-name}" --repo your-org/your-repo --color "008672"
```

---

## Limitations

### GitHub App Cannot Hold Copilot License

GitHub Apps are organization-level identities and cannot hold personal Copilot licenses. This project uses a **dual-token pattern**: the GitHub App token handles git/PR operations, and a separate Copilot-licensed user PAT handles `copilot --yolo` invocation.

**Mitigation**: One team member with a Copilot license generates a PAT, uploads it to Key Vault, and shares access with the team. The PAT is read-only from the container's perspective (isolated in Key Vault).

### Container Runtime Limit (~30 minutes)

Azure Container App Jobs have a maximum runtime of ~30 minutes (1800 seconds, configurable). Complex issues requiring longer analysis may timeout.

**Mitigation**: For long-running tasks, split into sub-issues or increase timeout. Copilot usually completes in <5 minutes for typical code changes.

### One Agent Per Queue Message

Each queue message represents one issue → one container run. Multi-agent collaboration happens *inside* the container via Squad's framework (teams read `.squad/team.md` and dispatch internally), but orchestrating multiple containers for one issue requires custom queue logic.

**Note**: This is a platform limitation, not a Squad limitation. Squad handles full multi-agent orchestration inside a single container invocation.

### No Persistent Workspace Between Runs

Each container starts fresh. State persists through **git** (decisions.md, history.md flow through PRs) and **Key Vault** (secrets), not on-disk volumes.

**Why**: Keeps costs low (ephemeral containers, no persistent storage bill) and guarantees isolation (one run's failures don't affect the next).

### Manual Secret Management

GitHub App private key and Copilot PAT must be uploaded to Key Vault manually. Terraform cannot manage these without storing secrets in state.

**Mitigation**: Store the `.pem` file securely (e.g., 1Password, LastPass). Rotate the PAT annually.

---

## Development & Customization

### Customizing the Container Image

Edit `agents/base/Dockerfile`:
- Add new tools (e.g., `dbt`, `terraform`)
- Modify the Go/Node versions
- Adjust for your agent's needs

Then rebuild and push:

```bash
cd agents/base
docker build -t squad-agent:latest .
docker tag squad-agent:latest "${ACR_LOGINSERVER}/squad-agent:latest"
docker push "${ACR_LOGINSERVER}/squad-agent:latest"
```

### Customizing the Entrypoint

Edit `agents/base/entrypoint.sh`:
- Modify the Copilot CLI invocation (e.g., add `--model gpt-4o`)
- Change the working branch naming convention
- Add additional dedup checks
- Customize the PR body format

### Adding a New Agent Type

Adding agents to your Squad team requires no infrastructure changes — only Squad initialization:

1. **Initialize your Squad team**: In your target repo, start a Copilot CLI session with the Squad agent manifest (`.github/agents/squad.agent.md`). Squad proposes a team with unique agent names from a fictional universe (e.g., `ripley`, `data`, `gandalf`). Confirm the proposal and Squad creates the `.squad/` directory with `team.md`, `routing.md`, and agent charters.
2. **Labels are created automatically**: `squad init` creates `squad:{agent-name}` labels on the repo for each team member, along with Squad's full label taxonomy. Squad also installs `sync-squad-labels.yml` to keep labels in sync with the roster.
3. **Commit the `.squad/` directory**: Push the initialized team config to git. When the container clones the repo, it reads `.squad/team.md` to discover agents.
4. **Label an issue**: Use `squad:{agent-name}` to trigger the pipeline. The queue message carries `"agent_type": "{agent-name}"`, the container runs `copilot --yolo --agent squad`, and Squad routes to the correct agent charter.
5. **No infrastructure changes**: The single generic Container App Job handles all agent types.

---

## Troubleshooting

### Container Job Won't Start

**Check**: KEDA isn't detecting messages on the queue.

```bash
# List Container App Jobs
az containerapp job list --resource-group rg-squad-dev-XXXX -o table

# Get job details
az containerapp job show --name "job-squad-agent-XXXX" \
  --resource-group rg-squad-dev-XXXX --output json | jq '.properties.configuration.eventTriggerConfig'
```

**Verify**:
- Storage account has `shared_access_key_enabled = false` ✅
- UAMI has Storage Queue Data Reader role ✅
- KEDA scale rule identity field is set to UAMI ID ✅

### Container Runs but PR Doesn't Get Created

**Check**: Container logs for errors.

```bash
# Get recent executions
az containerapp job execution list --name "job-squad-agent-XXXX" \
  --resource-group rg-squad-dev-XXXX --output table

# Get logs for a specific execution
az containerapp job execution show --name "job-squad-agent-XXXX" \
  --resource-group rg-squad-dev-XXXX \
  --execution-name "execution-id" --output json | jq '.properties.template.containers[0]'
```

**Common issues**:
- Key Vault secret missing or empty (GitHub App PEM or Copilot PAT)
- UAMI doesn't have Key Vault Secrets User role
- GitHub App installation ID is incorrect
- Target repo not in `target_repos` list

### Copilot CLI Fails

The container handles this gracefully by creating a work artifact. Check the PR body for `.squad-work/issue-N.md`, which includes the last 50 lines of Copilot output.

**Typical causes**:
- Copilot-licensed PAT expired or revoked
- Copilot CLI not installed correctly in image
- Network issue (timeout reaching GitHub API)

### OIDC Token Exchange Fails in GitHub Actions Workflow

**Error**: `azure/login@v2` fails with OIDC error.

**Check**:
- Federated credential subject matches: `repo:{owner}/{repo}:ref:refs/heads/main`
- OIDC token permissions set in workflow (`id-token: write`)
- Repo not in a private network (OIDC needs public access to token.actions.githubusercontent.com)

---

## FAQ

**Q: Why not use AWS Lambda instead of ACA?**  
A: No strong reason! Squad on ACA uses Azure Container Apps for:
- Native KEDA integration (event-driven scaling)
- Direct Secret Manager (Key Vault) access
- Managed environment (no cluster setup)
- Cost is comparable to Lambda

Feel free to port this to Lambda, Cloud Run, etc. The pattern is portable.

**Q: Can I run multiple agents in parallel on one issue?**  
A: From the infrastructure level, each queue message = one container. But **Squad handles multi-agent orchestration inside the container**. If you want agents to work independently and open separate PRs, enqueue two messages (one per agent).

**Q: How do I monitor agent runs?**  
A: Use Application Insights logs (via Log Analytics). Azure Portal → Container Apps Job → Logs. KEDA metrics are also logged.

```kusto
ContainerAppConsoleLogs
| where ContainerGroupName =~ "job-squad-agent-*"
| where TimeGenerated > ago(24h)
| summarize Count = count() by TimeGenerated
```

**Q: What if an agent gets stuck in an infinite loop?**  
A: The container timeout (default 30 minutes) stops it. The PR is created with whatever progress was made. Fallback artifact captures logs.

**Q: Can I customize the PR title/body format?**  
A: Yes, edit `entrypoint.sh` lines 370–424 (PR body construction). The PR title is set at line 437.

**Q: Do I need to maintain this if I stop using it?**  
A: No special maintenance. KEDA stops triggering if no messages are enqueued. Container App Jobs scale to 0. Only recurring costs are:
- Key Vault: ~$0.6/month
- Container Registry: ~$5/month (Basic SKU)
- Log Analytics (if enabled): depends on usage

All are per-subscription, so even inactive deployments have minimal cost.

---

## Contributing

Squad on ACA is a proof-of-concept platform built for the Squad community. Contributions are welcome!

**Areas for expansion**:
- Multi-region deployment
- Per-agent CPU/memory tuning
- Additional fallback strategies (e.g., mock code if Copilot unavailable)
- Integration with Teams/Slack for notifications
- Custom agents beyond Copilot CLI

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

## License

Squad on ACA is released under [MIT License](LICENSE).

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | Mermaid diagrams, dual-auth pattern, KEDA scaling, RBAC matrix |
| [Thought Process](docs/thought-process.md) | Why every design decision was made — alternatives considered |
| [Limitations](docs/limitations.md) | Honest limitations with severity ratings and mitigations |
| [Adoption Guide](docs/adoption-guide.md) | Step-by-step onboarding for new adopters |

---

## Support

- **Issues**: [File on GitHub](https://github.com/haflidif/squad-on-aca/issues)

---

**Squad on ACA** — Serverless AI agents, zero idle cost, full orchestration. 🚀
