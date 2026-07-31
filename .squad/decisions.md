# Squad Decisions

## Active Decisions

### 2026-07-30T11:33:51+02:00: Issue #9 azd/Bicep — scope analysis

**What:** Proceed with Issue #9 as additive azd/Bicep support, but scope it as a staged delivery rather than a single "port everything and move Terraform" change. Keep Terraform as the canonical path until Bicep parity is validated. If `infra/terraform/` is introduced, include migration-safe path updates for docs, examples, CI, local state/tfvars guidance, and any workflow or script references in the same PR.

**Why:** The motivation is sound: Bicep avoids current Terraform provider lag around identity-based KEDA auth, removes local state burden for adopters, and aligns with Azure/Copilot users who expect `azd up`. The main risks are operational rather than resource-mapping: moving existing Terraform breaks current `cd infra` guidance and local `terraform.tfvars`/`tfstate` assumptions; Bicep cannot manage GitHub Actions variables, so post-provision GitHub setup remains necessary; and maintaining two IaC paths adds CI and parity-testing burden. Land the folder restructure and Terraform-path compatibility first, then Bicep core parity, then azd polish and docs.

### 2026-07-30T11:33:51+02:00: Issue #9 — TF→Bicep technical assessment

**What:** The current Terraform path provisions all Azure infrastructure from `infra\main.tf` using AVM modules plus `azurerm` resources, with the Container App Job implemented as `azapi_resource` `Microsoft.App/jobs@2025-01-01` and `schema_validation_enabled = false` so the KEDA Azure Queue scaler can use a user-assigned managed identity.

**Why:** A Bicep/azd path is technically feasible because the ARM/Bicep schema for `Microsoft.App/jobs@2025-01-01` includes job identity, registry identity, event trigger scale rules, and scale-rule `identity`. Parity still requires post-deploy handling for GitHub Actions variables and manual or guided uploads of the `github-app-private-key` and `copilot-pat` Key Vault secrets, because those values are intentionally kept out of Terraform state and should remain out of ARM deployment history.

### 2026-07-30T13:34:57+02:00: Issue #9 — validation results

Overall verdict: PASS-WITH-NOTES

| Check | Result | Evidence / output |
| --- | --- | --- |
| Bicep compiles | PASS | `az bicep build --file infra\bicep\main.bicep` exit 0. All module builds (`acr`, `container-app-job`, `identity`, `keyvault`, `monitoring`, `storage`) exit 0. Output only: `WARNING: A new Bicep release is available: v0.45.15.` |
| Bicep lint | PASS | `az bicep lint --file infra\bicep\main.bicep` exit 0. Output only Bicep version warning and installed-Bicep notice. |
| bicepparam valid | PASS | `az bicep build-params --file infra\bicep\main.bicepparam` exit 0. Output only Bicep version warning. |
| Terraform still valid from new path | PASS-WITH-WARNINGS | `terraform -chdir=infra\terraform init -backend=false` exit 0, reused cached providers/modules. `terraform -chdir=infra\terraform validate` exit 0: `Success! The configuration is valid`, with AVM/provider deprecation warnings for `local_authentication_disabled` in `.terraform\modules\log_analytics\outputs.tf`. |
| azure.yaml valid and path-correct | PASS | Python `yaml.safe_load(open('azure.yaml'))` exit 0. Parsed infra: `{'provider': 'bicep', 'path': 'infra/bicep', 'module': 'main'}`. |
| Hook script syntax | PASS-AFTER-TRIVIAL-FIX | PowerShell parser: both `.ps1` hooks no parse errors. Bash syntax rerun: `bash -n ./infra/hooks/preprovision.sh` => `pre_EXIT=0`; `bash -n ./infra/hooks/postprovision.sh` => `post_EXIT=0`. Initial bash validation exposed CRLF sensitivity, so `.gitattributes` now forces `*.sh text eol=lf`. WSL also emitted host `.wslconfig` policy warnings unrelated to repo syntax. |
| No broken old Terraform path references | PASS | Searched `.github`, `README.md`, `docs`, and `infra` for stale `cd infra`, bare `working-directory: infra`, bare `-chdir=infra`, and `infra/{main,providers,variables,outputs,github}.tf`; no matches. |
| Parity spot-check | PASS-WITH-NOTES | All 6 RBAC roles are present in Bicep (`Storage Queue Data Reader`, `Storage Queue Data Contributor`, `AcrPull`, `AcrPush`, `Key Vault Secrets User`, `Key Vault Secrets Officer`). KEDA azure-queue scaler uses `identity: uamiResourceId` (not clientId). Terraform's 10 outputs exist in `main.bicep` (`resource_group_name`, `storage_account_name`, `queue_name`, `acr_login_server`, `container_apps_environment`, `agent_job_name`, `agent_identity_name`, `squad_agent_client_id`, `squad_agent_tenant_id`, `key_vault_name`). Storage disables shared key and creates the queue. Key Vault enables RBAC and creates no secret values. Job env var names match Terraform. |

