# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Agent Lando initialized as Container Dev. Responsible for the agent base Dockerfile in `agents/` — container image packaging git, gh CLI, Go, Node.js, and squad-cli for running squad agents on Azure Container App Jobs.

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->

- **2026-04-12:** Converted Dockerfile to a proper multi-stage build (golang:1.23.4-bookworm → debian:bookworm-slim runtime). Pinned all base image versions. Added OCI labels. Created `.dockerignore`. This drops the full Go SDK build tooling from the runtime layer and cuts image size significantly.
- **2026-04-12:** Rewrote `entrypoint.sh` to parse `QUEUE_MESSAGE` JSON (containing `issue_number`, `agent_type`, `repo`) instead of expecting separate env vars. This aligns with the single-job design decision — agent_type comes from the queue, not from infra config. Added timestamped logging, `die()` helper, git identity config, and `|| die` guards on every critical command.
- **2026-04-13:** Rewrote `entrypoint.sh` to self-dequeue from Azure Storage Queue using `az storage message get --auth-mode login` (Managed Identity). ACA event-triggered jobs do NOT pass queue messages as env vars — the container must pull the message itself. Added base64 decode of message content, delete-after-parse to prevent reprocessing, and clean exit on empty queue (KEDA race). Added `azure-cli` to Dockerfile runtime stage via pip. Ensured all shell scripts use LF line endings to avoid CRLF breakage in bash line continuations.
- **2026-04-13:** Replaced `squad work` (squad-cli) with a gh-CLI-based workflow in `entrypoint.sh`. Removed `@bradygaster/squad-cli` and Node.js from the Dockerfile — neither is needed anymore. `gh copilot` CLI extension requires an interactive TTY so it cannot work headlessly in a container job. Instead, the entrypoint now reads the issue via `gh issue view`, creates a structured work artifact in `.squad-work/`, commits it, and opens a PR with a status table. This proves the full e2e pipeline works. Documented three future integration paths for actual AI coding: Copilot API, GitHub Models API, and Copilot Coding Agent.
- **2026-04-13:** Integrated GitHub Copilot CLI (`@github/copilot`) into the container. Added Node.js 22 back to both Dockerfile stages and installed the copilot package globally. The entrypoint now pipes issue context to `copilot --yolo` for headless AI coding. Used `set +e` / `PIPESTATUS` to capture copilot failures without killing the script. Falls back to a work artifact (with copilot output log) if copilot fails, so PRs always get created. PR body dynamically reflects whether copilot or fallback was used.
- **2026-04-13:** Added dedup logic to `entrypoint.sh` to prevent multiple containers from working the same issue. Three checks run after GitHub auth: (1) existing open PR search, (2) remote squad branch existence via `git ls-remote`, (3) `squad:processing` label applied to mark the issue in-flight. On successful PR creation, labels swap from `squad:processing` → `squad:pr-open`. All dedup/label operations use `|| true` or `|| log WARNING` to avoid killing the script on non-critical failures. Dedup hits exit cleanly with `exit 0`.
- **2026-04-13:** Replaced PAT-based `GITHUB_TOKEN` with GitHub App JWT → installation token flow per Wedge's architecture decision. Entrypoint now requires `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `KEY_VAULT_NAME`, `KEY_VAULT_SECRET_NAME` instead of `GITHUB_TOKEN`. PEM is retrieved from Azure Key Vault via MI, used only in process substitution (never written to disk). JWT is generated with `openssl` and exchanged for a 1hr installation token via GitHub API. Added `openssl` to the Dockerfile runtime stage. Git identity updated to `squad-aca-bot[bot]` with the App's noreply email. The generated `GITHUB_TOKEN` is exported so `gh` CLI and `git push` continue to work unchanged.
- **2026-04-13:** Removed `function/` directory (legacy Python Azure Function App timer-based issue poller). Superseded by GitHub Actions workflows and ACA event-triggered container jobs. Removed all references from docs/blog-source-material.md. `.gitignore` Azure Functions entries remain (generic and applicable to other contexts).
- **2026-07-30 — Issue #9 azd/Bicep delivered:** Added `azure.yaml` and cross-platform pre/post-provision hooks so operators can use `azd up`; hooks build/push the agent image to ACR, print Key Vault secret guidance, and set the five `SQUAD_*` GitHub variables.

- **2026-07-31 — Issue #9 postprovision live-run fix:** Cassian's live e2e run proved the postprovision hook must update the Container App Job image after `az acr build`; first provision uses the MCR hello-world placeholder until ACR contains `squad-agent:latest`. The e2e/what-if scripts also now pass `.bicepparam` and overrides as separate `--parameters` flags.


## 2026-09-25 — ACA Sandbox runtime provider seam

