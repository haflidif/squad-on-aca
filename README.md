# Squad on ACA — Serverless Agent Orchestration

[![Status: MVP](https://img.shields.io/badge/status-MVP-blue)](#project-status)

Run [Squad](https://bradygaster.github.io/squad/) agents on Azure Container App Jobs with event-driven KEDA scaling. Zero cost when idle, scales proportionally to your issue queue.

## How It Works

1. **GitHub Issue Created** – Developer creates an issue in any app repo (e.g., `azure-lz-dashboard`) and adds the `squad` label
2. **Ralph Triages** – Ralph (GitHub Actions heartbeat) detects the labeled issue and adds a `squad:{member}` label based on triage rules
3. **Function Polls** – Azure Function (timer-triggered) queries GitHub for issues with `squad:{member}` labels
4. **Message Enqueued** – For each matching issue, the Function enqueues a JSON message to the Storage Queue (contains issue number, repo, agent type)
5. **KEDA Scales** – KEDA monitors queue depth and scales the Container App Job from 0 to configured max executions
6. **Agent Works** – Each job execution reads a message, clones the app repo, runs the Squad agent against that issue, and opens a PR with the results
7. **Scribe Logs** – Results are recorded in the app repo's `.squad/` decision log; Ralph monitors for the next work item

## Architecture

```
GitHub Issues (label: squad)
       │
       ▼
Ralph Heartbeat (GitHub Actions) ──► Azure Function (timer, polls issues)
                                           │
                                           ▼
                                     Storage Queue (1 msg = 1 issue)
                                           │
                                     KEDA azure-queue scaler
                                           │
                                           ▼
                                    Container App Job
                                    (single generic job)
                                           │
                                           ▼
                                     Pull Requests
```

## Two-Repo Architecture

Squad on ACA consists of two repositories:

- **This Repository** (`squad-on-aca`) – The platform infrastructure
  - Terraform modules that provision Azure resources (Function App, Container App Jobs, Storage, Log Analytics, ACR)
  - Base Docker image with Squad CLI, git, and deployment tools
  - Reusable infrastructure for any Squad agent workload
  
- **Your App Repository** (e.g., `azure-lz-dashboard`) – Where agents do their work
  - Must contain a `.squad/` directory with agent configurations and decision history
  - Issues labeled `squad` in this repo trigger agent execution
  - Agents clone this repo, work on issues, and open PRs with changes

Point the platform at any app repo by updating `github_repo` in `terraform.tfvars`. The platform will automatically scale agents to handle issues labeled `squad` in that repo.

## Components

| Component | What | AVM Module |
|---|---|---|
| Log Analytics | Monitoring | `Azure/avm-res-operationalinsights-workspace` |
| Storage Account + Queue | Work queue | `Azure/avm-res-storage-storageaccount` |
| Container Registry | Agent images | `Azure/avm-res-containerregistry-registry` |
| ACA Environment | Container runtime | `Azure/avm-res-app-managedenvironment` |
| Container App Jobs | Agent execution | `Azure/avm-res-app-job` |
| App Service Plan | Function hosting | `Azure/avm-res-web-serverfarm` |
| Function App | Issue poller | `Azure/avm-res-web-site` |

## Cost

| State | Cost |
|---|---|
| **Idle** (no issues) | ~$0/mo — everything scales to zero |
| **Active** (5 issues) | ~$0.05–0.10 per agent execution |
| **Function** | Free tier (1M executions/mo) |
| **Ralph** | GitHub Actions free tier |

## Prerequisites

- Azure subscription
- GitHub PAT with `repo` scope
- Terraform >= 1.10
- Azure CLI (`az login`)

## Project Status

**MVP** — Core platform is stable and working end-to-end. The single generic Container App Job eliminates infrastructure sprawl while supporting unlimited agent types. Production-ready for teams running Squad agents on Azure.

## Quick Start

```bash
# Clone
git clone https://github.com/haflidif/squad-on-aca.git
cd squad-on-aca/infra

# Configure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# Deploy
terraform init
terraform plan
terraform apply

# Build and push agent image
az acr build --registry <acr-name> --image squad-agent:latest ../agents/base/
```

## Pointing at Your App Repo

Update the `github_repo` variable in `terraform.tfvars` to point at any repo with a `.squad/` directory:

```hcl
github_repo = "your-org/your-app-repo"
```

Issues labeled `squad` in that repo will be picked up by the agents automatically.

## License

MIT
