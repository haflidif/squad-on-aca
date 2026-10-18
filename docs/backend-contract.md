# Backend selector contract

> The repository router implements admission and backend selection. Platform deployment and [no-fork repository installation](install.md) are separate operations.

## One selector, native names

| Surface | Name | Values and default |
|---|---|---|
| Repository `.squad/execution.json` | `backend` | `jobs` or `sandbox`; omitted means `jobs` |
| Terraform variable | `execution_backend` | Same values; default `jobs` |
| Bicep parameter | `executionBackend` | Same values; default `jobs` |
| azd environment variable | `SQUAD_EXECUTION_BACKEND` | Same values; unset means `jobs`; passed to Bicep |

Use singular `sandbox`. Reject empty, unknown, plural, and `both` values. One deployment selects one backend. Sandbox is an equal explicit choice, not an add-on or a per-issue exception. Both IaC paths have the same meaning and resource contract. Use one IaC tool per deployment, not shared Terraform and Bicep ownership.

These names supersede the earlier proposal's `sandboxes` and `both` modes. Selector defaults apply only when omitted, never as a fallback for an invalid value. A repository's backend must match its bound deployment descriptor. To switch, bind to a ready destination deployment after draining the old one.

## Versioned files and outputs

Schemas and illustrative routing fixtures live in [`contracts/backend/v1`](../contracts/backend/v1). All three documents use `schema_version: "backend/v1"`, reject unknown fields, and contain no credentials.

| Document | Required content |
|---|---|
| Deployment descriptor | Terraform object output `platform_descriptor`, Bicep object output `platformDescriptor`. Both emit the same JSON shape: release version, platform ID (resource group ARM ID), explicit backend, location, tenant ID, registry and monitoring ARM IDs, positive concurrency and timeout limits, exact OIDC subjects/client IDs/audience, and protected environment names. Include only the selected backend object. |
| Jobs descriptor object `jobs` | Managed environment, Job and Storage account ARM IDs; queue name, Job identity client ID, Key Vault ARM ID, and immutable image reference. |
| Sandbox descriptor object `sandbox` | Sandbox Group ARM ID, separate dispatcher and image-pull identity client IDs, and immutable image reference. |
| `.squad/execution.json` | Platform ID plus optional `backend` (default `jobs`) and `enabled` (default `false`). This is trusted default-branch configuration, not issue input. |
| `.squad/aca-installation.json` | Installed release version, full action commit SHA, generated file paths and SHA-256 hashes. The installer records `backend`; the schema defaults older receipts to Jobs. Platform ID is optional before deployment. This receipt describes file ownership, not permission to activate execution. |

Image references end in `@sha256:<64 lowercase hex characters>`. ARM IDs and identity client IDs are non-secret references, never exported secret values. Terraform state, tokens, App PEM, PATs, and secret values do not belong in descriptors or receipts. Installation file paths use repository-relative POSIX notation, even on Windows. The receipt does not hash itself; the installer writes a companion `.squad/aca-installation.sha256` to detect accidental receipt edits. The installer rejects duplicate paths and unsafe links, and skips unowned or modified files rather than overwriting them. See the [installation guide](install.md) for preview, strict conflict handling, and upgrades.

`scripts/activate.cjs` unwraps Terraform's output envelope or azd JSON environment values without changing descriptor fields. It validates against the platform schema before writing `.squad/platform.json` and a matching `.squad/execution.json`. Fresh bindings are disabled; GitHub settings are print-only unless `--apply` is explicit. Both IaC paths expose `platform_descriptor_missing` for exact null-output blockers. Immutable Jobs and Sandbox image inputs already make the descriptor non-null; mutable tags are never accepted for activation. Existing Sandbox flow limits, dynamic roster resolution, ownership checks, credential boundaries, and stack-neutral checks stay separate and unchanged.

## Repository router

