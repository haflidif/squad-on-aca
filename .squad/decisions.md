# Squad Decisions

## Active Decisions

### 2026-10-20: Protect settings activation environments and private key handling
**By:** Lando
**What:** During explicit `scripts/activate.cjs --apply`, create or update GitHub environments `squad-sandbox-issue` and `squad-publish` with protected-branch deployment policy, optionally resolving `--reviewer`; stream the App PEM from `--app-private-key-file` to `gh secret set` through stdin.
**Why:** Ensure environment-scoped secrets are set only after environments exist, maintain deployment protection, and avoid logging or persisting private key contents.

### 2026-10-17: Keep the sandbox flow stack-agnostic and configuration-driven
**By:** Squad
**What:** The sandbox flow is configured through `.squad/sandbox-flow.json` and remains stack-agnostic; the bootstrap repository should not impose Terraform-specific opinions.
**Why:** The flow should support different repository stacks without coupling orchestration behavior to Terraform.

### 2026-10-17: Keep lab identifiers out of main
**By:** Squad
**What:** Lab-specific identifiers must not be committed to main.
**Why:** Lab resources and test values are environment-specific and should remain outside the shared bootstrap configuration.

### 2026-10-18T11:16:46.0457553+02:00: Backend selector contract names
**By:** Wedge
**What:** Use `backend` in `.squad/execution.json`, Terraform `execution_backend`, Bicep `executionBackend`, and azd `SQUAD_EXECUTION_BACKEND`. Each accepts only `jobs` or singular `sandbox`, with `jobs` as the omitted default. One deployment selects one backend. Reject `sandboxes`, `both`, empty values, and contradictory legacy inputs. Terraform `platform_descriptor` and Bicep `platformDescriptor` emit identical `backend/v1` JSON. Add descriptor, execution-setting, and installation-receipt schemas under `contracts/backend/v1`.
**Why:** Treat Sandbox as an equal deployment choice without retaining a single-issue opt-in model. Native IaC names retain identical semantics. This supersedes the earlier proposal's plural and combined modes. Slice 1 adds documentation, schemas, fixtures, and targeted tests only. Later slices replace the current workflow gates and settings ownership together. Existing Jobs installs and legacy queue provider routing remain unchanged.


### 2026-10-18T11:21:21.0098681+02:00: Backend-selectable infrastructure preserves legacy Jobs inventory
**By:** Chewie
**What:** Terraform execution_backend and Bicep executionBackend accept jobs|sandbox, default jobs; azd maps SQUAD_EXECUTION_BACKEND through main.parameters.json. Jobs-only resources are conditional, shared RG/ACR/monitoring remain unconditional, and Terraform moved blocks preserve all eleven former singleton addresses. Sandbox uses the existing sandbox-lab Group identity attachment, separate dispatcher and image-pull UAMIs, group-only Data Owner, registry-only AcrPull, and exact squad-sandbox-issue OIDC subjects. Both platform descriptor outputs use backend/v1 keys and list squad-publish as a separately administrator-protected publishing boundary. Neither hooks nor infrastructure activate repository execution.
**Why:** The unset selector must retain the original Jobs configuration and image. A backend switch must provision a separate destination rather than delete queues, secrets, or resources from an existing install. Legacy enable_aca_sandbox=true remains additive and emits no destination descriptor; combining it with sandbox selection fails.
**Readiness:** A descriptor is null until the selected image has an immutable digest. Jobs pinning is explicit (jobs_image_ref or SQUAD_JOBS_IMAGE_REF); otherwise latest/placeholder behavior stays unchanged. Sandbox bootstrap requires an existing pinned worker image. Hooks skip all Jobs setup in Sandbox mode, and skip latest image builds/updates for explicitly pinned Jobs.
**Known boundaries:** Bicep's public catalog omits Sandbox Group identity, so the suppression is scoped only to the verified lab identity property. Disk-image creation, worker publication, trusted publisher provisioning, downstream limits enforcement, repository onboarding, and activation remain separate. No live no-change plan/what-if or deployment has been run; local tests use overridden/mock providers and synthetic values. The built-in SandboxGroup Data Owner UUID c24cf47c-5077-412d-a19c-45202126392c was verified against the public role catalog; Microsoft Learn confirms the required role name.


