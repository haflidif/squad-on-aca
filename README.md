# Squad on ACA

> Run [Squad](https://bradygaster.github.io/squad/) AI agents on Azure Container App Jobs — **$0 idle cost**, full multi-agent orchestration.

Label a GitHub issue with `squad:{agent-name}`, and a serverless container wakes up, analyzes the issue, writes code, and opens a pull request. When it's done, it shuts down. You only pay when agents are actively working.

Built on [Squad](https://bradygaster.github.io/squad/) · [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-cli) · [Azure Container App Jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs) · [KEDA](https://keda.sh/) · [GitHub Apps](https://docs.github.com/en/apps/creating-github-apps)

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

→ See [Architecture deep-dive](docs/architecture.md) for sequence diagrams, component details, and the entrypoint decision tree.

---

## Key Features

✅ **$0 Idle Cost** — Containers only run when issues are labeled. No background processes, no always-on VMs.

✅ **Full Squad Multi-Agent Orchestration** — Each container runs the full Squad framework. Agents read `.squad/team.md`, dispatch work, and persist learnings.

✅ **Charter-Aware Agents** — Agents read team charter and decision history from `.squad/` repo state. Charter-driven routing via `@{agent-name}` mentions.

✅ **Enriched PR Descriptions** — Agent summary, diff stats, commit log, team decisions, and pipeline status — all in the PR body.

✅ **Team State Persistence** — `.squad/decisions.md` and `.squad/history.md` flow through PRs back into the repo.

✅ **Two-Layer Label System** — Squad creates agent labels (`squad:{agent-name}`) via `squad init`. The platform adds operational labels (`squad:processing`, `squad:queued`) for dedup and tracking.

✅ **Identity-Based Auth Everywhere** — No shared keys. All Azure services use Managed Identity. GitHub ops use temporary tokens (10-min JWT, 1-hour installation token).

✅ **Graceful Fallback** — If Copilot CLI fails, a work artifact is created and a PR is still opened so context isn't lost.

---

## Quick Start

> **Prerequisites**: Azure subscription, GitHub account with Copilot license, Terraform ≥ 1.5, Azure CLI, GitHub CLI.
> Full checklist → [Adoption Guide](docs/adoption-guide.md#prerequisites-checklist)

### 1. Clone

```bash
git clone https://github.com/haflidif/squad-on-aca.git && cd squad-on-aca
```

### 2. Create a GitHub App

Create a GitHub App with **Issues**, **Pull Requests**, and **Contents** (all Read & write). Note the **App ID** and **Installation ID**. Generate and download a **private key** (`.pem`).

→ Step-by-step: [Adoption Guide — Create a GitHub App](docs/adoption-guide.md#step-2-create-a-github-app)

### 3. Deploy with Terraform

```bash
cd infra
# Edit terraform.tfvars with your subscription ID, App ID, Installation ID, target repos
# Set TF_VAR_github_token via environment variable (never in files)
terraform init && terraform apply
```

→ Full variable reference: [Adoption Guide — Deploy Infrastructure](docs/adoption-guide.md#step-3-deploy-infrastructure)

### 4. Upload Secrets to Key Vault

```bash
KV_NAME=$(terraform output -raw key_vault_name)
az keyvault secret set --vault-name "${KV_NAME}" --name "github-app-private-key" --file /path/to/key.pem
az keyvault secret set --vault-name "${KV_NAME}" --name "copilot-pat" --value "YOUR_COPILOT_PAT"
```

### 5. Test It

1. Copy `agents/workflows/squad-queue.yml` to your target repo's `.github/workflows/`
2. Label any issue with `squad:{agent-name}` (agent names from `.squad/team.md`)
3. Watch: workflow runs → container spins up → PR gets created!

→ Full onboarding: [Adoption Guide — Target Repo Setup](docs/customization.md#target-repo-setup)

---

## Cost Model

| Component | Cost | Notes |
|-----------|------|-------|
| **Container App Job** | $0.000017/sec | Only when running |
| **Storage Queue** | ~$0.001/M ops | Negligible |
| **Key Vault** | ~$0.6/mo | Fixed |
| **Container Registry** | $5/mo (Basic) | Fixed |
| **Log Analytics** | ~$0.50/GB | Optional |

**Example**: 100 issues/month × 5 min each = **~$6/month total** (infrastructure-dominant).

| Alternative | Monthly Cost |
|-------------|-------------|
| AKS cluster (idle) | ~$72 |
| App Service (always-on) | $15–50 |
| **Squad on ACA** | **~$6** ✅ |

---

## Contributing

Contributions welcome! Areas for expansion:
- Multi-region deployment
- Per-agent CPU/memory tuning
- Additional fallback strategies
- Teams/Slack notifications
- Custom agents beyond Copilot CLI

---

## Documentation

| Document | Description |
|----------|-------------|
| [Adoption Guide](docs/adoption-guide.md) | Full step-by-step deployment guide with prerequisites |
| [Architecture](docs/architecture.md) | Sequence diagrams, component diagrams, KEDA scaling model, RBAC map |
| [Infrastructure](docs/infrastructure.md) | Terraform modules, key decisions, component details |
| [Customization](docs/customization.md) | Container image, entrypoint, new agent types, target repo setup |
| [Limitations](docs/limitations.md) | Known limitations with mitigations |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and how to resolve them |
| [FAQ](docs/faq.md) | Frequently asked questions |
| [Thought Process](docs/thought-process.md) | Design rationale and decision history |

---

## License

Squad on ACA is released under [MIT License](LICENSE).
