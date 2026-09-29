# ACA Sandbox lab deployment plan

> **Status:** Ready for Validation
>
> **Mode:** Implementation only. No authorization to create resources, configure GitHub, run a live probe, or incur charges.
>
> **Prepared:** 2026-09-28. Source of truth for this lab's preparation, validation, deployment gates, and cleanup.

## 1. Outcome, scope, and approved context

**Goal:** Validate the GA ACA Sandbox path in an isolated lab: first the sandbox control plane and image/CLI probe, then one real persona and integration through the trusted dispatcher. Keep publication disabled. The existing ACA Job deployment and its queue-triggered workflows remain untouched.

| Decision | Approved target |
| --- | --- |
| Azure subscription | `e69b8a95-fe38-42da-b5e6-e3e0a833cf9e` |
| Location | `swedencentral`, subject to provider, API, quota, and policy preflight |
| GitHub organization | `AzureViking` |
| New private repository | `AzureViking/squad-on-aca-sandbox-lab` |
| New dedicated resource group | `rg-squad-aca-sandbox-lab` |
| Only existing Azure resource allowed for reuse | ACR `crsquadacaa6b49feb` in `rg-squad-aca-dev-a6b49feb`, for base images and, if cleanly supported, the lab image |
| Publication | Off initially; separate later authorization and environment |

**Classification:** bounded, manually operated development proof of concept. **Scale:** single region, one persona followed by one integration sandbox at a time, with short auto-suspend and explicit deletion. **Budget:** minimize incremental costs; no dollar estimate or cost approval is implied. **Compliance:** private source, no persisted credentials in plans, artifacts or Terraform state; applicable subscription policy, residency, and quota still need confirmation. The tenant ID is deliberately not guessed and must be read from the approved subscription before federated credentials are configured.

**Non-goals:** production rollout; automatic issue-label routing; migration or refactoring of the legacy ACA Job stack; reusing its queue, storage, job, managed environment, identity, Key Vault, Event Grid topic, GitHub bindings, credentials or Terraform state; creating a second ACR; provisioning publisher credentials or `squad-publish` in the first deployment; changing `azure.yaml`; and executing this plan in the current planning-only task.

## 2. Current-state inventory and reuse boundary

Inventory below is supplied by the request and corroborated by local IaC, not by a fresh Azure query. Reconfirm existence and policy at the validation gate.

| Existing item | Location / code evidence | Lab disposition |
| --- | --- | --- |
| Storage `stsquadacaa6b49feb` and queue | Original RG, `infra/terraform/main.tf` | Do not access or reuse |
| ACR `crsquadacaa6b49feb` | Original RG; base image host is the default in `agents/sandbox/Dockerfile` | Read base images; prefer a distinct `squad-sandbox-lab/persona:<immutable-version>` image in this registry after auth is proven. Do not manage the ACR from lab state |
| Log Analytics workspace, ACA managed environment, Container App Job | Original RG, canonical Terraform full-stack root | Do not import, depend on, or recreate |
| Legacy agent UAMI and federated bindings | Original RG, `main.tf` / `github.tf` | Do not assign to dispatcher, copy OIDC subjects, or reuse |
| Event Grid topic and Key Vault | Original RG | Do not access or reuse |
| Sandbox Group / dispatcher UAMI | None currently, per approved inventory | New lab-scoped resources only |
| Sandbox infrastructure | `infra/terraform/sandbox.tf` | Existing feature flag creates group, dispatcher UAMI and data-owner role only as part of full-stack root. Reuse the design, not that root or its state |
| Manual workflow | `.github/workflows/squad-sandbox-manual.yml` | Fake default, live behind explicit input and protected environment; publisher job exists in code but is not enabled for this phase |
| Trusted dispatcher, persona/integration image | `dispatcher/`, `agents/sandbox/` | Reuse code after lab-specific compatibility changes and validation |
| azd/Bicep | `azure.yaml` points to `infra/bicep/`, with legacy post-provision hooks | Leave unchanged, do not run `azd up` |

**New vs reused matrix:** the only existing Azure dependency is the ACR. Create a private GitHub lab repo, a dedicated RG, an Azure Storage account plus private container for isolated remote Terraform state, a Sandbox Group, a dispatcher UAMI, an environment-scoped federated credential, and narrowly scoped role assignments. Individual persona/integration sandboxes are ephemeral data-plane instances, not long-lived ACA Jobs. No new LAW, ACA managed environment, queue, ACR, Key Vault or Container App Job is planned. If the Sandbox Group API requires additional properties or dependencies, stop and revise this inventory before apply.

