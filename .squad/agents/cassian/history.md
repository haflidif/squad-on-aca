# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Agent Cassian initialized as Tester. Responsible for testing and validation across the platform — Terraform validation, Python function tests, Docker build verification, edge cases, and CI test configuration.

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
- **2026-07-30 — Issue #9 azd/Bicep delivered:** Validated Bicep build/lint, bicepparam build, Terraform validate from `infra/terraform/`, azure.yaml parsing, hook syntax, stale Terraform paths, and parity; fixed shell hook LF enforcement via `.gitattributes`.
- **2026-07-31 — Issue #9 e2e testing tooling delivered:** Authored `infra/tests/whatif.{sh,ps1}` (what-if dry run), `infra/tests/smoke-test.{sh,ps1}` (19-assertion smoke suite with opt-in job execution test), `infra/tests/e2e.{sh,ps1}` (full provision→test→teardown loop with trap/try-finally teardown guarantee and --deploy guard). Added `docs/e2e-testing.md` and decision record. All scripts syntax-validated (bash -n + PowerShell ScriptBlock parse). Committed on `squad/9-azd-bicep-support`.
- **2026-07-31 — Issue #9 --parameters gotcha fixed:** Initial what-if scripts joined all `--parameters` values into a single space-separated string for one `--parameters` flag. `az` treats the whole blob as one parameter name → `ERROR: unrecognized template parameter '...\main.bicepparam githubAppId'`. Fix: one `--parameters` flag per value. Proved by running what-if against live sub (exit 0, 12 resources previewed).
- **2026-07-31 — Issue #9 live e2e run complete (subscription 1d2c04aa, swedencentral):** Deployed via `az deployment sub create` (not `azd provision` — `.bicepparam` has hardcoded placeholder values that `azd env set` can't override). Three defects found and fixed: (1) Container App Job fails on first deploy because ARM validates the image exists in ACR (chicken-and-egg) → fixed by using MCR placeholder image as default, postprovision hook does `az containerapp job update` after ACR build. (2) Smoke test queue check uses storage data plane API requiring Queue RBAC the deployer doesn't have → fixed to use ARM resource API. (3) KV secret error message didn't distinguish network-blocked from not-found → improved. Subscription policy forces KV `publicNetworkAccess: Disabled` overriding Bicep setting — documented as constraint. Result: 20/23 PASS (3 FAIL all KV-network-policy related). Teardown: KV purged, RG deleted. All fixes committed (commits 3c1da5d, f26b9d5).
- **2026-07-31 — Issue #9 full-green e2e re-run (SecurityControl tag added by Chewie):** After Chewie added `SecurityControl: 'ignore'` to the shared `tags` var in `infra/bicep/main.bicep` (commit 858cebe), re-ran full e2e against live subscription. KV `publicNetworkAccess` came up `Enabled` — exemption tag works. Dummy KV secrets uploaded successfully via `az keyvault secret set`. All 22 applicable assertions PASS (1 SKIP for Log Analytics — not a Bicep output, name not supplied to smoke test). Docker Hub rate limit hit on `az acr import` for base images; worked around by importing `mcr.microsoft.com/hello-world:latest` as `squad-agent:latest` — confirms this is an operational concern for the postprovision hook in environments with Docker Hub rate limits. Teardown clean: KV purged, RG in Deleting. **azd/Bicep path is fully proven end-to-end.**
- **2026-07-31 — Issue #9 scaling parity audited by Chewie (commit 22e33c6):** Chewie ran a field-by-field KEDA scaling parity audit across all 25 configuration fields (triggerType, replicaTimeout, replicaRetryLimit, parallelism, replicaCompletionCount, scale min/max/pollingInterval, queue rule name/type/queueName/queueLength/accountName/identity/auth, container resources, identity type, env vars, and all parameter defaults). Result: FULL PARITY — every field matches between Terraform and Bicep. The container image default differs intentionally (MCR placeholder in Bicep for bootstrap). Documentation updated: `docs/infrastructure.md` now has a complete autoscaling section with live scale test procedure; `docs/e2e-testing.md` clarifies `--run-job` vs a real KEDA queue-driven scale event. **Future e2e work can optionally exercise a live KEDA scale event** using the procedure in `docs/infrastructure.md#how-to-run-a-live-scale-test` — this was explicitly deferred from issue #9 and is now documented. The `--run-job` flag in the e2e scripts is NOT the same as a KEDA scale test (it uses `az containerapp job start` directly, bypassing queue-based triggering).


## 2026-09-25 — ACA Sandbox contract/runtime review

Validated PR 1 versioned contracts and approved after provider-shape and documentation fixes. Reviewed PR 2 runtime/provider refactor, identified the provider-resolution and pre-ack validation blockers, and approved Wedge's corrected revision.


## 2026-09-25 — PR 3 ACA Sandbox infrastructure review

Reviewed and approved PR 3. Confirmed `enable_aca_sandbox=false` remains a no-op, the shared `squad_agent` UAMI is untouched, provider pins are unchanged, and narrowed AVM module constraints keep the selected module versions compatible.


## 2026-09-26 — PR 4 persona sandbox review outcome

Reviewed PR 4 `agents/sandbox/**` through four rounds. Round 1 rejected six findings (credential scope, renames, symlinks, ignored files, contract mismatch, weak tests). Round 2 rejected token leakage through ignored path names. Round 3 rejected persona access to `SQUAD_OUTPUT_DIR`, missing `path-scope.js` image packaging, and cleanup trap installation happening too late. Round 4 approved Wedge's final revision.

Final validation passed 18 sandbox tests and 14 contract tests. Docker build was not run because the daemon was unavailable. Lasting learning: offline tests must verify image packaging, not only source behavior, and persona processes must not see runner output paths.


📌 Team update (2026-09-26T03:05:00+02:00): PR 5 dispatcher review completed — Cassian rejected R1 with four High findings, rejected R2 with one High and three Medium findings, then approved R3 after Chewie stripped credential env from every dispatcher child process, deleted the token from startup env, added Windows-safe path validation and collision detection, rejected duplicate JSON keys, and gated `/proc` argv tests. Final observed tests: dispatcher 17, sandbox 24, contracts 17. Live ACA CLI flags, stdin forwarding, file transfer, and ACR auth remain unverified in `dispatcher/README.md`. Learnings: strip credentials from every child process env, not only the target; Windows hosts need device-name-aware path checks; `JSON.parse` hides duplicate keys.


## 2026-09-26 — PR 6 integration review outcome

Reviewed PR 6 integration sandbox through four rounds. R1 rejected three High and two Medium findings: checks ran before patch generation, rename sources escaped through `git --numstat`, git output had a 64 KiB truncation path, timeout cleanup killed only the direct child, and cleanup traps globbed sibling directories. R2 rejected one High and three Medium findings: the fingerprint missed ignored content and `.git` metadata, dispatcher verification was not filter/LFS-safe and lacked an independent delta policy, plumbing capture was unbounded, and Windows tree-kill coverage was missing. R3 rejected three Medium findings: baseline symlinks escaped the check copy, hardening tests were vacuous, and failed materialization leaked temp files. R4 approved Wedge's final revision.

Final validation passed dispatcher 24, sandbox 47, and contracts 19 tests with zero skipped tests. Lasting learnings: hash outputs before running any untrusted check; security tests need a negative control proving the risk is real; `git --numstat` hides rename sources; never glob in cleanup traps.
