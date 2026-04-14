# Development & Customization

> How to customize the container image, entrypoint, and add new agent types.

---

## Customizing the Container Image

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

---

## Customizing the Entrypoint

Edit `agents/base/entrypoint.sh`:
- Modify the Copilot CLI invocation (e.g., add `--model gpt-4o`)
- Change the working branch naming convention
- Add additional dedup checks
- Customize the PR body format

---

## Adding a New Agent Type

Adding agents to your Squad team requires no infrastructure changes — only Squad initialization:

1. **Initialize your Squad team**: In your target repo, start a Copilot CLI session with the Squad agent manifest (`.github/agents/squad.agent.md`). Squad proposes a team with unique agent names from a fictional universe (e.g., `ripley`, `data`, `gandalf`). Confirm the proposal and Squad creates the `.squad/` directory with `team.md`, `routing.md`, and agent charters.
2. **Labels are created automatically**: `squad init` creates `squad:{agent-name}` labels on the repo for each team member, along with Squad's full label taxonomy. Squad also installs `sync-squad-labels.yml` to keep labels in sync with the roster.
3. **Commit the `.squad/` directory**: Push the initialized team config to git. When the container clones the repo, it reads `.squad/team.md` to discover agents.
4. **Label an issue**: Use `squad:{agent-name}` to trigger the pipeline. The queue message carries `"agent_type": "{agent-name}"`, the container runs `copilot --yolo --agent squad`, and Squad routes to the correct agent charter.
5. **No infrastructure changes**: The single generic Container App Job handles all agent types.

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