## 3. Deployment recipe and state architecture

**Choose plain Terraform with AzAPI in a new minimal `infra/terraform/sandbox-lab/` root**, not conditionals in the existing `infra/terraform/` root. The existing root unconditionally creates a random-suffixed RG, ACR, storage queue, LAW, managed environment, legacy UAMI, Key Vault, legacy Container App Job, and GitHub variables; setting `enable_aca_sandbox=true` cannot isolate it. `-target` is not a safe deployment profile. Do not modify that root to make legacy resources optional just for this test. Extract a small Sandbox Group/UAMI/RBAC module from `sandbox.tf` only if doing so leaves existing references and behavior intact; otherwise implement the three small lab resources separately and document the shared contract. Pin provider versions with a committed lab lock file. The bootstrap state owns the RG and state storage; the separate lab remote state owns only the group, identity, FIC and lab grants. Read the ACR with a data source or explicit ID only, with no managed ACR resource in lab state.

`azure.yaml` is Bicep-based and its hooks build `squad-agent:latest`, check legacy Key Vault secrets, and set legacy queue variables. Running azd/Bicep unchanged would deploy or mutate the wrong topology. Converting it to azd+Terraform would also require separate hook/environment semantics; there is no benefit for this isolated, explicitly planned Terraform root. Leave the legacy azd and Bicep files intact.

**Remote state recommendation:** durable team deployment uses a *new*, lab-owned Azure Storage account and private blob container in the lab RG, with Entra/RBAC blob access, shared-key access disabled where policy permits, TLS, blob versioning/soft delete and restricted network access compatible with the operator/CI. No state account in the original RG. Because a backend must exist before `terraform init`, implement a tiny separate `infra/terraform/sandbox-lab-state/` bootstrap root for the RG, storage account, container and narrowly scoped Storage Blob Data Contributor assignment to the backend operator/CI principal. The bootstrap root starts with a local state file held in an access-restricted operator directory outside Git, backed up securely; it must never be lost while these resources exist. Initialize the lab root only after the backend exists; use distinct state key `sandbox-lab.tfstate` and blob lease locking. The lab root *reads* the bootstrapped RG and state resources; it does not own or destroy them. Bootstrap teardown is last, after lab root destroy and state export. Verify subscription, tenant, storage data-plane RBAC, and private network access before backend initialization. Do not store credentials, GitHub PATs, or Copilot tokens in Terraform inputs/state.

For a one-off individual throwaway test, a local-only state would avoid bootstrap storage but is fragile, harder to hand off, and unsafe for concurrent cleanup. Recommend the isolated remote backend despite its extra storage cost and bootstrap step. Do not repoint existing Terraform state, import legacy resources, or make an unreviewed state migration.

## 4. Proposed code/config changes before any deployment

Implementation is authorized only as local code changes. Resource creation,
GitHub configuration, image publication, live probes and plans remain gated.

