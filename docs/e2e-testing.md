# End-to-end testing

> Run real Azure deployments and smoke-test the deployed stack. Covers what-if dry runs, ephemeral
> deploy loops, and teardown — all with cross-platform scripts (bash and PowerShell).

---

## The three-layer testing model

| Layer | Script | Cost | What it does |
|-------|--------|------|--------------|
| **What-if dry run** | `whatif.sh` / `whatif.ps1` | Free | Calls `az deployment sub what-if` against a real subscription. Previews resource changes without creating anything. |
| **Manual ephemeral loop** | `smoke-test.sh` / `smoke-test.ps1` + `e2e.sh` / `e2e.ps1` | Real costs (teardown included) | Provisions into a throwaway resource group, runs assertions, tears down. |
| **Future CI** | Not yet wired | CI minutes + Azure costs | Trigger the e2e loop on pull requests using a service principal. |

---

## Prerequisites

You need all of the following before running these scripts:

| Tool | Minimum version | Install |
|------|-----------------|---------|
| Azure CLI (`az`) | >= 2.55 | [learn.microsoft.com](https://learn.microsoft.com/cli/azure/install-azure-cli) |
| Azure Developer CLI (`azd`) | Latest | [aka.ms/azd](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) |
| GitHub CLI (`gh`) | >= 2.40 | [cli.github.com](https://cli.github.com/) |
| PowerShell (`pwsh`) | >= 5.1 | Built-in on Windows; [github.com/PowerShell](https://github.com/PowerShell/PowerShell) on macOS/Linux |

You also need:

- **An Azure subscription** with Owner or Contributor access — resources are created and destroyed.
- **A deployer principal ID** — your user object ID or a service principal object ID.
  Run `az ad signed-in-user show --query id -o tsv` to get your user object ID.
- **A GitHub App ID and Installation ID** — required Bicep parameters; placeholder values work for
  what-if but a real deploy needs valid IDs.

Log in before running any script:

```bash
az login
azd auth login
az account set --subscription <your-subscription-id>
```

```powershell
az login
azd auth login
az account set --subscription <your-subscription-id>
```

---

## Layer 1: what-if dry run

The what-if scripts call `az deployment sub what-if` at subscription scope. No resources are created
or modified. Use this to validate your Bicep parameters and preview resource changes before spending money.

### Bash

```bash
./infra/tests/whatif.sh \
  --subscription xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --location swedencentral \
  --environment dev \
  --github-app-id 123456 \
  --github-installation-id 789012 \
  --deployer-principal-id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Or use environment variables:

```bash
export AZURE_SUBSCRIPTION_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export GITHUB_APP_ID=123456
export GITHUB_APP_INSTALLATION_ID=789012
export DEPLOYER_PRINCIPAL_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

./infra/tests/whatif.sh
```

### PowerShell

```powershell
.\infra\tests\whatif.ps1 `
  -Subscription        'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' `
  -Location            'swedencentral' `
  -Environment         'dev' `
  -GithubAppId         '123456' `
  -GithubInstallationId '789012' `
  -DeployerPrincipalId 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
```

Or use environment variables:

```powershell
$env:AZURE_SUBSCRIPTION_ID      = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
$env:GITHUB_APP_ID              = '123456'
$env:GITHUB_APP_INSTALLATION_ID = '789012'
$env:DEPLOYER_PRINCIPAL_ID      = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

.\infra\tests\whatif.ps1
```

### Expected output

```
==================================================================
 Squad on ACA — Bicep what-if dry run
==================================================================

  Subscription   : xxxxxxxx-...
  Location       : swedencentral
  ...
  NOTE: This is a DRY RUN — no resources will be created or modified.

Resource and property changes are indicated with these symbols:
  + Create
  ~ Modify
  - Delete

The deployment will make the following changes:

  Scope: /subscriptions/xxxxxxxx-...

  + Microsoft.Resources/resourceGroups/rg-squad-aca-dev-a1b2c3d4
  ...

==================================================================
 What-if complete — review the diff above before deploying.
==================================================================
```

---

## Layer 2: manual ephemeral deploy loop

### Running smoke tests after a provision

If you've already run `azd provision` or `azd up`, run the smoke test directly against the azd
environment. It auto-discovers all resource names from the azd outputs:

#### Bash

```bash
./infra/tests/smoke-test.sh --azd-env dev
```

#### PowerShell

```powershell
.\infra\tests\smoke-test.ps1 -AzdEnv dev
```

### Running the full e2e loop (provision → test → teardown)

The e2e scripts run the complete loop. They require the `--deploy` flag (bash) or `-Deploy` switch
(PowerShell) to prevent accidental deploys.

> ⚠️ **Cost warning:** This provisions real Azure resources. The teardown step always runs — even
> if smoke tests fail — to avoid orphaned resources and ongoing charges. You are responsible for any
> charges incurred during the run.

#### Bash

```bash
# Dry-run first (no deploy):
./infra/tests/e2e.sh --env ephemeral-test \
  --subscription xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --github-app-id 123456 \
  --github-installation-id 789012 \
  --deployer-principal-id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Full loop (REAL DEPLOY — adds --deploy):
./infra/tests/e2e.sh --deploy \
  --env ephemeral-test \
  --subscription xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --github-app-id 123456 \
  --github-installation-id 789012 \
  --deployer-principal-id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Full loop + job execution test (OPT-IN, costs a run):
./infra/tests/e2e.sh --deploy --run-job \
  --env ephemeral-test \
  --subscription xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --github-app-id 123456 \
  --github-installation-id 789012 \
  --deployer-principal-id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

#### PowerShell

```powershell
# Dry-run first (no deploy):
.\infra\tests\e2e.ps1 `
  -Env ephemeral-test `
  -Subscription 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' `
  -GithubAppId '123456' `
  -GithubInstallationId '789012' `
  -DeployerPrincipalId 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

# Full loop (REAL DEPLOY — adds -Deploy):
.\infra\tests\e2e.ps1 -Deploy `
  -Env ephemeral-test `
  -Subscription 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' `
  -GithubAppId '123456' `
  -GithubInstallationId '789012' `
  -DeployerPrincipalId 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

# Full loop + job execution test (OPT-IN, costs a run):
.\infra\tests\e2e.ps1 -Deploy -RunJob `
  -Env ephemeral-test `
  -Subscription 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' `
  -GithubAppId '123456' `
  -GithubInstallationId '789012' `
  -DeployerPrincipalId 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
```

### Running smoke tests in manual mode (no azd)

You can run the smoke test with explicit resource names if you don't have azd installed or prefer
direct control:

#### Bash

```bash
./infra/tests/smoke-test.sh \
  --resource-group rg-squad-aca-dev-a1b2c3d4 \
  --storage-account stSquadacaa1b2c3d4 \
  --queue-name squad-work-queue \
  --acr crSquadacaa1b2c3d4 \
  --log-analytics law-squad-aca-dev-a1b2c3d4 \
  --key-vault kv-squad-a1b2c3d4 \
  --aca-env cae-squad-aca-dev-a1b2c3d4 \
  --job job-squad-agent-a1b2c3d4 \
  --identity id-squad-agent-a1b2c3d4 \
  --uami-resource-id /subscriptions/xxx/resourceGroups/rg-.../providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-squad-agent-a1b2c3d4
```

#### PowerShell

```powershell
.\infra\tests\smoke-test.ps1 `
  -ResourceGroup  'rg-squad-aca-dev-a1b2c3d4' `
  -StorageAccount 'stSquadacaa1b2c3d4' `
  -QueueName      'squad-work-queue' `
  -AcrName        'crSquadacaa1b2c3d4' `
  -LogAnalytics   'law-squad-aca-dev-a1b2c3d4' `
  -KeyVault       'kv-squad-a1b2c3d4' `
  -AcaEnv         'cae-squad-aca-dev-a1b2c3d4' `
  -JobName        'job-squad-agent-a1b2c3d4' `
  -IdentityName   'id-squad-agent-a1b2c3d4' `
  -UamiResourceId '/subscriptions/xxx/resourceGroups/.../providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-squad-agent-a1b2c3d4'
```

### Expected smoke test output

```
==================================================================
 Squad on ACA — Smoke Test Suite
==================================================================

  Resource group  : rg-squad-aca-dev-a1b2c3d4
  ...

--- 1. Resource group ---
  [PASS] Resource group 'rg-squad-aca-dev-a1b2c3d4' exists (provisioningState: Succeeded)

--- 2. Log Analytics workspace ---
  [PASS] Log Analytics workspace 'law-squad-aca-dev-a1b2c3d4' — provisioningState: Succeeded

--- 3. Storage account and queue ---
  [PASS] Storage account 'stSquadacaa1b2c3d4' — provisioningState: Succeeded
  [PASS] Storage account shared key access is disabled (identity-auth enforced)
  [PASS] Storage queue 'squad-work-queue' exists

--- 4. Container Registry and image ---
  [PASS] Container Registry 'crSquadacaa1b2c3d4' — provisioningState: Succeeded
  [PASS] ACR image 'squad-agent:latest' is present in registry

--- 5. User-Assigned Managed Identity and role assignments ---
  [PASS] UAMI 'id-squad-agent-a1b2c3d4' exists
  [PASS] UAMI → Storage Queue Data Reader on storage account
  [PASS] UAMI → Storage Queue Data Contributor on storage account
  [PASS] UAMI → AcrPull on container registry
  [PASS] UAMI → AcrPush on container registry
  [PASS] UAMI → Key Vault Secrets User on key vault

--- 6. Key Vault and secrets ---
  [PASS] Key Vault 'kv-squad-a1b2c3d4' — provisioningState: Succeeded
  [PASS] Key Vault RBAC authorization is enabled
  [PASS] Key Vault secret 'github-app-private-key' exists (value not displayed)
  [PASS] Key Vault secret 'copilot-pat' exists (value not displayed)

--- 7. Container Apps environment and job ---
  [PASS] Container Apps environment 'cae-squad-aca-dev-a1b2c3d4' — provisioningState: Succeeded
  [PASS] Container App Job 'job-squad-agent-a1b2c3d4' — provisioningState: Succeeded
  [PASS] Container App Job trigger type is 'Event' (KEDA event-driven)
  [PASS] KEDA azure-queue scaler identity matches UAMI resource ID
  [PASS] Container App Job ACR registry pull uses identity (not admin credentials)

==================================================================
 Smoke test: ALL 16 assertions PASSED
==================================================================
```

---

## Assertions explained

The smoke test makes the following assertions against each deployed resource:

| Resource | What is asserted |
|----------|-----------------|
| Resource group | Exists, `provisioningState: Succeeded` |
| Log Analytics workspace | Present in RG, `provisioningState: Succeeded` |
| Storage account | Present, `provisioningState: Succeeded`, `allowSharedKeyAccess: false` |
| Storage queue | Queue named `squad-work-queue` (or custom) exists |
| Container Registry | Present, `provisioningState: Succeeded` |
| ACR image | `squad-agent:latest` tag present (pushed by postprovision hook) |
| UAMI | Present; resource ID matches azd output |
| UAMI → Storage | `Storage Queue Data Reader` role assigned |
| UAMI → Storage | `Storage Queue Data Contributor` role assigned |
| UAMI → ACR | `AcrPull` role assigned |
| UAMI → ACR | `AcrPush` role assigned |
| UAMI → Key Vault | `Key Vault Secrets User` role assigned |
| Key Vault | Present, `provisioningState: Succeeded`, RBAC authorization enabled |
| KV secret: `github-app-private-key` | Exists (value never printed) |
| KV secret: `copilot-pat` | Exists (value never printed) |
| ACA environment | Present, `provisioningState: Succeeded` |
| Container App Job | Present, `provisioningState: Succeeded`, trigger type `Event` |
| KEDA scaler identity | `identity` field on `queue-scaling` rule matches UAMI resource ID |
| ACR pull identity | Registry pull uses identity, not admin credentials |

### Optional: job execution test

Pass `--run-job` (bash) or `-RunJob` (PowerShell) to trigger one job execution and assert it reaches
`Succeeded` or `Running` within `--job-timeout` seconds (default: 120). This is **opt-in** because it:

- Consumes a Container App Job execution.
- Requires the postprovision hook to have already pushed `squad-agent:latest`.
- May fail if Key Vault secrets (`github-app-private-key`, `copilot-pat`) are not uploaded.

---

## Resource naming reference

The Bicep modules derive resource names from `projectName`, `environment`, and an auto-computed
8-character `nameSuffix`. With the defaults (`projectName=squad-aca`, `environment=dev`):

| Resource | Name pattern | Example |
|----------|-------------|---------|
| Resource group | `rg-{project}-{env}-{suffix}` | `rg-squad-aca-dev-a1b2c3d4` |
| Log Analytics | `law-{project}-{env}-{suffix}` | `law-squad-aca-dev-a1b2c3d4` |
| Storage account | `st{project-no-hyphens}{suffix}` | `stSquadacaa1b2c3d4` |
| Container Registry | `cr{project-no-hyphens}{suffix}` | `crSquadacaa1b2c3d4` |
| ACA Environment | `cae-{project}-{env}-{suffix}` | `cae-squad-aca-dev-a1b2c3d4` |
| UAMI | `id-squad-agent-{suffix}` | `id-squad-agent-a1b2c3d4` |
| Key Vault | `kv-squad-{suffix}` | `kv-squad-a1b2c3d4` |
| Container App Job | `job-squad-agent-{suffix}` | `job-squad-agent-a1b2c3d4` |

The `nameSuffix` is `substring(uniqueString(subscriptionId, projectName, environment), 0, 8)` — it
stays stable across redeployments to the same subscription/project/environment combination.

---

## Cost and cleanup notes

- **What-if**: free — no Azure resources are created.
- **Provision + teardown**: you pay for the resources during the run. A typical ephemeral test takes
  5–10 minutes to provision and 2–3 minutes to tear down. At `swedencentral` pricing, the stack
  (Basic ACR, Standard_LRS storage, Container App Job, Log Analytics, Key Vault) costs less than
  USD 0.10 for a 30-minute test window.
- **Teardown**: `azd down --purge` is the default. `--purge` immediately purges the Key Vault
  (which uses soft-delete) so the name is immediately available for reuse. Remove `--no-purge` if
  you want soft-delete retention.
- **Orphaned resources**: if the e2e script is interrupted before teardown, run:
  ```bash
  azd down --environment <env-name> --force --purge
  ```
- **Key Vault name collision**: if you reuse an environment name, the Key Vault name is stable
  (derived from the suffix). Soft-deleted vaults with the same name block re-creation — use
  `--purge` or run `az keyvault purge --name <kv-name>`.

---

## Troubleshooting

### What-if fails with "DeploymentFailed"

The what-if command contacts the ARM API and validates the template. Common causes:

- **Missing required parameters** — ensure `--github-app-id`, `--github-installation-id`, and
  `--deployer-principal-id` are set to non-placeholder values.
- **Subscription policy blocks** — some subscriptions block Container App Jobs or require specific
  SKUs. Check the error message for policy names.
- **Invalid `nameSuffix`** — must be 8 lowercase alphanumeric characters. Let it auto-derive unless
  you have a specific reason to override.

### Smoke test: "ACR image not found"

The `squad-agent:latest` image is pushed by the postprovision hook (`infra/hooks/postprovision.*`),
not by Bicep. If the image assertion fails:

1. Check that `azd provision` completed successfully (the hook runs after provision).
2. Run the hook manually: `az acr build --registry <acr-name> --image squad-agent:latest --file agents/base/Dockerfile agents/base/`

### Smoke test: "Key Vault secret not found"

Secret values are never stored in Bicep — they must be uploaded manually after provision:

```bash
az keyvault secret set --vault-name <kv-name> \
  --name github-app-private-key \
  --file /path/to/your-app.private-key.pem

az keyvault secret set --vault-name <kv-name> \
  --name copilot-pat \
  --value "$COPILOT_PAT_VALUE"
```

> **Policy-constrained subscriptions**: If your subscription enforces `publicNetworkAccess: Disabled`
> on Key Vaults, secret upload via `az keyvault secret set` requires public access to be permitted.
> All resources deployed by this IaC carry the tag `SecurityControl=ignore`, which exempts them from
> such subscription policies and keeps `publicNetworkAccess: Enabled` on the Key Vault. If upload
> still fails, verify the tag is present on the Key Vault and that your subscription's policy
> definition honours this exemption tag.

### Smoke test: role assignment not found

RBAC propagation can take 1–2 minutes after provision. Wait and re-run the smoke test. If the
assignment is still missing, check the UAMI principal ID:

```bash
az identity show --name <identity-name> --resource-group <rg-name> --query principalId -o tsv
az role assignment list --assignee <principal-id> --all --query "[].{role:roleDefinitionName,scope:scope}" -o table
```

### Job execution test fails

The `--run-job` test starts a real job execution. If it fails:

```bash
az containerapp job logs show \
  --name <job-name> \
  --resource-group <rg-name> \
  --format text
```

Missing Key Vault secrets are the most common cause. Upload them (see above) and retry.

### azd down fails after test

If teardown fails or was interrupted:

```bash
azd down --environment <env-name> --force --purge
```

If the resource group still exists after `azd down`:

```bash
az group delete --name <rg-name> --yes --no-wait
```

---

## Related documentation

- [Adoption guide](adoption-guide.md) — full deployment instructions for both Terraform and azd/Bicep paths.
- [Infrastructure reference](infrastructure.md) — Bicep modules, resource naming, and architectural decisions.
- [Troubleshooting](troubleshooting.md) — general troubleshooting for the Squad on ACA platform.