Implemented the initial PR 2 refactor from `agents/base/entrypoint.sh` into `agents/base/lib/` and `agents/base/providers/`, including Dockerfile updates and a provider seam defaulting to `aca-job`. Reviewer rejection triggered lockout; Wedge owned the approved revision.


## 2026-09-26 — PR 4 persona sandbox image initial implementation

Implemented the initial PR 4 persona sandbox worker image and runner under `agents/sandbox/**`, including `owned_paths` in persona dispatch. Cassian rejected review round 1 with six findings: credential scope, renames, symlinks, ignored files, contract mismatch, and weak tests. Lando was locked out from further revisions on this artifact.

Final PR 4 outcome: Cassian approved round 4 after Wedge's final revision. Validation passed 18 sandbox tests and 14 contract tests; Docker build was not run because the daemon was unavailable. Lasting learning: offline tests must also verify image packaging coverage, and persona processes must not be able to see runner output paths.


📌 Team update (2026-09-26T03:05:00+02:00): PR 5 dispatcher final outcome — Lando's initial dispatcher implementation introduced dependency-aware fan-out, baseline git bundle staging, fake/ACA clients, dispatcher summary schema, artifact re-verification, and the separate `copilot-agent` UID, but Cassian rejected R1 with four High findings and Lando was locked out. Chewie's later revision was approved in Cassian R3. Tests passing at final approval: dispatcher 17, sandbox 24, contracts 17. Live ACA CLI flags, stdin forwarding, file transfer, and ACR auth remain unverified in `dispatcher/README.md`. Learnings: strip credentials from every child process env, not only the target; Windows hosts need device-name-aware path checks; `JSON.parse` hides duplicate keys.


## 2026-09-26 — PR 6 integration round-2 revision

Implemented the PR 6 round-2 integration revision after Wedge's first revision: isolated check copies without `.git`, full source fingerprinting, a hardened bare-repo verifier with temp indexes, raw blob byte equality checks, mirrored runner/dispatcher delta policy, a 256 MiB plumbing ceiling, and Windows `taskkill /T /F` process-tree cleanup gated by `SQUAD_REQUIRE_PROCESS_TREE_KILL_TEST`. Cassian rejected R2 with one High and three Medium findings, and Lando was locked out from further revisions on this artifact.

Final PR 6 outcome: Haflidi later lifted Wedge's lockout, Wedge completed the final hardening revision, and Cassian approved round 4. Validation passed dispatcher 24, sandbox 47, and contracts 19 tests with zero skipped tests. Lasting learnings: hash outputs before running any untrusted check; security tests need a negative control proving the risk is real; `git --numstat` hides rename sources; never glob in cleanup traps.


## 2026-09-26 — PR 7 trusted publisher final revision

Implemented Haflidi-authorized final narrow fixes after Cassian's R4 findings: `runPublish` now returns only the safe result and result path, never its client/token; marker-comment lookup paginates with a 100-page maximum and fails closed on malformed responses or the limit. Added tests for token absence in serialized returns, marker on page 2, absent marker, malformed response, and pagination limit. Cassian approved the final revision. Validation passed: dispatcher 53, sandbox 47, contracts 20 tests, zero skipped; `git diff --check` and LF shell checks passed. No commit created. Learning: keep credentials-bearing clients out of returned operational results, and make API pagination bounded and fail closed.

## 2026-09-26 — PR 8 revision: issue binding and committed CI diff

Bound live plans to the selected repository and issue at workflow preflight, direct ACA dispatch, and publisher preflight before credentials or network calls. Preserved unbound offline plans for fake mode only. CI now checks committed PR merge-base and push before-to-after ranges with full checkout history. The combined offline runner reproduced a dispatcher happy-path failure at roughly 40 seconds under parallel load with the test's original 20-second sandbox timeout; scoped the happy-path test to 120 seconds without retries, leaving timeout failure tests unchanged. Final combined run: 140 tests, 139 passed, one Windows symlink privilege skip, zero failures.

## 2026-09-26 — PR 8 live issue binding and committed CI ranges

Implemented PR 8 fixes binding live plans to the selected repository and issue across schema, dispatcher, workflow preflight, and publisher; fake offline plans remain compatible. Updated CI to inspect committed PR merge-base and push before-to-after ranges. Wedge's final review found and fixed manifest-to-plan consistency and the created-push zero-SHA range; Cassian approved. Final offline validation: 142 passed, one Windows symlink EPERM skip. YAML parsing, shell LF, Terraform fmt/validate passed. Docker build and live ACA/Azure/GitHub behavior remain unverified. Learning: enforce issue identity before credentials or network calls and make CI inspect committed ranges, including first pushes.