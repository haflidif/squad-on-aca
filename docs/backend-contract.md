# Backend selector contract

> Contract only. This slice does not change infrastructure, workflows, routing, or installation behavior.

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
| `.squad/aca-installation.json` | Platform ID, installed release version, full action commit SHA, generated file paths and SHA-256 hashes. This receipt describes file ownership, not permission to activate execution. |

Image references end in `@sha256:<64 lowercase hex characters>`. ARM IDs and identity client IDs are non-secret references, never exported secret values. Terraform state, tokens, App PEM, PATs, and secret values do not belong in descriptors or receipts. Installation file paths use repository-relative POSIX notation, even on Windows. The receipt does not hash itself. Future installers must reject duplicate paths, symlinks, unsafe platform-specific paths, and modified owned files before writing.

An output adapter unwraps Terraform's output envelope or azd's output representation without changing the object fields. Until later slices implement these outputs, existing outputs stay unchanged. Existing Sandbox flow limits, dynamic roster resolution, ownership checks, credential boundaries, and stack-neutral checks stay separate and unchanged.

## Routing contract for the later router slice

1. Read `.squad/execution.json` from the trusted default branch. Missing `backend` means `jobs`; missing `enabled` means disabled. Do not treat a missing or invalid platform binding as a usable installation.
2. Validate the setting and matching descriptor. Reject an unavailable backend, invalid selector, or disabled repository before queue send or Sandbox creation.
3. For any authorized, eligible issue request, route `jobs` to provider `aca-job` or `sandbox` to `aca-sandbox`. Issue numbers do not select a backend. Labels request work, not a different provider. Do not execute every incoming issue automatically.
4. Retain actor permission, issue/repository identity, baseline, scope, limits, protected environments, and publication checks. Serialize admission per repository and issue, persist a trusted route receipt before dispatch, and block ambiguous retries for reconciliation. Never dispatch the same request to both backends.
5. Revisions keep the original run/PR provider. Legacy queue messages without provider metadata always remain `aca-job`, regardless of repository settings or environment variables. There is no automatic fallback.

The future repository-wide `enabled` setting replaces `SQUAD_ISSUE_FLOW_ENABLED` as admission control. The backend selector replaces the `SQUAD_ISSUE_OPT_IN_NUMBER` and `sandbox-run` routing gate together. Retire the workflow conditions, issue/revise validators, settings writers, and associated tests in one later slice. If retained as a compatibility request label, `sandbox-run` must use this same router and must not override `backend`. Disable overlapping legacy workflows before activation. None of those gates change in this slice.

Fixtures cover explicit Jobs, explicit Sandbox, omitted/default Jobs, and invalid plural spelling. The dependency-free test validates the JSON Schema subset used here and records provider mappings; it is not a runtime router implementation.

## Resource migration matrix

This table defines the target resource sets, not today's behavior. Today Terraform's `enable_aca_sandbox` is additive and Bicep provisions Jobs only.

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
| Execution setting and activation | Existing single-issue workflow gates | Repository-owned execution setting. Deploying or redeploying infrastructure never enables a repository. Activation follows reviewed workflow migration and protection checks. |
| Secrets and environment protections | Repository/platform administrators | Keep administrator ownership. Settings apply never weakens protections or writes secrets into PR files. |

For a backend switch: provision the destination, export its descriptor, pause admission, drain queued/running work, disable old ingress, review the binding and workflow migration, then activate the new route. Keep the old platform while open PR revisions or receipts still need it. Retire resources only through an explicit reviewed operation. Do not migrate in-flight runs.

Distribution starts with versioned GitHub Release archives, Terraform/azd sources, and `install.ps1`/`install.sh`. No clone or fork is required by the contract. Packaging and installers come in later slices; PowerShell module, npm, and winget distribution are deferred.

## Targeted validation

Run `node --test contracts\backend\v1\test\contracts.test.cjs` from the repository root. No runtime or CI changes are part of this slice.

Related: [Infrastructure](infrastructure.md), [Architecture](architecture.md), [Azure Container Apps Jobs](https://learn.microsoft.com/azure/container-apps/jobs).