### 2026-10-18T11:21:19.2463262+02:00: Bundle the Sandbox engine behind a SHA-pinnable composite action
**By:** Lando
**What:** Slice 4 adds `.github/actions/sandbox-engine/action.yml`, a PATH shim, and an allowlisted Node command runner. This repository's issue, manual, and conflict-hint workflows consume the local action. Target repositories use `haflidif/squad-on-aca/.github/actions/sandbox-engine@<full-40-character-commit-sha>` from a reviewed release, without copying engine sources. `SQUAD_ENGINE_ROOT` identifies bundled engine code; the working directory and explicit `--repo` identify the trusted target checkout. The plan and route CLI entrypoints load the target roster, configuration, and revise context from that working directory, not their own module location.
**Why:** GitHub downloads the selected action repository commit as one engine bundle, preserving existing relative module and contract dependencies. Keeping target data separate avoids accidentally routing with this project's roster and removes the need to fork or vendor engine scripts. The wrapper forwards argv without shell evaluation and preserves exit status. Existing opt-in gates, job permissions, protected environments, artifact validation, and GitHub App publisher remain unchanged. The publisher is still the only code/PR writer; trusted metadata jobs retain existing label/comment permissions. No write credentials are passed to untrusted sandboxes.
**Validation:** `node --test .github\actions\sandbox-engine\engine.test.cjs scripts\issue-plan.test.cjs scripts\issue-route.test.cjs scripts\issue-revise.test.cjs scripts\issue-postprocess.test.cjs scripts\issue-stages.test.cjs scripts\issue-routing-infra.test.cjs scripts\issue-routing-multi.test.cjs` passed 165/165 on Windows. Five changed action/workflow YAML files parsed, composite setup and PATH shim smoke test passed, and whitespace checks passed. Known unrelated Windows dispatcher failures were not run or changed. No CI run or push.


# Single repository execution router

Timestamp: 2026-10-18T11:28:06.5379652+02:00
By: Lando
Requested by: Haflidi

## Decision

Use squad-router.yml as the only issue execution ingress. Read trusted default-branch .squad/execution.json and its matching exported deployment descriptor at .squad/platform.json. Omitted backend selects jobs; omitted enabled disables explicit installations. Reject invalid settings without dispatch. Repositories without execution.json retain a guarded legacy Jobs-only adapter. No Actions variable overrides this setting.

Convert the Jobs queue and Sandbox issue workflows to guarded workflow_call consumers. Persist a GitHub Actions bot-owned route receipt and a separate per-request claim before calling exactly one backend. Both consumers independently verify the selected backend and current run claim before Azure authentication. Preserve provider-less Jobs queue messages and the trusted Sandbox publication boundary.

Remove SQUAD_ISSUE_FLOW_ENABLED, SQUAD_ISSUE_OPT_IN_NUMBER, and sandbox-run as routing gates atomically. squad:<member> requests work through the selected backend; Sandbox additionally accepts squad for Lead selection. The retired plan CLI --require-opt-in spelling is a no-op, not admission authority.

Sandbox /squad revise reuses the original issue receipt across selector changes. Keep original deployment settings, protected environments, and resources until revisions drain. Jobs keeps its existing review process; no new Jobs revision protocol is introduced. Ambiguous retries, reruns, relabels, duplicate revise comments, or malformed receipts fail for administrator reconciliation rather than risking a duplicate dispatch. Repository-wide serialization covers issue and PR event numbering differences.

## Validation

Offline targeted Node tests cover contract fixtures, runtime admission and receipt reuse, both callable guards, no-double-dispatch, spoofed or malformed receipts, actor permissions, invalid settings, retired gates, and existing issue plan, route, revise, and engine behavior. No CI runs, push, or Azure calls are performed. Mutable .squad files remain unstaged.