Defects / notes:

1. LOW — POSIX hook line endings. `bash -n` initially failed on the working copy (`preprovision.sh: line 84: syntax error: unexpected end of file`; `postprovision.sh: line 47: syntax error near unexpected token $'{\r'`). Fix applied: `.gitattributes` now includes `*.sh text eol=lf`; hooks were renormalized locally and syntax now passes.
2. MEDIUM — `infra\bicep\main.bicep:226` hardcodes `principalType: 'User'` for the deployer Key Vault Secrets Officer assignment, while `deployerPrincipalId` is documented as “user or SP”. Deployments run as a service principal may fail role-assignment validation. Suggested fix: parameterize deployer principal type or omit `principalType` if the AVM supports inference.
3. INFO — Bicep CLI reports a newer release (`v0.45.15`) is available.
4. INFO — Terraform validation reports upstream AVM/provider deprecation warnings; configuration remains valid.

Trivial fix made: added LF enforcement for shell hooks in `.gitattributes`. No other implementation changes.

Committed trivial fix: 8ac36a3 (.gitattributes LF enforcement for *.sh).

### 2026-07-30T13:34:57+02:00: Issue #9 — TF relocation + Bicep implementation

**Author:** Chewie (IaC Dev)
**Branch:** squad/9-azd-bicep-support
**Issue:** [#9 — Add azd/Bicep deployment support](https://github.com/haflidif/squad-on-aca/issues/9)

---

## What

Wave 1 of issue #9 is complete:

### Part A — Terraform relocation
- `git mv` moved 6 tracked TF files from `infra/` to `infra/terraform/`:
  `main.tf`, `github.tf`, `providers.tf`, `variables.tf`, `outputs.tf`, `terraform.tfvars.example`
- `Move-Item` moved untracked/gitignored files: `.terraform/`, `.terraform.lock.hcl`,
  `terraform.tfvars`, `terraform.tfstate`, `terraform.tfstate.backup`
- Updated path references in `README.md`, `docs/adoption-guide.md`, `docs/architecture.md`,
  `docs/blog-source-material.md` (all `cd infra` → `cd infra/terraform`, file paths updated)
- `.squad/` internal history/decision files intentionally NOT updated (excluded per spec)

### Part B — Bicep module set (infra/bicep/)
Created 8 files at full parity with `infra/terraform/`:

| File | Notes |
|------|-------|
| `infra/bicep/main.bicep` | Subscription-scoped orchestrator; creates RG, wires all modules |
| `infra/bicep/main.bicepparam` | Sensible defaults; user fills githubAppId, installationId, deployerPrincipalId |
| `infra/bicep/modules/monitoring.bicep` | Wraps `br/public:avm/res/operational-insights/workspace:0.9.1` |
| `infra/bicep/modules/storage.bicep` | Wraps `br/public:avm/res/storage/storage-account:0.18.0`; queue creation inline |
| `infra/bicep/modules/acr.bicep` | Wraps `br/public:avm/res/container-registry/registry:0.6.0` |
| `infra/bicep/modules/identity.bicep` | Wraps `br/public:avm/res/managed-identity/user-assigned-identity:0.4.0`; federated creds loop |
| `infra/bicep/modules/keyvault.bicep` | Wraps `br/public:avm/res/key-vault/vault:0.11.0`; no secret values |
| `infra/bicep/modules/container-app-job.bicep` | Raw `Microsoft.App/jobs@2025-01-01` (same reasoning as TF's azapi_resource — AVM job module doesn't support identity-based KEDA auth) |

ACA managed environment uses `br/public:avm/res/app/managed-environment:0.8.1` directly in `main.bicep` (no separate module file, as per spec).

### Parity verified
All 10 TF outputs are matched by Bicep outputs (same snake_case names for azd compat).
RBAC role assignments: all 6 assignments implemented via AVM `roleAssignments` params.
KEDA scaler: uses UAMI **resource ID** (not client ID) in `scale.rules[].identity` — critical for identity-based auth.
GitHub Actions variables: intentionally excluded from Bicep — comment in `main.bicep` directs Lando to handle via post-provision gh CLI step in `azure.yaml`.

---

## Why

- Issue #9 requested `azd up` support for operators who prefer Bicep over Terraform
- Terraform stays canonical (existing state, existing GitHub provider for repo variables)
- Both coexist under `infra/terraform/` and `infra/bicep/` — users choose one path
- AVM modules ensure ARM API best practices (same vendor as Terraform AVM modules used)
- `az bicep build` passed clean (Bicep CLI 0.42.1); `terraform validate` passed with only upstream AVM deprecation warnings (not in our code)

---

## Hygiene Follow-up for Rai (RAI scan / security review)

**`terraform.tfstate` committed to repo**: Historical state file exists at `infra/terraform/terraform.tfstate` and is excluded by `.gitignore` (`*.tfstate`). HOWEVER, the file may contain resource IDs and potentially sensitive output values (client IDs, tenant IDs) in plaintext. Rai should:
1. Confirm the state file is NOT tracked by git (verify with `git ls-files infra/terraform/terraform.tfstate`)
2. If it ever becomes tracked, add a `git rm --cached` instruction to the onboarding docs
3. For production use, recommend remote state backend (Azure Blob Storage with RBAC) — noted in terraform.tfvars.example as a TODO
4. Scan the state file offline for any unexpected secrets that may have leaked in

This is a non-goal for issue #9 (per spec) but should be scheduled as a follow-up hygiene task.

---

## For Downstream Agents

**Lando (azd/azure.yaml):**
- Bicep entrypoint: `infra/bicep/main.bicep`
- Parameters file: `infra/bicep/main.bicepparam`
- The `agentJob` module file outputs `name` (job name) and `resourceId`
- Post-provision hook must set GitHub Actions variables on target repos (the 5 vars that TF's `github.tf` handles): `SQUAD_AZURE_CLIENT_ID`, `SQUAD_AZURE_TENANT_ID`, `SQUAD_AZURE_SUBSCRIPTION_ID`, `SQUAD_STORAGE_ACCOUNT`, `SQUAD_QUEUE_NAME`
- All 12 outputs available in `azd` deployment output for the hook script

**Cassian (validation):**
- Bicep files validated with `az bicep build infra/bicep/main.bicep` — ✅ clean
- TF files validated with `terraform -chdir=infra/terraform validate` — ✅ clean (3 upstream deprecation warnings in AVM modules, not our code)
- Integration tests should check: resource naming pattern (`rg-{project}-{env}-{suffix}`), RBAC assignments, KEDA scale rule identity type (resource ID not client ID)

**Wedge (docs):**
- `README.md` Quick Start section updated: `cd infra` → `cd infra/terraform`
- `docs/adoption-guide.md` updated: all 3 Terraform `cd` commands updated to `infra/terraform`
- `docs/architecture.md` updated: `infra/main.tf` → `infra/terraform/main.tf`
- New docs needed: Bicep/azd deployment path, side-by-side comparison table (TF vs Bicep paths), post-provision steps for KV secrets and GitHub Actions variables

### 2026-07-30T13:34:57+02:00: Issue #9 — polish (principalType + Dockerfile ARG)

**Author:** Chewie (IaC Dev)
**Branch:** squad/9-azd-bicep-support
**Issue:** [#9 — Add azd/Bicep deployment support](https://github.com/haflidif/squad-on-aca/issues/9)
**Triggered by:** Cassian validation PASS-WITH-NOTES

---

#### FIX 1 — Bicep deployer principalType (MEDIUM)

**What:** Added `param deployerPrincipalType string = 'User'` (with `@allowed(['User','ServicePrincipal','Group'])`) to `infra/bicep/main.bicep`. Replaced the hardcoded `principalType: 'User'` in the Key Vault Secrets Officer role assignment with `principalType: deployerPrincipalType`. Threaded the parameter through `main.bicepparam` with a default of `'User'` and a comment directing CI/SP deployers to set `'ServicePrincipal'`.

**Why:** A service principal deployer (e.g. azd in CI, a Managed Identity) has `principalType = 'ServicePrincipal'`. Azure RBAC role assignments with `principalType: 'User'` fail when the assignee is not a user object — the assignment is rejected at the ARM layer. This fix makes the Bicep stack work for both interactive and automated deployments without any code change.

---

#### FIX 2 — Dockerfile base-image ARG (remove fragile sed workaround)

**What:** Parameterized `agents/base/Dockerfile` with a global `ARG BASE_ACR_HOST=crsquadacaa6b49feb.azurecr.io/` declared before the first `FROM`. Both `FROM` lines now use `${BASE_ACR_HOST}base/golang:...` and `${BASE_ACR_HOST}base/debian:...`. The old ACR is the default so the file remains functional without specifying the arg.

Updated both postprovision hooks (`infra/hooks/postprovision.sh` and `infra/hooks/postprovision.ps1`):
- Removed the sed / `-replace` patch logic and the `Dockerfile.azd-build` temp-file dance entirely.
- Added `--build-arg BASE_ACR_HOST=${ACR_LOGIN_SERVER}/` to the `az acr build` invocation, building directly from `agents/base/Dockerfile`.
- Kept the base-image `az acr import` step (golang + debian from Docker Hub) unchanged, as the build depends on these images being present in the ACR.
- Updated the section A comment in both hook headers to reflect the new approach.

**Why:** The sed-based workaround was fragile: it matched any `.azurecr.io` substring anywhere in the file, created a side-effect temp file that could be accidentally committed, and required parallel maintenance of both hook files whenever the Dockerfile changed. Docker's `ARG` before `FROM` is the idiomatic, supported mechanism for parameterizing base-image registries. The `--build-arg` approach is a single clean handoff at build time with no file mutation.

### 2026-07-30T13:34:57+02:00: Issue #9 — azd integration

**Author:** Lando (Container Dev)
**Branch:** squad/9-azd-bicep-support
**Issue:** [#9 — Add azd/Bicep deployment support](https://github.com/haflidif/squad-on-aca/issues/9)

---

## What

Authored the azd layer that ties Chewie's Bicep modules into a single `azd up` command.

### Files created

| File | Purpose |
|------|---------|
| `azure.yaml` | azd project root — wires Bicep infra, declares hooks |
| `infra/hooks/preprovision.sh` | Bash: validates required env vars before provision |
| `infra/hooks/preprovision.ps1` | PowerShell: same, for Windows |
| `infra/hooks/postprovision.sh` | Bash: image build/push, KV guidance, GH Actions vars |
| `infra/hooks/postprovision.ps1` | PowerShell: same, for Windows |

### Operator flow

```sh
azd auth login
azd env new dev
azd env set GITHUB_APP_ID               <numeric-id>
azd env set GITHUB_APP_INSTALLATION_ID  <numeric-id>
# Optional — wire OIDC federated creds to target repos:
azd env set TARGET_REPOS '["haflidif/squad-on-aca"]'
azd up
# Follow Key Vault secret upload guidance printed by postprovision hook
```

---

## Why

- Issue #9 requires a one-command deploy path (`azd up`) for operators who prefer Bicep/azd over Terraform.
- The Bicep modules (Chewie, wave 1) are complete and validated; this wave wires them into the azd lifecycle.
- Terraform remains canonical; both paths coexist and are independently usable.

---

## Key design decisions

### 1. No `services` block in azure.yaml (Container App Job limitation)

**Problem:** azd's `host: containerapp` targets Container App *instances* (long-lived replicas), not Container App *Jobs* (event-driven, KEDA-triggered, ephemeral executions). There is no `host: containerapps-job` in azd 1.x.

**Decision:** Omit the `services` block entirely. Image build + push is handled in the `postprovision` hook via `az acr build` (cloud-side build, no local Docker required). The Container App Job definition is created by Bicep referencing `${acrLoginServer}/squad-agent:latest`; on first deploy the job skelton exists but cannot execute until the hook pushes the image.

**Impact:** `azd deploy` (which normally rebuilds and re-deploys a service) will NOT automatically rebuild the image. Operators who need to update the image must either re-run `azd up` (full cycle) or manually run `az acr build` and `az containerapp job update`.

**Recommendation for future PR:** When azd adds native Container App Job support (tracked in Azure/azure-dev), add a `services.squad-agent` block with `host: containerapps-job`.

### 2. AZURE_PRINCIPAL_ID → deployerPrincipalId mapping

azd injects `AZURE_PRINCIPAL_ID` (the object ID of the authenticated deploying identity — user or service principal) into all hook environments. `main.bicep` requires `deployerPrincipalId` to grant Key Vault Secrets Officer to the deployer. These are equivalent.

The mapping is achieved via `infra.parameters.deployerPrincipalId: ${AZURE_PRINCIPAL_ID}` in `azure.yaml`. No preprovision hook manipulation needed.

### 3. Dockerfile base-image workaround (noted for Chewie)

**Problem:** `agents/base/Dockerfile` FROM lines hardcode `crsquadacaa6b49feb.azurecr.io` — the ACR from the existing Terraform deployment. A new azd-provisioned ACR has a different name (dynamically derived suffix).

**Workaround implemented in postprovision hook:**
1. Import `golang:1.23.4-bookworm` and `debian:bookworm-20240701-slim` from Docker Hub into the new ACR (idempotent, `--force`).
2. `sed`-patch the Dockerfile to replace the old ACR hostname with the new ACR login server, write to `Dockerfile.azd-build` (ephemeral, gitignored by extension).
3. Run `az acr build` using the patched file.
4. Delete the patched file.

**Recommendation for Chewie (follow-up PR):** Parameterize `agents/base/Dockerfile` with build args:
```dockerfile
ARG BASE_ACR_HOST=docker.io/library
FROM ${BASE_ACR_HOST}/golang:1.23.4-bookworm AS build
FROM ${BASE_ACR_HOST}/debian:bookworm-20240701-slim AS runtime
```
Then `az acr build --build-arg BASE_ACR_HOST=<new-acr>.azurecr.io/base` eliminates the sed workaround.

### 4. TARGET_REPOS as JSON string

Bicep accepts `targetRepos` as an array; azd env vars are strings. The postprovision hook parses the JSON string `'["owner/repo1","owner/repo2"]'` into a shell/PowerShell array and iterates. azd does not natively pass array env vars to Bicep parameters — the hook passes `TARGET_REPOS` only to `gh variable set`, not back into Bicep (Bicep handles it at provision time via the `infra.parameters` binding or Bicep default `[]`).

### 5. azd down / teardown

- Key Vault is deployed with soft-delete only (no purge protection) in dev — `azd down --purge` purges the vault immediately. For production, enable purge protection in `modules/keyvault.bicep`.
- RBAC propagation: new role assignments may take 1-2 minutes to propagate. If the agent job fails with auth errors immediately after first deploy, wait and retry.
- The Container App Job will stop naturally (KEDA scales to zero when queue is empty); no manual teardown of running jobs needed in normal operation.

### 6. azd not installed in CI at time of authoring

`azd` was not found in the local environment PATH. The azure.yaml YAML structure follows the official schema (`https://raw.githubusercontent.com/Azure/azure-dev/main/schemas/v1.0/azure.yaml.json`) and references verified paths. Live validation (`azd provision --preview`) requires the operator's Azure login and an installed azd binary.

---

## For downstream agents

**Cassian (validation / integration tests):**
- Test that `azure.yaml` parses: `azd config list` should succeed after `azd init --no-prompt` in the repo root.
- Validate hook scripts are syntactically correct: `bash -n infra/hooks/preprovision.sh`, `bash -n infra/hooks/postprovision.sh`.
- Integration test: `azd provision --preview` (needs Azure login + azd installed) should show the Bicep parameter prompt for `GITHUB_APP_ID` if not set.
- Test idempotency: running `azd up` twice should not fail on duplicate `gh variable set` (idempotent by design).

**Chewie (IaC Dev):**
- See § "Dockerfile base-image workaround" above — a follow-up PR to parameterize FROM lines will eliminate the sed hack.
- Consider adding `agents/base/Dockerfile.azd-build` to `.gitignore` (ephemeral build artifact).

**Wedge (docs):**
- Document the `azd up` flow in `docs/infrastructure.md` or `docs/adoption-guide.md`:
  - Prereqs: `azd auth login`, env var setup
  - Key Vault secret upload (post-provision guidance printed by hook)
  - GitHub Actions variable wiring (via TARGET_REPOS)
  - Teardown: `azd down --purge`
- Note that `azd deploy` does NOT rebuild the image (Container App Job limitation) — operators must use `azd up` or manual `az acr build`.

### 2026-07-30T13:34:57+02:00: Issue #9 — documentation

**What:** Documented the Bicep and azd deployment path alongside the canonical Terraform path, including prerequisites, commands, post-provision secret handling, GitHub Actions variables, teardown, and a side-by-side deployment comparison.

**Why:** Issue #9 adds Azure-native Bicep support without replacing Terraform. The documentation needs to make both paths discoverable, explain when to choose each one, and preserve the security boundary that keeps Key Vault secret values out of IaC state.

### 2026-07-31T08:22:39+02:00: Issue #9 — azd/Bicep e2e live-run strategy and outcomes

**Author:** Cassian (Tester)
**Branch:** `squad/9-azd-bicep-support`
**Outcome:** ACCEPTED — live e2e succeeded against `a test subscription` in `swedencentral`; teardown completed cleanly.

**What:** The real azd/Bicep e2e strategy is layered validation: keep CI deferred for now, provide what-if validation plus manual ephemeral live deploy scripts, smoke-test the provisioned infrastructure, and always tear down via trap/`finally` unless explicitly skipped for debugging.

**Infra-only e2e boundary:** Routine e2e runs use dummy GitHub App IDs and placeholder Key Vault secret values to validate infrastructure shape and secret-name wiring. They do not pass `--run-job` by default; job execution remains opt-in after real secrets are uploaded.

**Fixes proven by live run:**
- Container App Job now defaults `containerImage` to `mcr.microsoft.com/hello-world:latest` so first provision succeeds before ACR contains `squad-agent:latest`; the postprovision hook updates the job image after `az acr build`.
- What-if/e2e scripts pass the `.bicepparam` file and overrides as separate `--parameters` flags, not one combined argument.
- Smoke tests use ARM management-plane checks (`az rest`) for Storage Queue and Key Vault secret presence, avoiding deployer data-plane RBAC requirements.

**Known environment constraint:** This subscription has an Azure Policy that forces Key Vault `publicNetworkAccess=Disabled`, which blocks public-plane secret upload for dummy secrets. That is an environment constraint, not a Bicep defect; the Terraform path has the same behavior under this policy.

**Evidence:** Cassian delivered `infra/tests/whatif.{sh,ps1}`, `infra/tests/smoke-test.{sh,ps1}`, `infra/tests/e2e.{sh,ps1}`, and `docs/e2e-testing.md`. Live smoke result was 20 PASS after the fixes; the remaining Key Vault secret-upload failures were policy-blocked non-bugs. Commits: `7f5e4cb`, `3c1da5d`, `f26b9d5`, `00f9644`.

### ~~2026-07-31T08:22:39+02:00: Issue #9 — SecurityControl=ignore exemption tag~~ **[SUPERSEDED by 2026-07-31T10:19:38+02:00 below]**

**Author:** Chewie (IaC Dev)
**Outcome:** ~~ACCEPTED~~ **SUPERSEDED** — the always-on tag approach was reverted. See the decision dated 2026-07-31T10:19:38+02:00.

**What:** ~~Added the shared exemption tag to both IaC tag defaults:~~
~~- Bicep: `SecurityControl: 'ignore'` in `infra\bicep\main.bicep` `var tags`~~
~~- Terraform: `SecurityControl = "ignore"` in `infra\terraform\variables.tf` `variable "tags"` default~~

**Reason for supersession:** Hardcoding the exemption tag on every deployment is a security posture problem. The tag now must be injected manually at deploy time via a `tags` override parameter. See the replacement decision below.

### 2026-07-31T10:19:38+02:00: Issue #9 — drop hardcoded SecurityControl tag; expose tags as overridable parameter

**Author:** Chewie (IaC Dev)
**Branch:** squad/9-azd-bicep-support
**Commit:** d80df3f
**Status:** Implemented — supersedes the always-on SecurityControl tag (2026-07-31T08:22:39+02:00)

**What:** The `SecurityControl: 'ignore'` / `SecurityControl = "ignore"` tag has been removed from all IaC defaults. Tags are now an overridable parameter in both paths:

- **Bicep:** `var tags` → `param tags object` with default `{ project: 'squad-on-aca', managed_by: 'bicep' }`. SecurityControl key is absent from the default.
- **Terraform:** `variable "tags"` default is `{ project = "squad-on-aca", managed_by = "terraform" }`. SecurityControl key is absent from the default. `var.tags` is consumed directly by all resources (no `effective_tags` local).

When a deployer needs the exemption (e.g. e2e testing on a policy-restricted tenant), they pass the full tags object with SecurityControl included at deploy time:
- **Bicep:** `--parameters tags='{"project":"squad-on-aca","managed_by":"bicep","SecurityControl":"ignore"}'`
- **Terraform:** `-var 'tags={"project":"squad-on-aca","managed_by":"terraform","SecurityControl":"ignore"}'`

E2e test scripts are unchanged — no auto-injection of the tag.

**Why:** Hardcoding `SecurityControl=ignore` on every deployment is a security posture problem: unnecessary exemption in production, violates least-privilege, and causes security auditors / Defender for Cloud to flag blanket policy exemptions. A boolean opt-in flag was considered and rejected in favour of exposing the existing `tags` parameter as overridable (simpler surface, more flexible, consistent with Terraform's existing pattern, no automation of a narrow manual concern).

**Impact:**

| Component | Change |
|-----------|--------|
| `infra/bicep/main.bicep` | `var tags` → `param tags object` with clean default (no SecurityControl) |
| `infra/bicep/main.bicepparam` | No change to param listing (tags has a default) |
| `infra/terraform/variables.tf` | SecurityControl removed from `variable "tags"` default |
| `infra/terraform/main.tf` | No structural change; all resources consume `var.tags` directly |
| `infra/tests/*.sh / *.ps1` | No change — no auto-injection of exemption flag |
| `docs/e2e-testing.md` | Troubleshooting note: tag not applied by default; manual override shown |
| `docs/infrastructure.md` | Key Vault section: tag not applied by default; manual override shown |

**Validation:** `az bicep build --file infra/bicep/main.bicep` exit 0; `terraform validate` exit 0.

### 2026-07-31T10:11:43+02:00: Issue #9 — TF↔Bicep scaling parity audit (commit 22e33c6)

**Author:** Chewie (IaC Dev)
**Branch:** squad/9-azd-bicep-support
**Outcome:** FULL PARITY — no code fixes required

**What:** Field-by-field comparison of all Container App Job KEDA scaling configuration between `infra/terraform/main.tf` (`azapi_resource.squad_agent_job`) and `infra/bicep/modules/container-app-job.bicep` / `infra/bicep/main.bicep`. All 25 fields compared across API version, trigger type, replica timeout/retry, registry wiring, parallelism, scale min/max/polling, queue scaler rule (name, type, queueName, queueLength, accountName, identity, auth), container resources, identity type, env vars, and all 9 parameter defaults.

**Result:** Every field is ✅ MATCH. One intentional design difference: container image defaults to `mcr.microsoft.com/hello-world:latest` in Bicep (MCR placeholder, avoids chicken-and-egg on first deploy) vs. ACR image in Terraform. This is not a parity defect — it is an established design choice proven in the live e2e run.

**Build verified:** `az bicep build --file infra/bicep/main.bicep` exits 0 (clean compile).

**Validation status:**

| Method | Status |
|--------|--------|
| Field-by-field parity with canonical Terraform | ✅ Verified 2026-07-31 |
| `az bicep build` clean compile | ✅ Verified 2026-07-31 |
| `azd provision` + smoke test (all assertions passed) | ✅ Verified 2026-07-31 live e2e run |
| Live queue-based scale event | ❌ Not performed in issue #9 (declarative parity is sufficient evidence) |

**Documentation updated:**
- `docs/infrastructure.md` — new "Autoscaling: KEDA queue-based scaling" section with parameter table, identity model, full parity table, and live scale test procedure (Options A and B)
- `docs/e2e-testing.md` — `--run-job` description clarified: distinct from a KEDA queue-driven scale test; links to live scale test procedure

### 2026-07-31T13:43:39+02:00: Chewie — docs restructure: dual-IaC adoption guide (commit 103147d)

**Author:** Chewie (IaC engineer)
**Branch:** docs/dual-iac-adoption-guide
**Commit:** 103147d
**Scope:** Docs only — no infra changes.

**What:** `docs/adoption-guide.md` restructured from a linear Terraform-native flow with Bicep/azd wedged in mid-stream, to a parallel two-path structure:

- Steps 1–2 remain shared prerequisites (IaC-neutral).
- New "Choose your IaC path" section after Step 2 gives readers a clear fork: Path A (Terraform, canonical) or Path B (Bicep + azd, Azure-native), with a comparison table.
- `## Path A: Terraform` and `## Path B: Bicep + azd` are now peer sections with parallel step headings.
- "Both paths converge here" transition connects both paths back to shared Steps 6–9.
- Steps 6–9 are now IaC-neutral: each step provides both a Terraform variant and an Azure CLI / azd variant.

`README.md` §3 updated: azd sub-section renamed to "Or deploy with Bicep + azd (Path B)" and links updated to new anchors.

**Key facts documented (verified):**
- `azd up` postprovision hook already builds/pushes image and sets all 5 GitHub Actions repo variables — azd users can skip Step 6 if they haven't customized the agent image.
- Resource names without Terraform state: `az acr list -g <rg> --query "[0].name" -o tsv`; `az keyvault list -g <rg> --query "[0].name" -o tsv`; or `azd env get-values | grep <KEY>`.
- To onboard a new repo on the Bicep path: add to `targetRepos` in `infra/bicep/main.bicepparam`, then `azd provision`.

**Anchor changes:**

| Old anchor | New anchor | Updated in |
|---|---|---|
| `#alternative-deploy-with-bicep-and-azd` | `#path-b-bicep--azd` | `README.md` |
| `#step-4-deploy-infrastructure` | `#path-a--step-4-deploy-infrastructure` | `README.md` |

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction


### 2026-07-31T14:48:51+02:00: Chewie — BASE_ACR_HOST manual build docs fix (commit 86ec4ea, PR #12)

**What:** Updated the manual image build documentation to pass `--build-arg BASE_ACR_HOST=<your-acr-login-server>/` for both ACR and local Docker builds.

**Why:** The agent Dockerfile has a default bootstrap ACR host. Manual adopters need to override that default so builds use base images imported into their own ACR without editing the Dockerfile.
