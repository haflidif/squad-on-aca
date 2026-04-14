# Squad Issue Queue — Workflow Template

This GitHub Actions workflow replaces the Azure Function App as the issue-to-queue bridge. It fires when a `squad:*` label is added to an issue, authenticates to Azure via OIDC (zero secrets), and enqueues the issue to Azure Storage Queue for processing by the Container App Job.

## Architecture

```
GitHub Issue → [squad:{agent-name} label] → GitHub Actions workflow → Azure Storage Queue → KEDA → Container App Job → Copilot CLI → PR
```

## Installation

### 1. Copy the workflow

Copy `squad-queue.yml` into your target repository:

```bash
# From the squad-on-aca repo root
cp agents/workflows/squad-queue.yml <target-repo>/.github/workflows/squad-queue.yml
```

### 2. Set GitHub repository variables

Go to **Settings → Secrets and variables → Actions → Variables** in the target repo and add:

| Variable | Description | Example |
|----------|-------------|---------|
| `SQUAD_AZURE_CLIENT_ID` | User-Assigned Managed Identity client ID | `12345678-abcd-...` |
| `SQUAD_AZURE_TENANT_ID` | Azure AD tenant ID | `87654321-dcba-...` |
| `SQUAD_AZURE_SUBSCRIPTION_ID` | Azure subscription ID | `abcdefgh-1234-...` |
| `SQUAD_STORAGE_ACCOUNT` | Storage account name | `stsquadacaa6b49feb` |
| `SQUAD_QUEUE_NAME` | Storage queue name | `squad-work-queue` |

> **Note:** These are repository **variables** (`vars.*`), not secrets. None of these values are sensitive — they're resource identifiers, not credentials.

### 3. Add a federated credential on the UAMI

The workflow uses OIDC to authenticate to Azure. You need to add a federated identity credential on the User-Assigned Managed Identity so GitHub Actions can exchange its OIDC token for an Azure access token.

#### Using Terraform (recommended)

If you're using the squad-on-aca Terraform config, add a federated credential resource:

```hcl
resource "azurerm_federated_identity_credential" "github_actions" {
  name                = "github-actions-<repo-name>"
  resource_group_name = azurerm_resource_group.squad.name
  parent_id           = azurerm_user_assigned_identity.squad_agent.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  subject             = "repo:<owner>/<repo>:ref:refs/heads/main"
}
```

> **Subject filter:** The `subject` field controls which branches/environments can authenticate. Options:
> - `repo:owner/repo:ref:refs/heads/main` — only the main branch
> - `repo:owner/repo:environment:production` — only a specific environment
> - `repo:owner/repo:ref:refs/heads/*` — any branch (broader, use with caution)

#### Using Azure CLI

```bash
az identity federated-credential create \
  --name "github-actions-<repo-name>" \
  --identity-name "<uami-name>" \
  --resource-group "<rg-name>" \
  --issuer "https://token.actions.githubusercontent.com" \
  --subject "repo:<owner>/<repo>:ref:refs/heads/main" \
  --audiences "api://AzureADTokenExchange"
```

### 4. Assign RBAC roles

The UAMI needs the following role on the storage account (or queue scope):

| Role | Scope | Purpose |
|------|-------|---------|
| **Storage Queue Data Message Sender** | Storage account or queue | Send messages to the queue |

> The UAMI likely already has `Storage Queue Data Contributor` from the Container App Job setup — this includes message send permissions.

## How it works

### Trigger

The workflow triggers on the `issues: [labeled]` event. It only runs when the added label starts with `squad:` (e.g., `squad:{agent-name}` — where agent names come from your team's `.squad/team.md`).

### Dedup flow

Adding the `squad:processing` label itself triggers another `issues.labeled` event (because it starts with `squad:`). The workflow handles this with a two-layer dedup:

1. **Direct check:** If the triggering label IS `squad:processing`, skip immediately.
2. **Existing label check:** If the issue already has `squad:processing`, skip.

This makes the dedup bulletproof against infinite loops.

### Label lifecycle

> **Prerequisite**: The `squad:{agent-name}` label must already exist on the repo. Agent labels are created automatically during `squad init` or `squad upgrade`. If needed, the `sync-squad-labels.yml` workflow keeps them in sync with the team roster, or you can create them manually with `gh label create`. The pipeline labels (`squad:processing`, `squad:queued`) are separate — they're auto-created by the container entrypoint, not by Squad.

```
1. User adds "squad:{agent-name}" label to issue (label must already exist)
2. Workflow fires → dedup passes → OIDC login
3. Workflow adds "squad:processing" label
4. Workflow enqueues message to Storage Queue
5. (GitHub fires another labeled event for "squad:processing")
6. Workflow fires again → dedup catches it → skips
7. Container App Job picks up message → does work → creates PR
8. Container swaps labels: squad:processing → squad:queued
9. PR body contains "Closes #N" → merging closes the issue
```

### Queue message format

The message matches the schema expected by `entrypoint.sh`:

```json
{
  "issue_number": 42,
  "agent_type": "{agent-name}",
  "repo": "owner/repo",
  "title": "Add user authentication"
}
```

The message is base64-encoded before being placed on the queue (Azure Storage Queue requirement).

### Retrying failed enqueues

If the enqueue step fails (e.g., Azure auth issue), the `squad:processing` label will already be on the issue. To retry:

1. Remove the `squad:processing` label from the issue.
2. Remove and re-add the `squad:{agent-name}` (or relevant) label.

This triggers the workflow again with a clean dedup state.

## Why not Azure Functions?

The original approach used a timer-triggered Python Azure Function to poll for labeled issues. This had issues:

- **Consumption plan + identity-based storage** — The Function App struggled with `AzureWebJobsStorage` in identity-based mode on the Consumption plan.
- **Polling vs. event-driven** — Timer triggers poll every N minutes; GitHub Actions fires instantly on label events.
- **Secret management** — Function App needed a GitHub PAT stored as an app setting. This workflow uses `github.token` (automatic, scoped, ephemeral).
- **OIDC** — GitHub Actions has native OIDC support for Azure auth. No secrets to rotate.
