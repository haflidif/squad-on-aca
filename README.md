# Squad on ACA — Serverless Agent Orchestration

Run [Squad](https://bradygaster.github.io/squad/) agents on Azure Container App Jobs with event-driven KEDA scaling. Zero cost when idle, scales proportionally to your issue queue.

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
                                  Container App Jobs
                                  ┌─────────┬──────────┐
                                  │ backend │ frontend │
                                  │ tester  │ docs     │
                                  └─────────┴──────────┘
                                           │
                                           ▼
                                     Pull Requests
```

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