# No-fork installation and local release archives

Date: 2026-10-18T11:37:30.8872081+02:00
By: Wedge
Requested by: Haflidi (haflidif)

## Decision

Ship root install.ps1 and install.sh as thin Node.js entry points. The shared installer consumes an extracted release archive, validates the requested tag or full commit SHA against release.json, and generates four target-owned workflow callers with immutable engine-action SHA references. Source-checkout use requires the requested SHA or local tag to equal HEAD. Jobs is the default; Sandbox is explicit. The installer is application-stack agnostic.

Preview performs no writes or Git/remote mutations. Default installation makes local changes only. Existing Squad state and custom workflows remain untouched. Generated file SHA256 receipts allow replacement only of unchanged owned bytes. User edits and unowned collisions are skipped with a proposed diff; --strict alone makes ownership conflicts return nonzero. A checksum companion protects the receipt from accidental edits. Invalid receipt/checksum pairs block the entire proposal without writes. Upgrades retain old ownership hashes for skipped files and do not delete obsolete owned files.

The pre-deployment installation schema now permits an absent platform_id and an optional jobs|sandbox backend field, preserving earlier receipt validity while allowing the installer to record its chosen backend before Azure exists. Execution scaffolding has enabled=false and an explicit unconfigured platform binding. Installed router callers also require a repository backend variable before admission. Deployment, platform descriptor binding, Squad initialization, protection/credential setup, and explicit activation remain separate administrator actions.

--open-pr is the only path that creates a target branch, commits explicit installer paths, pushes, and opens a PR through gh. It requires a clean target Git root and no conflicts; preview and no-op reruns never invoke it. This option was exercised with an injected command boundary, not live GitHub operations.

Release packaging is a local Node.js command over committed Git objects, with a tar.gz archive, release metadata, and SHA256 sidecar. It includes engine runtime dependencies, worker sources, Terraform/Bicep/azd sources and hooks, templates, installers, and installation docs. It excludes local Squad state, ignored files, keys, environment files, Terraform state, and real tfvars. There is no release CI workflow and no Azure or remote setting operation in this slice.

## Validation

Offline Node tests cover preview no-writes, fresh and existing repositories, same-release byte/timestamp idempotence, user-edit conflicts and strict behavior, receipt integrity, backend recording/schema validation, upgrades, symlink/junction/hardlink safety, shell entry points with spaces, packaging scope, and opt-in PR boundaries. Both PowerShell and Bash entry points ran locally. Archive construction and extracted-archive smoke validation are part of final local verification.

## References

- scripts/install.cjs, install.ps1, install.sh
- scripts/package-release.cjs, scripts/install.test.cjs
- contracts/backend/v1/schemas/installation.schema.json
- docs/install.md and docs/adoption-guide.md

## Final verified outcome

The shipped receipt paths follow the existing backend contract: `.squad/aca-installation.json` and `.squad/aca-installation.sha256`.

All 53 affected installer, contract, router, and engine tests pass. The 20 installer tests also pass from an extracted final release archive. Manual PowerShell and Bash previews create no target directories; both extracted entry points install successfully and rerun without changing the receipt timestamp. Jobs and Sandbox receipts contain the final immutable source SHA. Two independent archive builds of the final commit produce the same SHA256: `f696d7becc5aacb478043626d373007d46b1fa972a3dd0570d6ddab2540632fc`. Archive checksum verification, extraction, and the Bash executable bit pass. All scratch files were removed.

Signed commits, each verified with Git signature status G:
- 5ca6c87743d93e31bbd9524a84bd8de4aa35468a: installer, packaging, tests, schema, and adoption docs.
- d0f0b17: executable Bash entry point.
- d7fd337f70c22b1556958e8e6211fc15f4069c65: receipt-contract alignment and named-state/private-key archive filtering.

No push, CI run, Azure call, live PR operation, repository-setting change, or source branch change occurred. Mutable Squad files remain unstaged.