1. `squad-router.yml` is the only issue execution ingress. It reads `.squad/execution.json` and the exported deployment descriptor saved as `.squad/platform.json` from the trusted default-branch event commit. Missing `backend` means `jobs`; missing `enabled` means disabled. Both files are schema validated and their backend and platform IDs must match. Empty, unknown, plural, or mixed backend values fail closed with `ROUTE_REJECTED`, without dispatching either backend.
2. Apply a `squad:<member>` label to request work from either backend. Sandbox also accepts the generic `squad` label for Lead selection. Lifecycle labels are not requests. Issues must be open, and the actor must be a human with current write, maintain, or admin permission. Existing Sandbox issue author, scope, baseline, and publication checks remain in force.
3. The router serializes admission for the repository, then posts a `<!-- squad-route:v1 -->` issue comment containing repository, issue number, backend, provider, platform ID, and original Actions run ID. It posts a separate `<!-- squad-route-request:v1 -->` claim before releasing that request to a backend. Only comments from the GitHub Actions bot's fixed identity are trusted. Malformed or duplicate trusted receipts require reconciliation.
4. Exactly one callable workflow is selected: `squad-queue.yml` for `jobs`, or `squad-sandbox-issue.yml` for `sandbox`. Neither has an issue event trigger. Both independently verify the run-bound claim and backend receipt before authentication or dispatch. Install the router and both callable workflows together; disable or replace any old independently triggered queue or Sandbox workflow before activation.
5. `/squad revise` on an owned Sandbox PR resolves the original issue and reuses its receipt, even if the repository selector has changed or admission has been paused. The original deployment, environment settings, and resources must remain available until those PRs close. Jobs revisions retain the existing Jobs review process; this slice does not add a new Jobs revision protocol or reroute a Jobs PR to Sandbox.
6. A rerun, relabel, duplicate revise request, or receipt with no definite dispatch outcome fails with `DISPATCH_AMBIGUOUS_RECONCILE_REQUIRED`. There is no automatic retry or fallback. Inspect the receipt's run and queue or Sandbox state. Only after proving the old request cannot still execute may an administrator reconcile its claim (and the initial receipt when retrying initial work). Post a new revise comment for a new revision. Never delete a receipt merely to change providers for an in-flight PR.

For compatibility, a repository with **no** `.squad/execution.json` uses a guarded legacy Jobs adapter. This preserves existing provider-less queue messages, dedup labels, OIDC login, and queue sends. The adapter cannot select Sandbox. A present but disabled, invalid, unbound, or unreadable configuration never enters the adapter. New installations should always include the explicit binding and `enabled` setting.

`SQUAD_ISSUE_FLOW_ENABLED`, `SQUAD_ISSUE_OPT_IN_NUMBER`, and the `sandbox-run` request label are retired, not selector aliases. Old values do not activate or restrict routing. The old `--require-opt-in` plan CLI spelling is accepted as a no-op for command compatibility, but cannot authorize dispatch. The infrastructure's azd `SQUAD_EXECUTION_BACKEND` setting is not a second runtime selector: export its descriptor and review the repository binding. No Actions repository variable overrides `.squad/execution.json`.

Fixtures cover explicit Jobs, explicit Sandbox, omitted/default Jobs, and invalid plural spelling. Runtime tests reuse these fixtures. Legacy queue messages without provider metadata always remain `aca-job`, regardless of repository settings or environment variables.

## Resource migration matrix

Both IaC paths implement the selected resource sets below. Terraform's legacy `enable_aca_sandbox` remains additive only for existing inventory and withholds an activation descriptor.

| Resource or boundary | Fresh `jobs` | Fresh `sandbox` | Existing Jobs install |
|---|---|---|---|
| Resource group, ACR, monitoring | Present | Present | Keep IDs, names, data, images, and ownership |
| ACA managed environment and event-driven Job | Present | Absent | Keep environment, Job, scaler settings, and image until explicit migration |
| Work queue and Storage account | Present | Absent | Keep queued work and account; never delete a shared account or Terraform state storage |
| Job identity, queue RBAC, registry permissions, Jobs OIDC | Present | Absent | Keep scopes and exact subjects; do not widen dispatcher permissions |
| Jobs Key Vault, App key/PAT references and associated RBAC | Present | No Jobs secret store or PAT requirement | Keep secrets and access until old runs/revisions no longer depend on them; never export values |
| Sandbox Group, dispatcher identity and group-scoped Data Owner | Absent | Present | Add only in a destination Sandbox deployment |
| Sandbox image-pull identity and registry pull RBAC | Absent | Present | Add separately; do not reuse a broad Job identity |
| Dispatcher OIDC and protected publishing boundary | Jobs path keeps its existing auth | Exact repository/environment subjects; separate trusted publisher, no write credentials in personas | Preserve publisher secrets and environment protections during transfer |