1. Add `infra/terraform/sandbox-lab-state/` and `infra/terraform/sandbox-lab/` with separate provider constraints, backend configuration, lab variables and outputs. Parameterize subscription ID, `swedencentral`, exact RG name, ACR resource ID/login server, Sandbox Group name `sbg-squad-aca-sandbox-lab`, UAMI name `id-squad-aca-sandbox-dispatch`, tags, and repository `AzureViking/squad-on-aca-sandbox-lab`. Check name availability and do not treat proposed names as existing. Use `Microsoft.App/sandboxGroups@2026-07-01` through AzAPI pending validation of API shape and region; expose group ID/name and dispatcher principal/client/tenant IDs. Ensure planned resources contain no legacy Job or duplicate ACR, including transitive modules. Prefer a separate lab bootstrap helper to the existing `infra/hooks/postprovision.{sh,ps1}`; those hooks hard-code legacy job image, queue variables and azd outputs. A new helper should consume lab Terraform outputs, validate exact repo/environment/subscription, set only approved lab variables, and fail closed on any mismatch. Never automatically create secrets or enable publication.
2. Inspect `dispatcher/clients/aca-cli-client.js` against the installed CLI and probe with no credentials before a live execution. Its create/exec/delete flags, JSON output, stdin forwarding and base64-over-exec file transfer are explicitly unverified. Both create specs now carry the same validated immutable lab image digest; the live adapter refuses create with `unverified_image_contract` until an approved controlled probe determines the image flag and ACR pull mechanism. Establish how group/resource-group/subscription selection and cross-RG ACR image pull work. Keep the CLI binary path absolute and pin the installed version. If ACR-based Sandbox Group image use is unsupported, do not silently introduce a new registry or credential fallback; stop for a revised, approved architecture.
3. Build `agents/sandbox/Dockerfile` from repo root, using base images in the existing ACR, and publish to a separate lab image namespace/tag with digest captured in outputs/config. Validate base image presence and build-agent pull/push authorization. Prefer an approved ACR remote build to avoid relying on the local Docker daemon; determine whether this build method can resolve private base images before choosing it. Do not overwrite `squad-agent:latest` or existing base image tags.
4. Adapt `.github/workflows/squad-sandbox-manual.yml` for the new private repo. Preserve fake default and `enable_publish_live=false`; require a human-reviewed `squad-sandbox-dispatch` environment and an exact repo/issue/commit-bound *committed live plan*. The checked-in fixture `dispatcher/fixtures/workflow-manual-plan.example.json` is fake-only and live preflight explicitly rejects it. Generate a real single-persona plan from the dynamic `.squad` roster with bounded owned paths, one real issue binding and `$CHECKED_OUT_SHA`, then validate without committing a token or local scratch file. Confirm runner availability: live job currently requires `[self-hosted, linux, squad-aca-cli]`, with trusted absolute `SQUAD_ACA_BIN`, Node 22, Azure OIDC connectivity and sandbox endpoint access. A GitHub-hosted runner is not an assumed substitute. Add clear isolation and concurrency/time limits for lab runs. Extend CI to validate the two lab roots without a backend, workflow syntax, local dispatcher/contracts tests and fake workflow; the existing CI covers only `infra/terraform/`.
5. Adjust repo bootstrap documentation/helper to use the personal GitHub account wrapper `ghp` for `AzureViking`; verify organization permission and private repository eligibility first. Create the new empty private repository only after approval, then transfer a reviewed snapshot from the pushed `feature/aca-sandbox-ga` branch into its `main` branch (prefer a fresh clone/copy with a reviewed content allowlist over mirroring all refs, histories, tags and legacy credentials). Audit `.squad/`, workflow triggers, `.github/` permissions, accidental secrets, history exposure and license before transfer. Keep legacy issue/queue workflows disabled or absent in the lab repo, so a manual test cannot enqueue into the old stack. Preserve traceability to the source commit, do not make the user's local branch a lab deployment target, and do not push in this planning phase.

## 5. Target architecture, access, and GitHub configuration

| Resource / principal | Scope and purpose | Access boundary |
| --- | --- | --- |
| New RG `rg-squad-aca-sandbox-lab` | Approved subscription, `swedencentral` | Contains only lab state, group, identity and related role/FIC objects |
| New state storage account/container | Lab RG, unique compliant name to be chosen at validation; private container | Operator/CI get only necessary state blob data rights; no account keys in GitHub |
| Sandbox Group `sbg-squad-aca-sandbox-lab` | Lab RG, `swedencentral` | One bounded execution boundary; default CPU `1000m`, memory `2048Mi`, auto-suspend `300s` are *per-sandbox inputs*, not group properties |
| Dispatcher UAMI `id-squad-aca-sandbox-dispatch` | Lab RG | `Container Apps SandboxGroup Data Owner` **only at Sandbox Group ID**; no subscription/RG Contributor; no queue, Key Vault, GitHub write, or blanket ACR push |
| Federated identity credential | Child of dispatcher UAMI | Issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, subject **`repo:AzureViking/squad-on-aca-sandbox-lab:environment:squad-sandbox-dispatch`**. GitHub environment must exist before OIDC login; this is not the branch-ref subject used in legacy Terraform |
| Image-build identity | Separate, ephemeral human/CI principal, not dispatcher UAMI | Existing ACR repository-scoped push/pull if supported by its SKU/auth model; otherwise a time-bounded resource-scoped `AcrPush` grant only after explicit approval, then remove. No ACR admin username/password |
| Sandbox image-pull principal | Determine from verified Sandbox Group image contract | If platform requires a managed identity, grant read-only pull at the image repository scope when supported, else ACR resource-scoped `AcrPull` after review. Do not give this identity dispatcher Data Owner, or give personas an Azure identity. If pull uses another mechanism, document and authorize it first |
| Persona and integration sandboxes | Ephemeral children of lab Sandbox Group | No managed identity, GitHub write token, queue access, Key Vault or ACR push. Persona gets only scoped fine-grained Copilot token via verified bootstrap; integration gets no token. Dispatcher receives git patches, validates and deletes sandboxes |