### 2026-10-18T11:49:46.3334462+02:00: Shared descriptor activation and explicit settings migration
**By:** Chewie
**What:** Slice 7 adds scripts/activate.cjs for Terraform output JSON and azd environment JSON. Validate the complete backend/v1 descriptor before preparing .squad/platform.json and .squad/execution.json. New bindings remain disabled; --enable is explicit. GitHub changes remain print-only unless --apply is passed and gh exists; only known non-secret variables are applied, while secrets and protection changes always remain manual. Both azd postprovision hooks use this script, preview without SQUAD_ACTIVATION_TARGET, and no longer automatically write legacy GitHub variables or labels. Existing immutable image-ref inputs already close the readiness gap; both IaC roots now emit platform_descriptor_missing for exact image or legacy mixed-inventory blockers.
**Why:** Separate provisioning from repository admission without requiring a fork or assuming the application stack. Preserve existing Jobs image build/Key Vault behavior and fail closed for incomplete Sandbox deployment descriptors. Repeated activation preserves unchanged bytes and timestamps. Detect retired settings in process values, target workflows and optional exported remote-variable JSON without querying GitHub by default.
**Migration:** Terraform's legacy GitHub resources remain provider-owned until an explicit reviewed configuration/state handoff without deletion. Do not run activation --apply against the same settings concurrently. Pause and commit admission before switching, drain admitted work, bind a ready separate destination, and retain original receipt backends and old resources/credentials for outstanding revisions. Receipts do not version GitHub variable values, so same-backend deployment switches must preserve old variable values or wait for old PRs to close.
**Validation:** Requested targeted Node suites, activation and IaC hook tests; terraform init -backend=false, fmt -check, validate and seven mocked backend tests; az bicep build with a process-local AZURE_CONFIG_DIR. No CI runs, push or Azure deployment. Decisions stay unstaged.


### 2026-10-18: Exact repository-bound immutable OIDC subjects
**By:** Chewie
**What:** Keep target repository inputs as plain owner/repo names. Add per-repository, per-backend exact subject overrides through Terraform oidc_subjects and Bicep targetOidcSubjects (azd TARGET_OIDC_SUBJECTS). Preserve name-based defaults. Accept repo segments with paired positive numeric @ IDs and optional paired repository_owner_id/repository_id claims in any order, requiring the selected repo and Jobs main ref or Sandbox protected environment. Export the exact deployed subject. Reject wildcard, duplicate, partial, inconsistent, ID-only and unrelated custom-claim templates.
**Why:** GitHub's documented immutable default includes @ separators. Exact subjects avoid guessing a repo's OIDC policy while named-repository and execution-context checks prevent broadened trust. GitHub sources: https://docs.github.com/en/actions/reference/security/oidc and https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/ . No GitHub settings, deployments or pushes were performed.


### 2026-10-18: Slice 8 live adoption smoke verdict: PASS
**By:** Cassian (Tester)
**What:** feature/backend-selector at 250b7ace passed live smoke on haflidif/squad-on-aca-auth-lab. Installer PASS, activation PASS (fail-closed on old TF output, pause-before-switch enforced, immutable OIDC subject accepted), sandbox run PASS (run 39119874779, issue #15, draft PR #16), revise PASS stayed sandbox (run 39120316258), switch to jobs PASS on routing (run 39120826784, receipt jobs, sandbox skipped, enqueue failed at Azure Login because Jobs is not wired for the lab target), invalid backend PASS fail-closed BACKEND_INVALID (run 39120955898). 4 real router runs. No source fixes needed.
**Why:** Proves the single router, receipts and activation behave as designed on a live repo before the PR.
**Open:** Lab cleanup decision (federated credential fic-squad-auth-lab-sandbox-issue, variable SQUAD_EXECUTION_BACKEND=jobs, lab main at a0af377 with backend=banana, open issues #15 #17 #18 and PR #16). Optional offline suite re-run at 250b7ace. Evidence: session files slice8-live-smoke.md.
