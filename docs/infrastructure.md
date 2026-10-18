# Infrastructure

> Infrastructure modules, key architectural decisions, and infrastructure details for Squad on ACA.

---

## Deployment paths

Squad on ACA has two infrastructure-as-code paths:

- `infra/terraform/` — canonical and default. Use this path when you want Terraform workflows and explicit plan/apply behavior.
- `infra/bicep/` — Azure-native alternative for `azd provision`, `azd deploy`, and `azd up`.

Both paths create equivalent Azure resources. See [Terraform vs Bicep and azd: which should you choose?](adoption-guide.md#terraform-vs-bicep-and-azd-which-should-you-choose) for state, teardown, GitHub variable, and provider tradeoffs.

---

## Choose the execution backend

Both roots accept exactly `jobs` or `sandbox`. Omit the selector to keep Jobs.
Use one IaC tool per deployment. A backend switch means provisioning a separate
destination, not changing an existing installation in place.

Terraform example for a new Sandbox destination:

```hcl
execution_backend = "sandbox"
sandbox_image_ref = "registry.example/worker@sha256:<64 lowercase hex characters>"
```

For azd, set these before `azd provision`:

```text
azd env set SQUAD_EXECUTION_BACKEND sandbox
azd env set SQUAD_SANDBOX_IMAGE_REF registry.example/worker@sha256:<64 lowercase hex characters>
```

The azd parameter mapping is `infra/bicep/main.parameters.json`. Direct Bicep
uses `executionBackend`, `sandboxImageRef`, and `jobsImageRef`. The example
`main.bicepparam` remains available for direct ARM deployments.

Both choices share the resource group, registry, and monitoring. Sandbox
creates a Sandbox Group, a dispatcher identity with group-scoped Data Owner,
a separate registry pull identity with AcrPull, and exact protected-environment
OIDC subjects. It creates no Job, managed environment, work queue, Job identity,
or Jobs Key Vault. Sandbox hooks skip Jobs image builds, PAT/Key Vault checks,
and legacy queue variable writes. Supply an already published immutable worker
image. No hook activates repository execution or configures environment
protections. The trusted publisher and its secrets remain administrator-owned.

Terraform exports `platform_descriptor`; Bicep exports `platformDescriptor`.
Both use the non-secret [backend/v1 schema](../contracts/backend/v1/schemas/platform-descriptor.schema.json)
and include only the selected backend. Set `release_version` in Terraform or
`SQUAD_RELEASE_VERSION` in azd to the installed release (default `0.0.1`).
Limits use the positive concurrency and timeout inputs; downstream onboarding
must enforce those limits before dispatch.

For existing Jobs installations, leaving the selector and image inputs unset
preserves the existing image and resource settings. Terraform `moved` blocks
preserve the singleton resource identities when adding conditional instances.
Review a no-change plan or Bicep what-if before adopting these sources. No
live migration or deployment is performed by local tests.

The descriptor is deliberately **null** until the selected image is pinned to
`@sha256:<64 lowercase hex characters>`. It never advertises `latest` as an
immutable onboarding image. To opt into a Jobs descriptor, set `jobs_image_ref`
in Terraform or `SQUAD_JOBS_IMAGE_REF` in azd. This explicit choice also pins the
Job image, and azd then skips the legacy build/update-to-latest step. azd hooks
reject invalid pins; direct Bicep with an invalid pin produces no descriptor.
An absent or null descriptor is not a ready onboarding destination.

The old Terraform `enable_aca_sandbox=true` remains an additive Jobs plus
Sandbox inventory with its original resources. It emits no onboarding
descriptor. Combining it with `execution_backend="sandbox"` is rejected. Drain
and preserve mixed or Jobs installations until an explicit retirement is
approved, including their queues, state storage, secrets, and open revisions.

The Sandbox Group and identity attachment mirror the existing verified lab
model. Bicep's public schema catalog does not yet model the identity property;
a local type-warning suppression is limited to that property. Disk image
creation, runtime dispatch, image publication, publisher provisioning, and
repository activation are separate operations, not claims of this bootstrap.

Local validation:

```text
node --test contracts\backend\v1\test\contracts.test.cjs infra\tests\backend-selector.test.cjs
terraform -chdir=infra\terraform init -backend=false
terraform -chdir=infra\terraform fmt -check -recursive
terraform -chdir=infra\terraform validate
terraform -chdir=infra\terraform test -filter=tests\backend.tftest.hcl
az bicep build --file infra\bicep\main.bicep
```

Terraform tests override resources and modules and use synthetic inputs. They
make no Azure or GitHub calls. Run Bicep build with a process-local
`AZURE_CONFIG_DIR`; no login or deployment is needed.

---

## Terraform Modules

Squad on ACA uses Microsoft's Azure Verified Modules (AVM) for infrastructure consistency:

| Module | Purpose | Notes |
|--------|---------|-------|
| `azure/avm-res-operationalinsights-workspace` | Log Analytics (required by ACA environment) | Telemetry disabled for cost |
| `azure/avm-res-storage-storageaccount` | Storage account + queues | RBAC-based auth, no shared keys |
| `azure/avm-res-containerregistry-registry` | Container Registry (Basic) | Hosts `squad-agent:latest` image |
| `azure/avm-res-app-managedenvironment` | ACA Managed Environment | Provides KEDA, Log Analytics integration |
| `azapi_resource` (Container App Job) | Generic squad agent job | Custom `azapi_resource` due to identity-based KEDA auth not in AVM |
| `azapi_resource` (ACA Sandbox Group) | Optional Sandbox security boundary | Selected by `execution_backend = "sandbox"`; legacy additive flag remains supported |

---

## Bicep modules

The Bicep path starts at `infra/bicep/main.bicep` and uses modules under `infra/bicep/modules/` for monitoring, storage, Azure Container Registry, identity, Key Vault, and the Container App Job. It is designed for deployment through Azure Developer CLI while preserving parity with the Terraform path.

---

## Key Decisions

These decisions are also captured in `.squad/decisions.md`:

- **Single Generic Job**: One Container App Job handles all legacy queue routing values. Adding dynamic Sandbox members does not require infrastructure changes because member identity is resolved from the Squad roster at dispatch time.
- **UAMI for Scaling**: KEDA uses Managed Identity for auth (no connection strings). Storage account blocks shared keys per subscription policy.
- **Container Self-Dequeue**: Each container manages its own queue interaction (dequeue, delete). Enables dedup checks and failsafe behavior.
- **Dual Auth Pattern**: App token for git/PR ops, Copilot PAT for `copilot --yolo`. Both stored in Key Vault, swapped at runtime.
- **Graceful Fallback**: If Copilot fails, work artifact is created so PR still gets made.
- **Sandbox Dispatcher Boundary**: ACA Sandbox infrastructure is off by default. When enabled, the sandbox dispatcher uses a dedicated managed identity with SandboxGroup data-plane access only.

---

## Legacy additive ACA Sandbox infrastructure

This section describes only the legacy additive flag. New Sandbox-only
deployments use the selector above. Terraform retains `enable_aca_sandbox`
for existing mixed inventory.
The default is `false`. With the flag off, Terraform creates no sandbox
resources, no sandbox identity, and no sandbox RBAC assignments. Existing ACA
Job resources and outputs are unchanged.

When `enable_aca_sandbox = true`, Terraform creates:

- `Microsoft.App/sandboxGroups@2026-07-01` with `azapi_resource`.
- A dedicated user-assigned managed identity named `id-sandbox-dispatcher-*`.
- One role assignment: `Container Apps SandboxGroup Data Owner` for the
  dispatcher identity at the Sandbox Group scope.

Sandbox Group location defaults to `var.location`. Set
`sandbox_group_location` only when the group must be regionalized separately.
The dispatcher receives these per-sandbox defaults as outputs for future runtime
creation calls:

| Variable | Default | Purpose |
|----------|---------|---------|
| `sandbox_default_cpu` | `"1000m"` | CPU to request per sandbox |
| `sandbox_default_memory` | `"2048Mi"` | Memory to request per sandbox |
| `sandbox_default_auto_suspend_seconds` | `300` | Auto-suspend timeout per sandbox |

These defaults are not Sandbox Group properties. They are dispatcher inputs for
future sandbox create calls.

Persona sandboxes do not receive managed identities or RBAC. They get
no Key Vault access, no ACR push, no queue access, and no GitHub write access.
The legacy shared `squad_agent` identity remains unchanged for the existing ACA
Job path. Splitting that legacy identity is deferred to a later hardening PR.
The legacy additive flag does not attach an image-pull identity or grant an
ACR role. The new Sandbox selector uses the separate image-pull identity model
from the verified lab root.

The persona worker image lives under `agents/sandbox/` and is built separately
from the legacy `agents/base/` ACA Job image. It uses the same Debian base image
family and Copilot CLI installation style, but it does not install Azure CLI,
GitHub CLI, Key Vault helpers, queue helpers, GitHub App authentication, or
publication tooling. The trusted host dispatcher creates sandboxes and passes
a pre-staged repository path, dispatch envelope, output directory, and Copilot
credential to the persona worker. Image publication and disk image creation
remain separate runtime/bootstrap operations.

Build the persona worker from the repository root:

```bash
docker build -f agents/sandbox/Dockerfile -t squad-persona-sandbox:local .
```

`agents/sandbox/Dockerfile.dockerignore` is the allowlist for this root build
context. It includes only `agents/sandbox/**` and the specific ACA sandbox
contract runtime dependency copied into `/opt/squad/contracts/aca-sandbox/v1/`.
This avoids sending `.git`, `.squad`, `infra`, secrets, or unrelated source to
the Docker daemon. The old `docker build agents/sandbox` form is intentionally
not supported because the runner depends on contract tooling outside that
directory.

CI uses the same root context and the corresponding pinned public Debian and
Golang base image tags instead of the private ACR mirror. It does not log in to
Azure, push an image, or use deployment credentials. Normal image builds still
default to the configured ACR mirror.

The runner stages artifacts outside `SQUAD_OUTPUT_DIR`, starts Copilot with a
minimal explicit environment, and withholds runner path variables from the
persona process. It requires the output directory to be empty before execution
and checks it again before publish. If any persona process writes directly to
the output directory, the runner deletes those files and publishes only a
minimal `output_tampered` failure. True filesystem separation still requires PR 5
dispatcher hardening: run Copilot under a different UID or attach the output
mount only after Copilot exits, then collect artifacts with dispatcher-side exec.

## Manual Sandbox rollout

The existing `agents/workflows/squad-queue.yml` is the legacy ACA Job template.
It continues to emit provider-less messages, which always resolve to `aca-job`.
The `aca-sandbox` entrypoint remains a loud rejection before queue acknowledgement.
The issue-driven Sandbox workflow is a separate opt-in path. It does not
change the legacy queue message contract or route legacy messages to the
Sandbox provider. See [Opt-in ACA Sandbox issue flow](sandbox-issue-flow.md) for
its prerequisites and setup.

Use `.github/workflows/squad-sandbox-manual.yml` only for deliberate manual
testing. Its default is fake mode, which exercises dispatcher fan-out and
integration with a deterministic smoke Copilot stub and no Azure or GitHub
write credentials.
The input plan path must be relative to the checked-out repository, contain no
symlink component, pass the v1 schema, and bind to the current commit. Use
`$CHECKED_OUT_SHA` in a committed plan for top-level and task baseline fields;
preflight substitutes the exact checkout SHA into the validated temporary copy.
A mismatched literal SHA fails before authentication.

Live sandbox testing requires the separate live input, a protected
`squad-sandbox-dispatch` environment, Azure OIDC variables for the dedicated
dispatcher UAMI, a fine-grained Copilot token, and a dedicated Linux runner
labeled `squad-aca-cli` with a trusted pre-installed `aca` executable. The UAMI
needs only `Container Apps SandboxGroup Data Owner` at the Sandbox Group scope.
The runner requires outbound access for GitHub Actions Azure OIDC and the
configured ACA endpoint. The workflow adds no network route. Missing group,
identity, CLI, token, or unverified-client acknowledgement fails before Azure
login.

Publication requires a second opt-in and a protected `squad-publish`
environment with required reviewers. The GitHub App installation is scoped to
the target repository and needs `contents: write`, `pull_requests: write`, and
`issues: write`. Key Vault PEM retrieval is not implemented in this workflow.
Until then, an administrator must manually stage the PEM as
`SQUAD_GITHUB_APP_PRIVATE_KEY_PEM` in the protected environment. It is validated
and written to a mode-600 temporary file only in the publisher job, after the
dispatcher and integration summary passes, then deleted on exit. No App key or
GitHub write token enters persona or integration execution.

The manual Sandbox workflow remains a controlled test path until a real
Sandbox Group verifies ACA CLI create/exec flags and output, stdin forwarding or
supported file transfer, sandbox deletion and timeout behavior, and ACR
authentication. The explicit `SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT=1` setting
permits only a manually approved probe. It does not mark those contracts
verified. The separate issue flow remains disabled by default and requires its
own repository opt-in and protected environments.

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

## Autoscaling: KEDA queue-based scaling

The Container App Job uses [KEDA](https://keda.sh/) with the `azure-queue` scaler to drive executions
from zero. Understanding how each configuration parameter affects runtime behavior is essential for
capacity planning and troubleshooting.

### How it works

1. **KEDA polls** the Storage Queue every `pollingInterval` seconds (30 s by default).
2. When the **queue depth ≥ `queueLength`** (threshold = 1 message), KEDA schedules new job
   executions up to `maxExecutions`.
3. Each execution is an independent container replica that runs to completion (or timeout) and exits.
4. When the queue is empty, KEDA scales to `minExecutions` (0) — no idle resources and no cost.

### Configuration parameters

| Parameter | Terraform default | Bicep default | Meaning |
|-----------|:-----------------:|:-------------:|---------|
| `triggerType` | `Event` | `Event` | Event-driven (KEDA) execution model |
| `scale.minExecutions` | `0` | `0` | Scale-to-zero when queue is empty |
| `scale.maxExecutions` | `10` | `10` | Maximum concurrent job executions |
| `scale.pollingInterval` | `30` | `30` | Seconds between KEDA queue depth checks |
| `scale.rules[].metadata.queueLength` | `"1"` | `"1"` | One message = one execution trigger |
| `eventTriggerConfig.parallelism` | `1` | `1` | Executions launched per polling cycle |
| `eventTriggerConfig.replicaCompletionCount` | `1` | `1` | Replicas that must complete for a "success" |
| `configuration.replicaTimeout` | `1800` s (30 min) | `1800` s (30 min) | Maximum runtime per execution before forced kill |
| `configuration.replicaRetryLimit` | `0` | `0` | No automatic retry on failure |

> **queueLength = "1" explained**: A threshold of 1 means each message in the queue counts as one
> unit of demand. With `maxExecutions: 10`, KEDA can run up to 10 executions in parallel — one per
> queued message — until the queue is drained. The Container App itself dequeues exactly one message
> at startup (`entrypoint.sh`), so one execution = one work item.

> **parallelism = 1 explained**: KEDA introduces at most one new execution per polling cycle.
> Combined with `pollingInterval: 30`, new executions ramp up one-at-a-time every 30 seconds until
> `maxExecutions` is reached. This avoids thundering-herd job creation against downstream APIs.

### Identity model

All queue interactions — KEDA scaler and runtime container — use the **User-Assigned Managed
Identity (UAMI) resource ID** (not the client ID) for authentication:

| Consumer | Auth field | Value |
|----------|-----------|-------|
| KEDA `azure-queue` scaler | `scale.rules[].identity` | UAMI resource ID (`/subscriptions/.../userAssignedIdentities/...`) |
| Container registry pull | `configuration.registries[].identity` | UAMI resource ID |
| Container runtime | `AZURE_CLIENT_ID` env var | UAMI client ID (for `az login --identity`) |

The UAMI holds two RBAC roles on the Storage Account:
- **Storage Queue Data Reader** — KEDA reads queue depth without dequeuing.
- **Storage Queue Data Contributor** — Container dequeues and deletes messages at runtime.

No shared keys or connection strings are used. `shared_access_key_enabled = false` is enforced
by subscription policy.

### Scaling parity: Terraform ↔ Bicep (verified 2026-07-31)

The following table covers every scaling and execution-relevant field. Both paths produce identical
ARM properties. Terraform is canonical; Bicep must match it. This audit confirmed full parity.

| Field | Terraform | Bicep | Status |
|-------|-----------|-------|--------|
| API version | `Microsoft.App/jobs@2025-01-01` | `Microsoft.App/jobs@2025-01-01` | ✅ MATCH |
| `triggerType` | `"Event"` | `'Event'` | ✅ MATCH |
| `replicaTimeout` | `1800` (default) | `1800` (default) | ✅ MATCH |
| `replicaRetryLimit` | `0` | `0` | ✅ MATCH |
| `secrets` | `[]` | `[]` | ✅ MATCH |
| Registry `server` | ACR login server | ACR login server | ✅ MATCH |
| Registry `identity` | UAMI resource ID | UAMI resource ID | ✅ MATCH |
| `parallelism` | `1` | `1` | ✅ MATCH |
| `replicaCompletionCount` | `1` | `1` | ✅ MATCH |
| `scale.minExecutions` | `0` | `0` | ✅ MATCH |
| `scale.maxExecutions` | `10` (default) | `10` (default) | ✅ MATCH |
| `scale.pollingInterval` | `30` | `30` | ✅ MATCH |
| Rule `name` | `"queue-scaling"` | `'queue-scaling'` | ✅ MATCH |
| Rule `type` | `"azure-queue"` | `'azure-queue'` | ✅ MATCH |
| `metadata.queueName` | `"squad-work-queue"` (default) | `"squad-work-queue"` (default) | ✅ MATCH |
| `metadata.queueLength` | `"1"` | `"1"` | ✅ MATCH |
| `metadata.accountName` | `local.storage_account_name` | `storageAccountName` | ✅ MATCH |
| Scale rule `identity` | UAMI resource ID | UAMI resource ID | ✅ MATCH |
| Scale rule `auth` | (not set — implicit empty) | `[]` (explicit empty) | ✅ MATCH (functionally identical) |
| Container name | `"squad-agent"` | `'squad-agent'` | ✅ MATCH |
| CPU | `1.0` (default) | `json('1.0')` = 1.0 (default) | ✅ MATCH |
| Memory | `"2Gi"` (default) | `'2Gi'` (default) | ✅ MATCH |
| Identity type | `UserAssigned` | `UserAssigned` | ✅ MATCH |
| All `env` vars | 9 env vars | 9 env vars (identical names/values) | ✅ MATCH |
| **Container image** | ACR image (always) | Placeholder default; real image set by postprovision hook | ⚠️ DESIGN DIFF (intentional) |

The container image difference is an **intentional design difference** to solve the chicken-and-egg
bootstrap problem: ARM validates image reachability at provision time, but the ACR image doesn't
exist until after provision. Bicep defaults to a public MCR placeholder; the `postprovision` hook
builds and pushes `squad-agent:latest` to ACR, then updates the job to use the real image. This
does not affect scaling behavior in any way — all executions after postprovision use the correct image.

No fixes were required. Bicep already matches Terraform on all scaling-relevant fields.

### Validation status

| Validation method | Status |
|-------------------|--------|
| Field-by-field parity with canonical Terraform | ✅ Verified (2026-07-31, issue #9) |
| `az bicep build` clean compile | ✅ Verified (2026-07-31) |
| `azd provision` + smoke test (all assertions passed) | ✅ Verified (2026-07-31 live e2e run) |
| Live queue-based scale event (real messages → observed executions) | ❌ Not performed in issue #9 |

A live queue-based scale test was not performed as part of issue #9. The queue-based autoscaling is
fully declarative: if the Bicep configuration matches the working Terraform (which it does, as shown
above), the scaling behavior will be identical. The configuration was validated by parity audit and
successful deployment health checks.

### How to run a live scale test

To observe KEDA scaling from queue messages to job executions:

**Option A — Single execution (smoke test `--run-job`)**

Use the e2e test suite's opt-in job execution test. This triggers one execution via
`az containerapp job start` and asserts it reaches `Succeeded` or `Running`:

```bash
./infra/tests/e2e.sh --deploy --run-job \
  --env ephemeral-test \
  --subscription <subscription-id> \
  --github-app-id <app-id> \
  --github-installation-id <install-id> \
  --deployer-principal-id <principal-id>
```

**Option B — Full queue-driven scale test (manual)**

1. Upload real secrets to Key Vault (`github-app-private-key` and `copilot-pat`).
2. Seed N messages into the queue (replace `<account>`, `<queue>`, and `<message>`):

   ```bash
   for i in $(seq 1 5); do
     az storage message put \
       --account-name <account> \
       --queue-name <queue> \
       --content "$(echo '{"issue_number":'$i',"agent_type":"test-agent","repo":"owner/repo","title":"Test '$i'"}' | base64)" \
       --auth-mode login
   done
   ```

3. Within 30 seconds (one polling interval), KEDA detects the queue depth and launches executions.
4. Observe executions scaling toward `maxExecutions`:

   ```bash
   watch -n 10 'az containerapp job execution list \
     --name <job-name> --resource-group <rg-name> \
     --query "[].{name:name,status:properties.status}" -o table'
   ```

5. View logs for a specific execution:

   ```bash
   az containerapp job logs show \
     --name <job-name> --resource-group <rg-name> \
     --execution <execution-name> --format text
   ```

---

## Component Overview

### Azure Container App Job
- **Event-driven**: Triggered by KEDA when a message appears in the queue
- **Ephemeral**: Runs on-demand, no idle resources
- **Identity-based auth**: Uses User-Assigned Managed Identity (UAMI) for all Azure API calls—zero shared keys
- **Scaling**: 0 to N parallel executions (configurable, default 10)
- **Timeout**: Configurable per-job (default 30 minutes)

### Azure Storage Queue
- **Message broker**: GitHub Actions enqueues work, container dequeues
- **Message format**: Base64-encoded JSON
  ```json
  {
    "issue_number": 42,
    "agent_type": "example-legacy-routing-key",
    "repo": "owner/repo",
    "title": "Issue title"
  }
  ```
  > **Compatibility note**: `agent_type` is extracted from the label for the legacy ACA Job path. It remains an opaque routing value. Dynamic Sandbox contracts use logical member ID, resolved persistent name, charter reference, and roster snapshot instead.
- **TTL**: 24 hours per message
- **Auth**: Identity-based (UAMI), no shared keys

### GitHub Actions Workflow (`squad-queue.yml`)
- **Trigger**: Issue labeled `squad:*`. The current workflow remains the legacy ACA Job path; dynamic Sandbox dispatch uses the roster snapshot contract.
- **Steps**:
  1. Dedup check (skip if `squad:processing` label already set)
  2. OIDC login to Azure (federated credentials, zero secrets)
  3. Add `squad:processing` label to prevent duplicate processing
  4. Extract the legacy routing value from the label name
  5. Enqueue message to Storage Queue with identity-based auth
- **Permissions**: `id-token: write`, `issues: write`, `contents: read`

### GitHub App (`squad-aca-bot[bot]`)
- **Purpose**: Bot identity for all PR operations (create, comment)
- **Private key**: Stored in Azure Key Vault, never written to disk
- **Auth flow**:
  1. Container retrieves PEM from Key Vault
  2. Generate JWT (10-minute expiry)
  3. Exchange JWT for installation access token (1-hour expiry)
  4. Use token for git push, PR creation, label management
- **One app per environment**: Simplifies permission model

### Azure Key Vault
- **Secrets stored**:
  - `github-app-private-key`: GitHub App PEM (uploaded manually via `az keyvault secret set`)
  - `copilot-pat`: Copilot-licensed GitHub PAT (uploaded manually)
- **Access**: RBAC-based, no access policies
- **UAMI permissions**: Key Vault Secrets User (read-only at runtime)
- **Network access**: Public network access is enabled. The `SecurityControl=ignore` tag is **not
  applied by default**. When running e2e against a policy-restricted tenant,
  add it manually via the tags parameter override at deploy time — for example:
  `--parameters tags='{"project":"squad-on-aca","managed_by":"bicep","SecurityControl":"ignore"}'`
  (Bicep) or `-var 'tags={"project":"squad-on-aca","managed_by":"terraform","SecurityControl":"ignore"}'`
  (Terraform). Normal production deployments must NOT include this tag.

### Dual Auth Pattern
GitHub Apps cannot hold Copilot licenses. Squad on ACA uses a dual-token approach:
- **App token** (from GitHub App installation): git push, PR creation, issue operations
- **Copilot PAT** (from a Copilot-licensed user): `copilot --yolo` CLI invocation only
- Both are stored in Key Vault; the container swaps them as needed during execution

### Container Image
- **Base**: `debian:bookworm-slim` (minimal runtime)
- **Tooling**:
  - `gh` CLI (GitHub operations)
  - `git` (repository cloning, commits)
  - `@github/copilot` CLI (AI coding)
  - `az` CLI + Python (Azure authentication)
  - `jq` (JSON parsing)
  - `openssl` (JWT generation)
- **Entrypoint**: `entrypoint.sh` sources runtime modules and dispatches to a provider

### Container Entrypoint (`agents/base/entrypoint.sh`)
The entrypoint remains the container `ENTRYPOINT`, but most behavior lives in
sourced shell modules:

- `agents/base/lib/`: logging, env validation, Azure auth, queue parsing and
  acknowledgement, Key Vault reads, GitHub App auth, Copilot token swapping,
  repo helpers, publication helpers, and the legacy new/revision flows.
- `agents/base/providers/`: provider dispatch. Missing provider metadata
  always defaults to `aca-job` for legacy queue compatibility; environment
  variables do not reroute legacy messages. Unsupported providers, including the
  current `aca-sandbox` stub, fail before queue acknowledgement so the message is
  not lost.

The existing `aca-job` provider lifecycle is unchanged:
1. **MI login**: `az login --identity --client-id`
2. **Dequeue**: Read one message from Storage Queue
3. **Decode + provider validation**: Decode message and resolve provider; reject unsupported providers before acknowledgement
4. **Ack**: Delete validated `aca-job` queue message
5. **GitHub/Copilot auth**: Mint GitHub App token and retrieve Copilot PAT
6. **Dedup checks**: Verify `squad:processing` label, no existing PR/branch, prevent race conditions
7. **Git identity**: Configure `user.name` = `squad-aca-bot[bot]`
8. **Clone repo**: `gh repo clone {owner/repo}`
9. **Create branch**: `squad/{agent_type}/issue-{issue_number}`
9. **Fetch issue**: Get title, body, labels from GitHub API
10. **Run Copilot**: `copilot --yolo --agent squad` (reads issue body, makes changes)
11. **Fallback**: If Copilot fails, create work artifact in `.squad-work/`
12. **Team state**: Commit any `.squad/` changes (decisions, history)
13. **Push + PR**: Push branch, create PR with enriched body
14. **Label swap**: Remove `squad:processing`, add `squad:queued`
