# Adoption Guide

> Step-by-step guide to deploying Squad on ACA for your organization. Follow these steps in order.

---

## Prerequisites Checklist

Before you begin, verify you have everything:

### Azure

- [ ] **Azure subscription** with Owner or Contributor access
- [ ] Ability to create **User-Assigned Managed Identities**
- [ ] Ability to create **Federated Identity Credentials** (OIDC)
- [ ] Ability to create **Key Vault** with RBAC authorization
- [ ] No policies blocking **Container App Jobs** or **Storage Queues**
- [ ] Subscription allows `allowSharedKeyAccess = false` on storage (or doesn't enforce it — the platform handles both)

### GitHub

- [ ] **Admin access** to at least one target repository
- [ ] Ability to **create a GitHub App** (org admin or personal account)
- [ ] **GitHub Copilot license** (Business or Individual) for the PAT
- [ ] Ability to install GitHub Apps on target repositories

### Local Tools

| Tool | Minimum Version | Install |
|------|----------------|---------|
| Terraform | >= 1.5 | [terraform.io](https://developer.hashicorp.com/terraform/install) |
| Azure Developer CLI (`azd`) | Latest | [learn.microsoft.com](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) |
| Azure CLI (`az`) | >= 2.55 | [docs.microsoft.com](https://learn.microsoft.com/cli/azure/install-azure-cli) |
| Azure CLI Bicep (`az bicep`) | Latest | Run `az bicep install` or `az bicep upgrade` |
| GitHub CLI (`gh`) | >= 2.40 | [cli.github.com](https://cli.github.com/) |
| Docker (optional) | >= 24.0 | [docker.com](https://docs.docker.com/get-docker/) |
| jq | >= 1.6 | [jqlang.github.io](https://jqlang.github.io/jq/download/) |

### Accounts & Access

- [ ] Logged into Azure CLI: `az login` + `az account set --subscription <id>`
- [ ] Logged into Azure Developer CLI: `azd auth login`
- [ ] Logged into GitHub CLI: `gh auth login`
- [ ] A GitHub PAT with `admin:org` or `repo` scope (for Terraform or the azd hook to set repo variables)

---

## Terraform vs Bicep and azd: which should you choose?

Squad on ACA supports two infrastructure-as-code paths. Terraform remains the canonical and default path for this project. Bicep with `azd` is the Azure-native alternative for teams that prefer ARM deployments and the Azure Developer CLI workflow.

| Concern | Terraform path (`infra/terraform/`) | Bicep and azd path (`infra/bicep/`) |
|---------|-------------------------------------|-------------------------------------|
| State management | Uses local Terraform state. A remote backend is not configured in this template. | Uses Azure Resource Manager idempotency through `azd provision`; no Terraform state file. |
| Provider lag | Uses `azapi_resource` for the Container App Job because the Terraform provider does not expose identity-based KEDA scale rules yet. | Uses native ARM/Bicep resource definitions for the Container App Job. |
| One-command deploy | Run `terraform init`, `terraform plan`, and `terraform apply`, then upload Key Vault secrets. | Run `azd up` to provision and deploy, then upload Key Vault secrets when the post-provision guidance prompts you. |
| GitHub Actions variables | Terraform uses the GitHub provider to set repository variables after you provide `TF_VAR_github_token`. | The `azd` post-provision hook uses `gh` CLI to set repository variables. |
| Teardown | Run `terraform destroy` from `infra/terraform/`. | Run `azd down` from the repository root. |
| Best fit | Default choice when you want the canonical path, explicit plans, and Terraform workflows. | Azure-native choice when you want `azd up`, ARM idempotency, and a Bicep-first workflow. |

Both paths create equivalent Azure resources: Resource Group, Log Analytics Workspace, Storage Account and queue, Container Registry, Container Apps environment, Container App Job, Key Vault, User-Assigned Managed Identity, RBAC, and federated credentials.

---

## Step 1: Fork or clone

### Fork (recommended for customization)

Fork the repository to your org/account so you can push changes:

```bash
gh repo fork haflidif/squad-on-aca --clone
cd squad-on-aca
```

### Clone (for evaluation)

```bash
git clone https://github.com/haflidif/squad-on-aca.git
cd squad-on-aca
```

**When to fork**: You plan to customize the Dockerfile, entrypoint, or infrastructure for your org.
**When to clone**: You want to evaluate the platform or contribute upstream.

---

## Step 2: Create a GitHub App

The GitHub App is the bot identity for all PR operations. This is a one-time setup.

### 2.1 Navigate to GitHub App creation

- **For an organization**: Go to `https://github.com/organizations/{your-org}/settings/apps/new`
- **For personal account**: Go to `https://github.com/settings/apps/new`

### 2.2 Fill in the form

| Field | Value |
|-------|-------|
| **App name** | `squad-aca-bot` (or your preference — must be globally unique) |
| **Homepage URL** | `https://github.com/haflidif/squad-on-aca` |
| **Webhook** | **Uncheck** "Active" — this platform uses queue polling, not webhooks |

### 2.3 Set permissions

Under **Repository permissions**, set:

| Permission | Access | Why |
|-----------|--------|-----|
| **Issues** | Read & write | Add/remove labels, read issue details |
| **Pull requests** | Read & write | Create PRs, add comments |
| **Contents** | Read & write | Clone repos, push commits |

Leave all other permissions at "No access."

### 2.4 Installation target

- Select **"Only on this account"** for personal use
- Select **"Any account"** if you want other orgs to install it

### 2.5 Create and note IDs

After clicking **Create GitHub App**:

1. Note the **App ID** (numeric, shown at the top of the app settings page)
2. Scroll to **Private keys** → click **Generate a private key** → save the `.pem` file securely
3. Go to **Install App** → click on your org/account → select repos → **Install**
4. Note the **Installation ID** from the URL: `https://github.com/settings/installations/{INSTALLATION_ID}`

---

## Choose your IaC path

Two supported IaC paths create equivalent Azure resources. Complete one path (A or B), then continue at [Step 6](#step-6-build-and-push-container-image).

| | [Path A: Terraform](#path-a-terraform) | [Path B: Bicep + azd](#path-b-bicep--azd) |
|---|---|---|
| Best fit | Default, canonical path — explicit plans, Terraform workflows | Azure-native — `azd up`, ARM idempotency, Bicep-first workflow |

Not sure which to pick? See [Terraform vs Bicep and azd: which should you choose?](#terraform-vs-bicep-and-azd-which-should-you-choose)

---

## Path A: Terraform

The canonical, default path — explicit plans, Terraform state, and Terraform workflows. Follow Path A · Steps 3–5, then continue at [Step 6](#step-6-build-and-push-container-image).

### Path A · Step 3: Configure Terraform variables

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
# Required
subscription_id              = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
github_app_id                = "123456"
github_app_installation_id   = "98765432"
target_repos                 = ["your-org/your-repo"]

# Optional (defaults shown)
project_name                 = "squad-aca"
environment                  = "dev"
location                     = "swedencentral"
queue_name                   = "squad-work-queue"

# Optional: tune agent resources
agent_job_config = {
  cpu             = 1.0     # 0.25 to 2.0
  memory          = "2Gi"   # Must match CPU tier
  max_executions  = 10      # Max parallel containers
  timeout_seconds = 1800    # 30 minutes
}
```

### Setting the GitHub token

**Never write secrets to files.** Set `github_token` as an environment variable before running Terraform:

**PowerShell:**
```powershell
$env:TF_VAR_github_token = "ghp_your_token_here"
```

**Bash/Linux/macOS:**
```bash
export TF_VAR_github_token="ghp_your_token_here"
```

Terraform automatically reads `TF_VAR_*` environment variables and maps them to Terraform variables. This keeps secrets out of your file system.

> **Note**: The `github_token` is used **only** by Terraform to set GitHub Actions repository variables. It's not stored in any deployed resource.

---

### Path A · Step 4: Deploy infrastructure

```bash
cd infra/terraform

# Initialize Terraform
terraform init

# Preview changes
terraform plan -out=tfplan

# Apply
terraform apply tfplan
```

This creates:
- Resource Group
- Log Analytics Workspace
- Storage Account + Queue
- Container Registry (Basic)
- Container Apps Managed Environment
- Container App Job (KEDA-triggered)
- Key Vault
- User-Assigned Managed Identity + RBAC roles
- Federated Identity Credentials (per target repo)
- GitHub Actions repository variables (per target repo)

**Save the outputs** — you'll need them:

```bash
terraform output -json
```

Key outputs:
- `key_vault_name` — where to upload secrets
- `acr_login_server` — where to push the container image
- `agent_job_name` — the Container App Job name for monitoring

---

### Path A · Step 5: Upload secrets to Key Vault

Two secrets must be uploaded manually (they're intentionally kept out of Terraform state):

```bash
# Get Key Vault name from Terraform output
KV_NAME=$(terraform output -raw key_vault_name)

# Upload GitHub App private key
az keyvault secret set \
  --vault-name "${KV_NAME}" \
  --name "github-app-private-key" \
  --file /path/to/your-app.pem

# Upload Copilot PAT
# This must be from a user with an active GitHub Copilot license
az keyvault secret set \
  --vault-name "${KV_NAME}" \
  --name "copilot-pat" \
  --value "ghp_YOUR_COPILOT_LICENSED_PAT"
```

### Generating the Copilot PAT

1. Go to `https://github.com/settings/tokens?type=beta` (fine-grained PAT)
2. Or use `https://github.com/settings/tokens/new` (classic PAT)
3. The user **must** have an active Copilot license (Copilot Business or Individual)
4. Required scope: `copilot` (if using fine-grained tokens — classic tokens need no special scope beyond default)
5. Set expiration to maximum allowed (recommend 90 days, set a reminder)

---

## Path B: Bicep + azd

Azure-native alternative using Bicep and the Azure Developer CLI. Follow Path B · Steps 3–5, then continue at [Step 6](#step-6-build-and-push-container-image).

> **What `azd up` already does for you:** The post-provision hook (`infra/hooks/postprovision.sh` / `.ps1`) builds and pushes the agent container image to ACR and sets the GitHub Actions repository variables (`SQUAD_AZURE_CLIENT_ID`, `SQUAD_AZURE_TENANT_ID`, `SQUAD_AZURE_SUBSCRIPTION_ID`, `SQUAD_STORAGE_ACCOUNT`, `SQUAD_QUEUE_NAME`) on each target repo. **You can skip Step 6** (and the repo-variable portion of later steps) unless you are customizing the agent image.

### Prerequisites

Install and sign in to the tools used by the post-provision hooks:

```bash
azd auth login
az login
az bicep version || az bicep install
gh auth login
```

Your `gh` login needs permission to set repository variables on each target repo.

### Path B · Step 3: Configure Bicep parameters

The Bicep entry point is `infra/bicep/main.bicep`, with sample values in `infra/bicep/main.bicepparam`. Set these required values before provisioning:

| Parameter | Description |
|-----------|-------------|
| `githubAppId` | GitHub App ID from Step 2 |
| `githubAppInstallationId` | GitHub App installation ID from Step 2 |
| `deployerPrincipalId` | Object ID for the user or service principal running deployment |

Common optional parameters include `location`, `projectName`, `environment`, `githubRepo`, `queueName`, `targetRepos`, `agentCpu`, `agentMemory`, `agentMaxExecutions`, and `agentTimeoutSeconds`.

Get your deployer principal ID with:

```bash
az ad signed-in-user show --query id -o tsv
```

### Path B · Step 4: Run azd

From the repository root, run:

```bash
azd up
```

`azd up` runs provisioning and deployment end to end. If you need to split the flow, use:

```bash
azd provision
azd deploy
```

The post-provision hook sets the following GitHub Actions repository variables on each target repo by calling `gh` CLI:

- `SQUAD_AZURE_CLIENT_ID`
- `SQUAD_AZURE_TENANT_ID`
- `SQUAD_AZURE_SUBSCRIPTION_ID`
- `SQUAD_STORAGE_ACCOUNT`
- `SQUAD_QUEUE_NAME`

### Path B · Step 5: Upload secrets to Key Vault

Secret values stay out of Bicep and out of deployment state. After provisioning, find the Key Vault name and upload the two runtime secrets.

Get the Key Vault name:

```bash
# Option 1: from azd environment outputs (if exposed as an output)
azd env get-values | grep KEY_VAULT

# Option 2: always works
KV_NAME=$(az keyvault list -g <resource-group> --query "[0].name" -o tsv)
```

Then upload:

```bash
az keyvault secret set \
  --vault-name "${KV_NAME}" \
  --name "github-app-private-key" \
  --file /path/to/your-app.pem

az keyvault secret set \
  --vault-name "${KV_NAME}" \
  --name "copilot-pat" \
  --value "ghp_YOUR_COPILOT_LICENSED_PAT"
```

For Copilot PAT requirements, see [Generating the Copilot PAT](#generating-the-copilot-pat) under Path A · Step 5.

The post-provision hook prints guidance for this step, but it does not store secret values in source control or IaC state.

### Tear down Bicep resources

When you no longer need the environment, run:

```bash
azd down
```

Review the prompt carefully before confirming deletion.

---

## Both paths converge here

Whether you deployed with **Path A (Terraform)** or **Path B (Bicep + azd)**, continue with Step 6. If you used `azd up`, read the leading note in Step 6 — you may be able to skip it entirely.

---

## Step 6: Build and push container image

> **azd (Path B) users:** The post-provision hook already imports the base images, then builds and pushes the agent image to ACR as part of `azd up`. **You can skip this step** unless you are customizing the agent image.

Before building, set your ACR name and login server.

**If you deployed with Terraform (Path A):**

```bash
ACR_NAME=$(cd infra/terraform && terraform output -raw acr_name)
ACR_LOGINSERVER=$(cd infra/terraform && terraform output -raw acr_login_server)
```

**If you deployed with Bicep + azd (Path B):**

```bash
# Option 1: from azd environment outputs (if exposed as an output)
azd env get-values | grep ACR

# Option 2: always works
ACR_NAME=$(az acr list -g <resource-group> --query "[0].name" -o tsv)
ACR_LOGINSERVER=$(az acr show -n "${ACR_NAME}" --query loginServer -o tsv)
```

### Option A: Build remotely with ACR (recommended)

```bash
cd agents/base

# Import base images first (one-time)
az acr import --name "${ACR_NAME}" \
  --source docker.io/library/golang:1.23.4-bookworm \
  --image base/golang:1.23.4-bookworm

az acr import --name "${ACR_NAME}" \
  --source docker.io/library/debian:bookworm-20240701-slim \
  --image base/debian:bookworm-20240701-slim

# Build and push (add --no-logs on Windows to avoid encoding issues)
az acr build \
  --registry "${ACR_NAME}" \
  --image squad-agent:latest \
  --build-arg "BASE_ACR_HOST=${ACR_LOGINSERVER}/" \
  .
```

The `BASE_ACR_HOST` build argument overrides the Dockerfile default so the `FROM` lines use your ACR. Run the base-image import commands first so those images exist in your registry.

### Option B: Build locally with Docker

```bash
cd agents/base

# Import base images first with the commands from Option A, then sign in so Docker can pull them
az acr login --name "${ACR_NAME}"
docker build --build-arg "BASE_ACR_HOST=${ACR_LOGINSERVER}/" -t squad-agent:latest .
docker tag squad-agent:latest "${ACR_LOGINSERVER}/squad-agent:latest"
docker push "${ACR_LOGINSERVER}/squad-agent:latest"
```

> **Important**: The Dockerfile `FROM` lines use the `BASE_ACR_HOST` build argument. Pass your ACR login server with a trailing slash; do not change the Dockerfile. Option A is simpler because the build runs inside ACR after the base images are imported.

---

## Step 7: Install workflow templates on target repos

For each repository in your `target_repos` list, copy the workflow files:

### New issue workflow (required)

```bash
# From the squad-on-aca repo root
cp agents/workflows/squad-queue.yml /path/to/target-repo/.github/workflows/squad-queue.yml
```

### Revision feedback loop (recommended)

```bash
cp agents/workflows/squad-revise.yml /path/to/target-repo/.github/workflows/squad-revise.yml
```

Commit and push:

```bash
cd /path/to/target-repo
git add .github/workflows/
git commit -m "feat: add Squad on ACA workflow templates"
git push
```

The repository variables (`SQUAD_AZURE_CLIENT_ID`, `SQUAD_AZURE_TENANT_ID`, etc.) were set during deployment — by Terraform (Path A) or by the `azd` post-provision hook (Path B) — so the workflows will have everything they need.

---

## Step 7.5: Initialize your Squad team on target repos

Before testing, each target repo needs a Squad team. [Squad](https://bradygaster.github.io/squad/) (the framework) creates agent charters, routing rules, team configuration, and labels — this platform (Squad on ACA) provides the serverless infrastructure to run those agents headlessly.

### How Squad initialization works

1. **Start a Copilot CLI session** in your target repo with the Squad agent manifest:
   ```bash
   cd /path/to/target-repo
   # Ensure .github/agents/squad.agent.md exists (the Squad coordinator manifest)
   # Start a Copilot session — Squad will propose a team
   copilot --agent squad
   ```

2. **Squad proposes a team**: Squad's casting system assigns unique agent names from a fictional universe (e.g., `ripley`, `data`, `gandalf`). You'll see a proposal with roles, specialties, and routing rules.

3. **Confirm the proposal**: Once you approve, Squad creates:

   **The `.squad/` directory:**
   - `team.md` — Agent roster with names, roles, and specialties
   - `routing.md` — Rules for dispatching work to agents
   - Agent charter files — Per-agent instructions and context
   - `decisions.md` / `history.md` — Institutional memory (grows over time)

   **Labels on the repo** (from Squad's [label taxonomy](https://bradygaster.github.io/squad/docs/features/labels/)):
   - `squad:{agent-name}` — One per team member, derived from `team.md` (allows multiple per issue for pair work)
   - `go:*` — Verdict labels (yes/no/needs-research) — mutually exclusive
   - `type:*` — Issue category — mutually exclusive
   - `priority:*` — Urgency — mutually exclusive
   - `release:*` — Release target — mutually exclusive

   **Automation workflows:**
   - `sync-squad-labels.yml` — Keeps labels in sync with the team roster
   - `label-enforcement.yml` — Enforces mutual exclusivity within label namespaces
   - `squad-heartbeat.yml` — Periodic triage and auto-assignment

4. **Commit and push**:
   ```bash
   git add .squad/ .github/
   git commit -m "feat: initialize Squad team"
   git push
   ```

### What this platform uses

Squad on ACA only uses **`squad:{agent-name}` labels** from Squad's taxonomy to trigger agent runs. The other label namespaces (`go:*`, `type:*`, etc.) are part of Squad's broader project management features — they don't affect the platform.

The platform adds its own **operational labels** (`squad:processing`, `squad:queued`) via the container entrypoint for deduplication and lifecycle tracking. These are separate from Squad's taxonomy.

### The bridge between Squad and Squad on ACA

| Concern | Squad (framework) | Squad on ACA (platform) |
|---------|-------------------|------------------------|
| Team creation | `squad init` creates `.squad/`, agent charters, routing rules | Container reads committed `.squad/team.md` at runtime |
| Labels | Creates `squad:{agent-name}` + full taxonomy during init | Entrypoint adds `squad:processing` and `squad:queued` |
| Label sync | `sync-squad-labels.yml` keeps agent labels current | `squad-queue.yml` triggers on `issues.labeled` events |
| Agent routing | Defines agent charters and `@{agent-name}` mentions | Passes `agent_type` from queue message to `copilot --yolo --agent squad` |

### If you need to add labels manually

If `squad init` didn't create labels (e.g., running on a repo without GitHub CLI access), you can create them manually:

```bash
# Check .squad/team.md for your agent names
# Example: if your team has agents named "ripley", "data", and "gandalf"
gh label create "squad:ripley" --repo your-org/your-repo --color "008672"
gh label create "squad:data" --repo your-org/your-repo --color "008672"
gh label create "squad:gandalf" --repo your-org/your-repo --color "008672"
```

Or run `squad upgrade` to re-sync labels with the current team roster.

### Optional: Create GitHub issue templates

Consider creating issue templates with squad labels pre-configured so users can easily assign issues to agents:

```yaml
# .github/ISSUE_TEMPLATE/squad-task.yml
name: Squad Agent Task
description: Create a task for a Squad agent
labels: []  # Users select agent label when creating
body:
  - type: textarea
    attributes:
      label: Task Description
      description: Describe what the agent should do
```

---

## Step 8: Test end-to-end

### 8.1 Create a test issue

Go to your target repo on GitHub and create an issue:

```
Title: Test Squad agent — add a hello world file
Body: Create a file called hello.txt with the content "Hello from Squad on ACA!"
```

### 8.2 Label the issue

Add a `squad:{agent-name}` label (using an agent name from your `.squad/team.md`). These labels were created automatically during `squad init` in Step 7.5.

If a label is missing, create it manually:

```bash
# Example: if your Squad team has an agent named "ripley"
gh label create "squad:ripley" --repo your-org/your-repo --color "008672"
```

### 8.3 Watch the pipeline

1. **GitHub Actions**: Go to the Actions tab → "Squad Issue Queue" workflow should run
2. **Azure Portal**: Go to the Container App Job → Executions → a new execution should appear within ~60 seconds
3. **Pull Request**: Within a few minutes, a PR should appear on the repo

### 8.4 Verify the PR

The PR should have:
- Title: `squad({agent-name}): resolve issue #N`
- Body with: Agent Activity, Changes Made, Commits, Pipeline Status
- Branch: `squad/{agent-name}/issue-N`

### 8.5 Test the revision loop

1. Add a review comment on the PR (e.g., "Please also add a goodbye.txt file")
2. Comment `/squad revise` on the PR
3. The "Squad PR Revise" workflow should run
4. The bot should push additional commits addressing the feedback

---

## Step 9: Add more target repos

To onboard additional repositories:

### 9.1 Add the repo to your IaC

**Path A: Terraform** — Edit `infra/terraform/terraform.tfvars`:

```hcl
target_repos = [
  "your-org/repo-one",
  "your-org/repo-two",   # new
  "your-org/repo-three", # new
]
```

```bash
cd infra/terraform
terraform apply
```

**Path B: Bicep + azd** — Add the repo to `targetRepos` in `infra/bicep/main.bicepparam`, then re-provision:

```bash
azd provision
```

The post-provision hook wires the new repo's GitHub Actions variables and federated credentials automatically.

Both paths create:
- Federated identity credentials for each new repo
- GitHub Actions variables on each new repo

### 9.2 Install the GitHub App

Go to your GitHub App's settings → **Install App** → ensure each new repo is selected.

### 9.3 Copy workflow files

```bash
cp agents/workflows/squad-queue.yml /path/to/new-repo/.github/workflows/
cp agents/workflows/squad-revise.yml /path/to/new-repo/.github/workflows/
```

### 9.4 Initialize Squad on the new repo

Each new target repo needs Squad initialized:

1. **Run `squad init`** on the new repo (see Step 7.5). This creates `.squad/`, agent charters, and `squad:{agent-name}` labels automatically. Alternatively, copy `.squad/` from an existing target repo if using the same team, then run `squad upgrade` to sync labels.
2. **Commit and push** the `.squad/` directory.

> **Note**: `squad init` creates the agent labels. The entrypoint only auto-creates `squad:processing` and `squad:queued` pipeline labels — those are separate from Squad's label taxonomy.

If `squad init` wasn't able to create labels (e.g., no GitHub CLI access during init), create them manually:

```bash
# Example: if your Squad team has agents named "ripley" and "data"
gh label create "squad:ripley" --repo your-org/new-repo --color "008672"
gh label create "squad:data" --repo your-org/new-repo --color "008672"
```

---

## Customizing Agents

### Adding tools to the container

Edit `agents/base/Dockerfile` to add tools your agents need:

```dockerfile
# In the runtime stage, add your tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    terraform \
    && rm -rf /var/lib/apt/lists/*
```

Rebuild and push:

```bash
az acr build \
  --registry "${ACR_NAME}" \
  --image squad-agent:latest \
  --build-arg "BASE_ACR_HOST=${ACR_LOGINSERVER}/" \
  ./agents/base
```

### Changing the Copilot model

Edit `agents/base/entrypoint.sh` to pass model flags:

```bash
# Change the copilot invocation (search for "copilot --yolo")
echo "${SQUAD_PROMPT}" | copilot --yolo --agent squad --model gpt-4o
```

### Adjusting resources

Edit `terraform.tfvars`:

```hcl
agent_job_config = {
  cpu             = 2.0      # More CPU for complex tasks
  memory          = "4Gi"    # More RAM for large repos
  max_executions  = 20       # More parallel agents
  timeout_seconds = 3600     # 1 hour timeout
}
```

---

## Setting Up the `/squad revise` Feedback Loop

The revision flow is an optional but recommended addition:

1. **Install the workflow**: Copy `agents/workflows/squad-revise.yml` to each target repo's `.github/workflows/` directory.

2. **Usage**: After a Squad PR is created, any reviewer with write access can:
   - Leave review comments (general or inline code comments)
   - Comment `/squad revise` on the PR
   - The bot will address the feedback and push new commits

3. **Guards** (automatic):
   - Only works on PRs with `squad/*/issue-*` branch pattern
   - Only works on PRs authored by `squad-aca-bot[bot]`
   - Commenter must have write or admin access
   - `squad:revising` label prevents concurrent revisions

4. **Labels are auto-created**: The workflow creates `squad:revising` if it doesn't exist.

---

## Common Pitfalls and Solutions

### "Container job starts but exits immediately with code 0"

**Cause**: Queue is empty when the container starts (KEDA over-trigger).
**Solution**: This is normal behavior. KEDA may trigger a container slightly after another container has already drained the queue. The entrypoint exits cleanly.

### "PR not created — no commits on branch"

**Cause**: Copilot CLI ran but didn't produce any changes.
**Solution**: Check the PR body for the fallback work artifact. The issue description may be too vague for Copilot to act on. Make the issue more specific.

### "az login --identity failed"

**Cause**: UAMI client ID mismatch or missing role assignments.
**Solution**:
1. Verify `AZURE_CLIENT_ID` matches the UAMI client ID:
   - Path A (Terraform): `cd infra/terraform && terraform output -raw squad_agent_client_id`
   - Path B (Bicep + azd): `az identity list -g <resource-group> --query "[0].clientId" -o tsv`
2. Verify RBAC roles: `az role assignment list --assignee <UAMI-principal-id>`
3. Wait 5 minutes — RBAC propagation can take time after initial deployment.

### "Failed to retrieve private key from Key Vault"

**Cause**: PEM not uploaded, or UAMI missing Key Vault Secrets User role.
**Solution**:
1. Check the secret exists: `az keyvault secret show --vault-name <kv> --name github-app-private-key`
2. Verify RBAC: `az role assignment list --scope <kv-resource-id> --assignee <UAMI-principal-id>`

### "KEDA never triggers the container"

**Cause**: KEDA can't authenticate to the queue, or the queue is empty.
**Solution**:
1. Verify messages are on the queue: `az storage message peek --queue-name squad-work-queue --account-name <sa> --auth-mode login`
2. Check UAMI has `Storage Queue Data Reader` on the storage account.
3. Check the KEDA scale rule uses the UAMI ID (not a connection string).
4. Check Container App Job execution history: `az containerapp job execution list --name <job> --resource-group <rg>`

### "Copilot CLI fails with auth error"

**Cause**: Copilot PAT expired, revoked, or user lost Copilot license.
**Solution**:
1. Test the PAT: `GITHUB_TOKEN=<pat> gh copilot --version`
2. Generate a new PAT from a Copilot-licensed user.
3. Upload to Key Vault: `az keyvault secret set --vault-name <kv> --name copilot-pat --value <new-pat>`

### "Windows: `az acr build` shows garbled output"

**Cause**: Docker build output contains emoji/unicode that Windows terminal can't render.
**Solution**: Add `--no-logs` to suppress streaming output:
```bash
az acr build \
  --registry <acr> \
  --image squad-agent:latest \
  --build-arg "BASE_ACR_HOST=<your-acr-login-server>/" \
  . \
  --no-logs
```

---

## Cost Estimation Worksheet

Fill in your expected usage to estimate monthly costs:

| Component | Formula | Your Estimate |
|-----------|---------|--------------|
| **Container runtime** | Issues/month × avg minutes × $0.001/min | ___ issues × ___ min × $0.001 = $____ |
| **Storage Queue** | Issues/month × 3 ops × $0.000004/10K ops | Negligible (~$0.00) |
| **Key Vault** | $0.03/10K operations + $0.06/rotation | ~$0.60/month |
| **Container Registry** | Basic SKU fixed | $5.00/month |
| **Log Analytics** | ~0.01 GB/issue × issues/month × $2.76/GB | ___ issues × $0.03 = $____ |
| **Total fixed costs** | ACR + KV | **~$5.60/month** |
| **Total variable costs** | Container + Logs | **$_____/month** |

### Example: 50 issues/month, 5 minutes each

| Component | Cost |
|-----------|------|
| Container runtime | 50 × 5 × $0.001 = **$0.25** |
| Fixed infrastructure | **$5.60** |
| Log Analytics | 50 × $0.03 = **$1.50** |
| **Monthly total** | **~$7.35** |

Compare: AKS with a single node runs ~$72/month idle.