The lab repo must be **private** with least-privilege Actions permissions. `squad-sandbox-dispatch` must have required reviewers, restricted deployment branches (lab `main` only, or exact tested branch), no self-approval where supported, and only the OIDC/CLI/Copilot configuration below. Environment protection availability under the organization's plan and the resulting OIDC `sub` claim must be verified before relying on them. Repository-level `GITHUB_TOKEN` stays `contents: read` for dispatch; the live job alone requests `id-token: write`. Do not copy legacy `SQUAD_AZURE_*`, `SQUAD_STORAGE_ACCOUNT`, or `SQUAD_QUEUE_NAME` values.

| Setting | Scope | Planned value / handling |
| --- | --- | --- |
| `SQUAD_SANDBOX_GROUP_NAME` | Protected dispatch environment variable | Lab Sandbox Group name from Terraform output |
| `SQUAD_SANDBOX_AZURE_CLIENT_ID` | Protected dispatch environment variable | Lab dispatcher UAMI client ID |
| `SQUAD_SANDBOX_AZURE_TENANT_ID` | Protected dispatch environment variable | Approved tenant ID, obtained from subscription |
| `SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID` | Protected dispatch environment variable | `e69b8a95-fe38-42da-b5e6-e3e0a833cf9e` |
| `SQUAD_ACA_BIN` | Protected dispatch environment variable | Absolute path to pinned, trusted ACA CLI on dedicated runner |
| `SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT` | Protected dispatch environment variable | `1` **only during approved controlled probe**; remove once client contract is verified/updated |
| `SQUAD_COPILOT_TOKEN` | Protected dispatch environment secret | Fresh licensed fine-grained `github_pat_` credential with minimum Copilot entitlement; never a classic `ghp_`, never written in plan/state. Verify billing and token permissions separately |
| Lab image digest / ACR host | Protected dispatch environment variables, **after adapter support is implemented** | Immutable image reference and verified ACR host; do not use mutable `latest` |

