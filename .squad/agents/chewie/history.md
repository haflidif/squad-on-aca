# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca, infrastructure for Squad agents on Azure Container Apps with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Bicep/azd, Docker, Python Azure Functions, GitHub Actions, ACA, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Chewie owns IaC in `infra/`. The original Jobs deployment remains the compatibility baseline; later Sandbox support is additive, separately identified, and fails closed when deployment descriptors or immutable image references are incomplete.

## Summarized early learnings

- 2026-04: Consolidated execution into one generic ACA Job that selects its agent at runtime. Corrected AVM argument/output wiring and removed obsolete timer Function App infrastructure after GitHub Actions replaced polling. Storage, queue, and required UAMI roles remained in use.
- 2026-04: GitHub Actions uses OIDC rather than stored credentials. Terraform owns configured non-secret repository variables; Key Vault and GitHub App authentication protect the container job. Avoid relying on connection strings where subscription policy disables key-based storage access.
- 2026-07: Delivered Bicep/azd parity and verified KEDA configuration. Bicep uses a temporary public image only for bootstrap, then postprovision builds/updates the ACR image. `SecurityControl=ignore` addresses the documented Key Vault policy exception and should be considered for parameterization.
- 2026-09: Sandbox infrastructure uses a dedicated dispatcher identity with least privilege. Keep Sandbox Group and dispatcher ownership isolated from existing Jobs resources; verify image/pull contracts and live CLI behavior before enabling live use.
## 2026-09-25 — ACA Sandbox infrastructure planning

Mapped infrastructure implications for the one-sandbox-per-persona model, including Sandbox Groups and RBAC considerations. Outcome was planning input only; no code changes.


## 2026-09-25 — PR 3 ACA Sandbox infrastructure

Delivered PR 3 Terraform support for ACA Sandbox Groups behind `enable_aca_sandbox` defaulting to `false`. Added `infra/terraform/sandbox.tf` with `azapi_resource` for `Microsoft.App/sandboxGroups@2026-07-01`, a dedicated sandbox dispatcher UAMI, and only `Container Apps SandboxGroup Data Owner` at Sandbox Group scope. Added conditional variables/outputs, narrowed AVM module constraints to patch ranges, updated docs, and recorded the decision. Cassian approved the implementation.


## 2026-09-26 — PR 4 credential gate revision and lockout

Completed the PR 4 round 2 revision for persona sandbox credential handling by adding a staged-then-scan credential gate in a private `700` directory and a minimal `credential_leak` result. Cassian rejected round 3 because persona processes could still write around the gate through `SQUAD_OUTPUT_DIR`, `path-scope.js` was missing from the image, and the cleanup trap was installed too late. Chewie was locked out from further revisions on this artifact.

Final PR 4 outcome: Haflidi lifted Wedge's lockout to resolve the deadlock, Wedge completed the final runner revision, and Cassian approved round 4. Validation passed 18 sandbox tests and 14 contract tests; Docker build was not run because the daemon was unavailable. Lasting learning: offline tests must verify image packaging coverage, and persona processes must not see runner output paths.


📌 Team update (2026-09-26T03:05:00+02:00): PR 5 dispatcher final outcome — Chewie's R2 revision stripped credential env from every dispatcher child process, deleted the Copilot token from `process.env` at startup, added Windows device-name-aware artifact path validation and collision detection, rejected duplicate JSON keys with a strict flat parser, and gated `/proc` argv assertions behind `SQUAD_REQUIRE_PROC_ARGV_TEST`. Cassian approved R3. Final tests passed: dispatcher 17, sandbox 24, contracts 17. Live ACA CLI flags, stdin forwarding, file transfer, and ACR auth remain unverified in `dispatcher/README.md`. Learnings: strip credentials from every child process env, not only the target; Windows hosts need device-name-aware path checks; `JSON.parse` hides duplicate keys.


## 2026-09-26 — PR 6 integration initial implementation

Implemented the initial PR 6 integration sandbox step: `integrate-run.sh`, `integrate-runner.js`, `dispatcher/integrate.js`, an additive `integration-dispatch.schema.json`, integration dispatch validation, and tests. Cassian rejected R1 with three High and two Medium findings: checks ran before patch generation, rename sources escaped through `git --numstat`, git output had a 64 KiB truncation path, timeout cleanup killed only the direct child, and cleanup traps globbed sibling directories. Chewie was locked out from further PR 6 integration revisions.

Final PR 6 outcome: Haflidi later lifted Wedge's lockout, Wedge completed the final hardening revision, and Cassian approved round 4. Validation passed dispatcher 24, sandbox 47, and contracts 19 tests with zero skipped tests. Lasting learnings: hash outputs before running any untrusted check; `git --numstat` hides rename sources; never glob in cleanup traps; security tests need a negative control proving the risk is real.

## 2026-10-12 — Protected lab dispatch readiness

Verified live dispatcher and pull identities through the isolated lab Azure CLI context. Added and read back only the three missing protected environment variables for resource group, pull client ID and region; existing reviewer/main-only/admin-bypass settings and the approved sole-maintainer exception remain unchanged. Repository runners are empty; organization runners remain unknown because the API returns 403. GitHub OIDC metadata reports an immutable lowercase repository prefix, while the existing FIC trusts the legacy name-only subject: no authentication or trust change occurred, and subject compatibility is a blocker.

Focused lab-helper and workflow-preflight suites pass 28/28 offline in a network-disabled Linux container using a non-root user and a disposable LF-normalized tracked-source copy. Native Windows preflight testing passes 17, fails offline integration and skips one symlink check. Learning: the offline test chmods its stub, so a read-only source mount cannot serve directly as its test checkout; image root-user isolation also differs from same-user fake testing. Copy only the necessary tracked source into the disposable container, normalize shell line endings there, and leave the shared checkout untouched. No real credential, live dispatch, image publication, runner registration, RBAC change, lab-main update, commit or push occurred.


## 2026-10-18: Exact immutable OIDC subject support

Confirmed GitHub's updated reference and changelog use `repo:OWNER@OWNER_ID/REPO@REPO_ID`, not hyphen-joined IDs. Activation now accepts name-based and immutable repo segments plus paired custom ID claims in any order, while checking the named repository, selected context, identity and audience. Terraform and Bicep exact-subject overrides preserve defaults and export the subject actually deployed; malformed, wildcard, duplicate, unbound and inconsistent ID claims fail closed. Shared fixtures cover all 24 custom claim orders for both repo formats and execution backends. Verification: 233 requested Node tests, 45 Terraform mock plans, Terraform backend-disabled init/validate/fmt, Bicep 0.48.1 build under a process-local Azure config, and offline Bicep snapshot over 154 cases all pass. No deployment or push. Learning: Bicep optional typed-object properties use nullable value types, and offline snapshots can execute shared validation functions without Azure resources.