Do not silently reinterpret `enable_aca_sandbox=true` as Sandbox-only: it currently means Jobs plus Sandbox resources. A later explicit migration must report and preserve that mixed inventory until retirement is approved. With no new selector, existing Jobs installations stay Jobs. Reject contradictory old/new inputs rather than destroying old resources.

## Ownership and cutover map

| Item | Current owner | Target owner and migration rule |
|---|---|---|
| Azure resources and state | Selected Terraform root or Bicep deployment | Same owner. Preserve Terraform addresses with `moved` blocks if needed and stable Bicep names. Review a no-replacement plan/what-if before selector adoption. No cross-IaC state migration. |
| GitHub variables and labels | Terraform `github.tf` or azd post-provision hooks | Explicit onboarding settings apply. Stop the old writer first; remove Terraform state ownership without remote deletion where needed. Never leave two writers. |
| Generated workflows and installation receipt | Existing repository content or none | Release installer proposes reviewable changes and records hashes. Modified files are conflicts, not overwrite targets. Preserve roster, charters, decisions, custom workflows, and `.squad/sandbox-flow.json`. |
| Execution setting and activation | Repository router | Repository-owned execution setting. Deploying or redeploying infrastructure never enables a repository. Activation follows reviewed workflow migration and protection checks. |
| Secrets and environment protections | Repository/platform administrators | Keep administrator ownership. Settings apply never weakens protections or writes secrets into PR files. |

For a backend switch: provision the destination, export its descriptor, pause admission, drain queued/running work, disable old ingress, review the binding and workflow migration, then activate the new route. Keep the old platform while open PR revisions or receipts still need it. Retire resources only through an explicit reviewed operation. Do not migrate in-flight runs.

Distribution starts with versioned GitHub Release archives, Terraform/azd sources, and `install.ps1`/`install.sh`. No clone or fork is required. The [local packaging command and no-fork installers](install.md) prepare reviewable target-owned callers without deploying or enabling execution. PowerShell module, npm, and winget distribution are deferred.

## Activation and backend switching

Use the [activation commands](install.md#activate-from-terraform) after Terraform apply or through either azd postprovision hook. `--preview` writes nothing; `--enable` is a separate local admission decision. Neither default activation nor azd hooks changes GitHub settings. Explicit `--apply` requires `gh` and applies non-secret variables only. Secrets and protected environments remain administrator-owned.

Legacy settings detection covers target workflow references, process variables and an optional exported repository-variable JSON file. It reports retired `SQUAD_ISSUE_FLOW_ENABLED`, `SQUAD_ISSUE_OPT_IN_NUMBER` and `sandbox-run` settings without translating them into authorization. Stop the old settings writer and retire competing ingress before activation. Terraform's existing GitHub provider ownership must be transferred explicitly before settings apply.

For either switch direction, commit a pause, drain admitted work, bind a ready separate destination, review settings and protections, then explicitly enable. In-flight issues keep their receipt backend. Keep the old platform and credentials for outstanding PR revisions. Receipts do not snapshot repository variable values, so do not replace same-backend settings while old revisions still need them. See the [cutover steps](install.md#migrate-legacy-settings-and-switch-backend).

## Targeted validation

Run `node --test contracts\backend\v1\test\contracts.test.cjs scripts\backend-router.test.cjs scripts\activate.test.cjs` from the repository root. These tests are offline and do not start Actions or Azure calls.

Related: [Infrastructure](infrastructure.md), [Architecture](architecture.md), [Azure Container Apps Jobs](https://learn.microsoft.com/azure/container-apps/jobs).