**Deferred publisher phase only:** later create protected `squad-publish` with required reviewers and independent approval, install a GitHub App on only the lab repo, provide `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and protected `SQUAD_GITHUB_APP_PRIVATE_KEY_PEM`, then enable `enable_publish_live` with `SQUAD_ENABLE_PUBLISH=1` only after dispatch/integration succeeds. Existing workflow stages a protected PEM secret; it does *not* fetch Key Vault. Do not provision these items, grant GitHub write access, or place a PEM in the first deployment. Do not reuse the legacy App installation or Key Vault.

## 6. Phased execution and decision gates

All commands in this section are **future verification or execution examples**, not permission to run them now.

1. **Code and bootstrap review (no cloud mutations):** implement isolated state and lab Terraform roots, repo bootstrap helper, immutable image wiring and adapter fixes, lab CI/workflow adjustments. Verify the source commit, private repo content allowlist, proposed live plan and self-hosted runner ownership. No legacy IaC drift.
2. **Local validation and plan:** `terraform -chdir=infra/terraform/sandbox-lab-state fmt -check`, `terraform -chdir=infra/terraform/sandbox-lab fmt -check`, `terraform -chdir=infra/terraform/sandbox-lab init -backend=false -input=false`, `terraform -chdir=infra/terraform/sandbox-lab validate`, `node --test contracts/aca-sandbox/v1/test/*.test.js dispatcher/test/*.test.js agents/sandbox/test/*.test.js`, and parse workflows. At the approved preflight, read-only subscription, policy, role-definition, API-version, region and quota checks must pass. Run `terraform plan` for **each** root with exact subscription, RG and ACR ID, inspect full create/update/delete counts and ensure no legacy resources and no duplicate ACR. Note: a backend-enabled `plan` requires the approved bootstrap to exist; initial offline checks use `-backend=false` and cannot replace a real state-aware plan.
3. **Cost/apply approval gate:** show exact plan output, runner/build readiness, quote or Azure pricing estimate where available (not invented here), state retention/network access, and rollback owner. Obtain explicit user approval for Azure and GitHub mutations and incremental charges. If SKU/region/API/image auth requires extra resources or registry-wide grants, amend this plan and seek renewed approval.
4. **Create the lab repository** as private in `AzureViking`, transfer only reviewed source and workflows, verify `main` source SHA/provenance and no legacy trigger/bindings. Configure environment protection before OIDC. This occurs only after gate 3.
5. **Bootstrap state and provision Azure:** create only lab RG plus state storage/container from bootstrap root, then initialize the separate lab backend and apply the reviewed lab plan to create group, dispatcher UAMI, environment-subject FIC and Data Owner role. Verify `az account show` matches the approved subscription and tenant. Scope role assignment to exact Sandbox Group ID. Do not deploy any ACA Job.
6. **Build/image gate:** verify read access to existing ACR bases, build image with the exact Dockerfile/context, push uniquely tagged image to existing ACR if cross-RG support and approved auth allow it, resolve digest, test least-privilege pull. Do not overwrite legacy tags or enable ACR admin credentials. A sandbox create must not be attempted with an unverified image contract.
7. **Configure dispatch only:** set the six dispatch environment variables and one protected Copilot secret using approved operator tooling; verify OIDC issuer/audience/subject and runner, without displaying secret values. Publisher environment and credentials remain absent. Run fake workflow first (`execution_mode=fake`, both live toggles false), with a success summary and patch artifact.
8. **Sandbox probe:** after separate live-probe approval, verify installed ACA CLI help/flags and sandbox create/exec/delete with a non-sensitive command and no Copilot credential. Confirm image pull, stdout/stderr/JSON, stdin forwarding or safe file transfer, timeout, cleanup, and minimal role. Record evidence; adjust adapter and retest offline if behavior differs. Do not set `SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT=1` for routine runs.
9. **Live single-persona/integration:** supply a committed, issue-bound dynamic plan with one persona and one owned path; select `live`, `enable_sandbox_live=true`, `enable_publish_live=false`. Observe successful persona patch, verified integration summary, no GitHub mutation, no queue access, and deletion of both sandboxes. Scale to multiple personas only after this proves sound.
10. **Optional later publisher phase:** independently review GitHub App scope, environment and protected secret, enable only after a second cost/security approval and successful integration. Not part of first live scope.

## 7. Preflight capacity, policy, costs, and risks

This plan authorizes read-only subscription inspection, but not resource mutation. The following entries are deliberate **blocking checks**, not fictitious quota results. Do not treat this plan as ready for apply until applicable usage and limits are confirmed or a documented provider-specific fallback is accepted.

| Resource type | Incremental count | Required capacity/policy check before apply |
| --- | ---: | --- |
| `Microsoft.Resources/resourceGroups` | 1 | RG naming, subscription permissions/tags/policy |
| `Microsoft.Storage/storageAccounts` | 1 | Unique name, storage account limit, allowed region/SKU, Entra blob backend/network policy |
| `Microsoft.Storage/storageAccounts/blobServices/containers` | 1 | State storage data-plane permissions, retention and blob lock |
| `Microsoft.App/sandboxGroups` | 1 | `2026-07-01` API registration, `swedencentral` availability, group/sandbox concurrency quota and image support |
| `Microsoft.ManagedIdentity/userAssignedIdentities` | 1 | Regional capacity, permissions and tenant |
| `Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials` | 1 | FIC limit and precise GitHub environment subject |
| `Microsoft.Authorization/roleAssignments` | 1 state blob grant; 1 group Data Owner; optional 1 pull grant if required | Exact role definitions and scopes, RBAC write permission, ACR repository-scope support |
| `Microsoft.ContainerRegistry/registries` | **0 new** | Existing registry health, SKU/auth mode and approved namespace/storage headroom |
| Sandboxes (ephemeral data plane) | Probe: 1; first full run: 1 persona + 1 integration, sequential | Per-group concurrency, CPU/memory, auto-suspend and deletion behavior |

**Validation gate:** record dated policy assignments, provider registration/API response, role definitions, quota/usage and source of each limit. Use quota CLI where supported; for unsupported resource types record provider-specific API or resource-count fallback and documented limit, rather than guessing. If the requested region, identity/RBAC, protected GitHub environment, or state backend cannot be verified, stop before apply.

**Cost categories:** new state storage capacity/transactions and retention; per-sandbox CPU, memory, duration/snapshot or image storage as billed; additional storage/build tasks in the existing ACR; GitHub Actions hosted minutes or self-hosted runner operating costs; Copilot licensed/billed usage; possible network egress. No extra LAW, Container App Job, registry or Key Vault charges are planned. Document current usage, cost alerts/limits and an agreed maximum test duration before apply; no dollar value is assumed.

**Known risks and mitigations:**

- Cross-RG existing ACR use and Sandbox Group ACR authentication are unverified. Prefer image repository-scoped pull if genuinely supported; do not add registry-wide rights without approval. Current ACR IaC says `admin_enabled=true`; confirm live setting, never distribute admin credentials, and plan separate hardening without breaking legacy jobs.
- Current ACA CLI `create` flags, JSON, image selection, `exec` stdin, base64 file transfer and delete/timeout are guesses isolated in the adapter. Probe each, update client and tests before live Copilot dispatch; no secret should be sent to a probe until transport is verified.
- `swedencentral` Sandbox Group/API availability and subscription policies/quotas are not checked here. Denial or unsupported version blocks apply; do not silently switch region or provider.
- GitHub environment protections and OIDC subject must match exactly. A branch-ref FIC does not authenticate an environment job; protect the environment before relying on the subject and verify actual OIDC claim through an approved non-secret probe.
- Fine-grained `github_pat_` token acceptance and Copilot entitlement/billing are unverified in this tenant; a classic `ghp_` token is rejected by preflight. Never store the token in Terraform state or repo.
- Docker daemon may not be available locally; ACR remote build with private base images still needs verification and build permissions. Check image digest and provenance before execution.
- The live runner is a dedicated self-hosted Linux host and may not exist for the new private repo. Runner registration, hygiene, executable path, outbound access and secrets isolation are independent gates; do not repurpose an untrusted shared runner.
- State bootstrap local file and new remote backend add retention/cost and cleanup complexity. Keep local bootstrap state protected and backed up; protect the remote state account from accidental early deletion.

### Validation Proof (2026-09-29)

**Local/offline checks**

| Check | Result |
| --- | --- |
| Terraform version | `1.16.2` available |
| `terraform fmt -check -recursive` on both lab roots | Passed |
| `terraform init -backend=false -input=false` and `terraform validate` on both roots | Passed; providers initialized locally; no remote backend or Azure plan used |
| Node suites: contracts, dispatcher, sandbox | 179 tests: 178 passed, 0 failed, 1 skipped because Windows denied symlink creation (`EPERM`) |
| Initial test-run failures | Temporary-repository tests first failed because ambient global Git config required GPG signing and GPG timed out. Rerun with `commit.gpgsign=false` scoped only to the test process passed. One later combined run had a Windows process-tree timeout; the dispatcher suite passed when rerun separately. No repository Git config was changed. |
| Workflow YAML | 15 files parsed with PyYAML |
| Bootstrap shell syntax | Bash and PowerShell parsers passed |
| Shell line endings | `dispatcher/check-lf.js` passed for 30 tracked/untracked shell files after normalizing the new helper to LF |
| JavaScript syntax and `git diff --check` | Passed |
| Docker image build | Passed using the configured internal npm mirror. Build command supplied `NPM_REGISTRY=https://packagefeedproxy.microsoft.io/npm/`; no credentials were included. `docker run --rm --entrypoint copilot squad-persona-sandbox:validation --version` returned `GitHub Copilot CLI 1.0.89`. Image is local only and was not pushed. |
| Local ACA CLI | Not installed (`aca` is not on PATH); no Sandbox create/exec/delete probe possible |

**Read-only Azure checks**

- Active context matched subscription `e69b8a95-fe38-42da-b5e6-e3e0a833cf9e` and tenant `49ff7219-653a-4644-8540-71d16dbf9c16`.
- `Microsoft.App`, `Microsoft.ManagedIdentity`, and `Microsoft.Storage` providers are registered. `Microsoft.App/sandboxGroups` advertises API `2026-07-01` and lists Sweden Central as a supported location.
- The `Container Apps SandboxGroup Data Owner` role definition is available.
- `rg-squad-aca-sandbox-lab` does not exist, as expected before provisioning.
- Existing ACR `crsquadacaa6b49feb` is provisioned in the original resource group, Basic SKU, with `adminUserEnabled=true`. Its base image repositories and tags exist: `base/golang:1.23.4-bookworm` and `base/debian:bookworm-20240701-slim`.
- The existing registry has `AcrPull`, `AcrPush`, and `Contributor` assignments for legacy principal `id-squad-agent-a6b49feb`. Do not reuse this identity or its grants for the lab. The registry admin account must not be used. Cross-RG image-pull behavior and the correct Sandbox Group pull principal are still unknown.
- Host npm configuration resolves to the managed internal feed `packagefeedproxy.microsoft.io/npm/`; a temporary empty user config confirmed the feed can retrieve `@github/copilot` without the user's GitHub package token. The Docker build did not inherit host npm configuration and therefore fell back to the blocked public endpoint. The Dockerfile now accepts an explicit non-secret HTTPS registry argument, validates it without echoing the value, and retains the public npm default for GitHub CI.
- Two subscription-scope policy assignments were returned. This is not a complete inherited-policy assessment.
- With the user's approval, `Microsoft.Quota` was registered. The `Microsoft.App` quota response reports `SessionPools` limit 50 as applicable and `SandboxCores` limit 20,000 as not applicable. `az quota usage list` for Sweden Central reports `SandboxCores` usage 0 (not applicable), `SessionPools` 0, and `ManagedEnvironmentCount` 1. Because `SandboxCores` is marked not applicable, these figures do not prove usable Sandbox capacity; the first live Sandbox Group creation remains the capacity check. Quota registration changed provider registration only and created no workload resource.

**Blocked / pending before a complete validation or deployment plan**

- Linux-only `/proc` argv/process-tree evidence remains unverified on this Windows host; CI must provide those checks.
- No ACA CLI is installed, so exact create/exec/image/stdin/file-transfer/delete syntax and runtime behavior remain unverified. The code intentionally fails closed before live sandbox creation.
- Applicable Sandbox capacity/current usage, inherited policy, state-account uniqueness/network constraints, GitHub environment protection/OIDC, self-hosted runner readiness, and Copilot entitlement are not yet fully verified.
- No Azure-backed Terraform plan has been generated. No GitHub repo/environment/configuration, Azure resource, identity, assignment, image, or secret was created or changed.

## 8. Verification, rollback, and success criteria

### All validation checks pass

- Confirm Terraform and Azure CLI are installed. Read the active Azure subscription and tenant with `az account show`; compare them with the approved subscription before any Azure-scoped read.
- For `infra/terraform/sandbox-lab-state/` and `infra/terraform/sandbox-lab/`, run `terraform fmt -check -recursive`, initialize with `-backend=false -input=false`, and run `terraform validate`. Do not initialize the remote backend or run an Azure-backed plan during offline validation.
- Run the contract, dispatcher, and sandbox tests, including the sandbox-lab bootstrap tests. Preserve and report platform-specific skips.
- Parse all workflow YAML; check shell syntax and LF line endings; run `git diff --check`; scan proposed files for accidental secret values.
- With the approved Azure context, perform only read-only checks for subscription/tenant, provider registration, region/API/quota and policy support, ACR identity/image metadata, and role-definition availability. Do not create or update resources, identities, role assignments, GitHub repositories, environments, variables, secrets, or credentials.
- Report offline checks separately from Azure read-only checks. A check that cannot be completed because the CLI, permissions, registry access, or Azure MCP is unavailable remains blocked, not passed.
- Only after all checks pass, prepare a backend-enabled Terraform plan for review. Show exact resources and cost categories, then obtain explicit approval before any apply or GitHub mutation.

**Planned read-only verification after authorization:** `az account show --query "{id:id,tenantId:tenantId}"`, `az resource show --ids <sandbox-group-id>`, `az identity show -g rg-squad-aca-sandbox-lab -n id-squad-aca-sandbox-dispatch`, `az role assignment list --scope <sandbox-group-id>`, `az acr show -g rg-squad-aca-dev-a6b49feb -n crsquadacaa6b49feb --query "{id:id,adminUserEnabled:adminUserEnabled,sku:sku.name}"`, `az acr repository show-tags -n crsquadacaa6b49feb --repository squad-sandbox-lab/persona`, `terraform -chdir=infra/terraform/sandbox-lab plan -detailed-exitcode`, and `ghp api repos/AzureViking/squad-on-aca-sandbox-lab/environments`. Redact IDs where appropriate; never print token or PEM values. For fake mode inspect its uploaded integration manifest, patch and succeeded dispatcher summary. For the approved live probe record `aca sandbox --help`, create/exec/delete outcomes, group resource/role scope, image digest and a post-run list showing zero residual sandboxes. Use actual CLI syntax only after local help verifies it.

### Role Assignment Verification

- **Status:** Static code review verified. Live role assignment checks remain pending deployment.
- **Dispatcher identity:** `azurerm_user_assigned_identity.dispatcher` receives `Container Apps SandboxGroup Data Owner` only at `azapi_resource.sandbox_group.id`. It has no resource-group or subscription Contributor/Owner assignment.
- **Sandbox image pull:** An independent optional `image_pull_principal_id` may receive `AcrPull`, scoped to the explicitly read existing registry resource. It is omitted when no principal is configured. This is registry-scoped, not repository-scoped; confirm this grant is required and acceptable before including it in an approved plan.
- **State backend operator:** The state bootstrap accepts an optional operator principal and uses Storage Blob Data Contributor on the state container, not the subscription or entire resource group.
- **Persona and integration sandboxes:** No managed identities or Azure role assignments are provisioned for them.
- **Legacy ACA Job identity:** Not referenced or modified by either lab root.
- **Outstanding:** Determine which principal performs image pull from the verified Sandbox Group contract. Do not assign `AcrPull` to the dispatcher or persona unless required and approved. Confirm the deploying operator's needed permissions separately; no broad role is granted by these roots.

**Rollback:** stop manual dispatch and remove the dispatch environment access and FIC if compromised; revoke the short-lived image-build grant and Copilot credential as necessary; delete any orphan lab sandboxes by verified ID/name; preserve sanitized logs; run reviewed `terraform destroy` against **lab root only** after a fresh plan and explicit destructive-action approval. Confirm no legacy resources appear in state or destroy output. Remove only the lab image tags/digests after verifying no other consumers. Export or retain encrypted remote state as required, then destroy the separate bootstrap root/RG only after another explicit approval and retention check. Deleting the private lab repo is a separate irreversible GitHub approval, not part of automatic rollback. Never run destroy on the legacy full-stack root.

**Success means:** fake dispatch remains offline and produces a validated integration artifact; the new RG contains only approved lab infrastructure; the existing ACR and legacy workload are unchanged except for the explicitly approved lab image namespace and temporary scoped build rights; OIDC resolves only to the dedicated dispatcher UAMI with group-scoped Data Owner; an image-backed persona and credential-free integration sandbox complete a real issue-bound single-persona plan and are deleted; summary and patch are validated; `enable_publish_live=false` throughout, with no PR, label, queue message, or GitHub write action.

**Implementation checkpoint (local only):** separate state and lab Terraform roots, lab backend template, dry-run GitHub environment helper, immutable image validation, fail-closed live image adapter, workflow gates, CI checks and focused tests are in place. Offline Terraform validation and Node regressions passed. No live plan, resource mutation, image build or GitHub configuration was attempted. The live create adapter remains blocked on `unverified_image_contract`, and the lab publisher remains disabled.

**Remaining unknowns requiring evidence before execution:** tenant and subscription policy/quota; Sandbox Group API and region support; ACR pull mechanism and repository-level RBAC support; ACR admin live setting and image build method; exact ACA CLI transport/image syntax; self-hosted runner availability; GitHub environment protection support and exact OIDC subject; Copilot token entitlement; live-plan issue/roster and owned path; pricing/cost ceiling; and named operator for state retention and cleanup. Any change in topology, region, permissions, or cost profile returns to plan review.

### Deployment Record (2026-09-29, MCAPS test tenant)

| Item | Result |
|------|--------|
| State root | Applied: RG `rg-squad-aca-sandbox-lab`, storage `stsquadlab382b9e0be0` (Entra-only, shared keys disabled), private container `sandbox-lab-state`, operator Blob Data Contributor. |
| State network | Tenant Modify policy disabled public access. Operator egress runs through Global Secure Access, so the IP rule never matched. With user approval, tag `SecurityControl=ignore` and `network_default_action=Allow` were set in private tfvars (test tenant only). Repo default stays `Deny`. |
| Lab root | Applied on remote azurerm backend: Sandbox Group `sbg-squad-aca-sandbox-lab` (provisioningState Succeeded), UAMI `id-squad-aca-sandbox-dispatch`, group-scoped SandboxGroup Data Owner, FIC for `repo:AzureViking/squad-on-aca-sandbox-lab:environment:squad-sandbox-dispatch`. No AcrPull granted. |
| GitHub | Private repo `AzureViking/squad-on-aca-sandbox-lab` created (empty). Environment `squad-sandbox-dispatch`: reviewer haflidif, self-review allowed by user decision (sole org member), admin bypass off, main-only branch policy. Four non-secret dispatch variables set by the helper with `--allow-self-review`. |
| Not done | Lab repo content, image push, ACR pull identity, `aca` CLI, `SQUAD_ACA_BIN`, `SQUAD_SANDBOX_IMAGE_REF`, live probe, publisher. |
| Private operator files | `%USERPROFILE%\.squad-sandbox-lab\` (tfvars, backend config, local bootstrap state, plans, outputs). Not in Git; back up the bootstrap state. |
