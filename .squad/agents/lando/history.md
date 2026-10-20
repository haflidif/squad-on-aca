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

## 2026-10-17 — Publisher tests aligned with multi-member publication

Updated seven stale publisher tests for repository-scoped Basic authentication, App-derived bot fixtures, Squad-Contributor trailers, sandbox lifecycle labels, and separate PR member/source-issue label operations. The manifest identity preflight already passed; strengthened it to observe every GitHub client method, not only token requests. Credential assertions now reject both raw and Base64 secrets in argv and returned/receipt output, require URL-scoped headers for all remote operations, and forbid credentials on local Git operations. No publisher implementation changes were needed. Validation: targeted 8/8; publisher 31/31; scripts 81/81; full dispatcher 114 passed, 21 outside-scope failures, 2 skipped. Learning: authentication encoding and label operation fan-out change test observation points without changing the security guarantees.

## 2026-10-18: PR 13 Docker ownership fixture repair

The downloaded CI log showed one failure among 303 tests: the Docker ownership fixture used bare Ubuntu without installing Git. Fixed the fixture to install Git, use a traversable container-only workspace, preserve the negative-control Git exit code under strict shell execution, and assert actual UID 10001 edits plus both allowed and protected changed paths. Added a Bash syntax regression and documented the fixture's network requirements. Product runtime and workflows are unchanged. Validation: Bash syntax and actual Ubuntu Docker ownership regression 2/2; complete persona file on Linux Node 22.23.3, 24 passed and two environment skips (native-root and nested-Docker), with the Docker case separately passing on the host; patch whitespace passed. The first Linux validation container lacked jq, so it was rerun successfully with that existing runtime dependency installed. Learning: base images do not imply test tooling, mode-700 parent directories block an otherwise writable UID-owned checkout, and negative-control assertions must run after restoring strict error handling.

## 2026-10-20: Packaged engine workflow preflight ordering

Updated stale manual-workflow command assertions after engine packaging. Actual publish order remains summary verification, PEM staging, then publication. Assertions now require every packaged command to exist before checking order; the adjacent pre-Azure-login assertion also uses the packaged preflight command and explicit presence checks. Five in-memory negative controls rejected missing verify/stage/publish commands and both reversed publish orderings. Targeted workflow-preflight, engine, and backend-router suites: 43 passed, 2 skipped, 0 failed. Exact Squad CI command and environment on Windows Node 24.1.0: 264 passed, 25 skipped, 20 failed, including the known 18 dispatcher failures and two shared .work fixture races (ENOTEMPTY and missing local-operation plan). Same complete test selection with --test-concurrency=1: 266 passed, 25 skipped, exactly the known 18 Windows dispatcher failures. Learning: indexOf comparisons must assert presence first because -1 can incorrectly satisfy security ordering checks; shared test scratch roots also make concurrent full-suite results noisy. No workflow or runtime change required.

Team update (2026-10-20T23:52:02.4453036+02:00): Settings automation follow-up 1 completed on `feature/settings-automation`. Explicit `scripts/activate.cjs --apply` creates or updates `squad-sandbox-issue` and `squad-publish` with protected-branch deployment policy, supports an optional reviewer, and streams the App PEM file to `gh secret set` over stdin without logging it. Documentation updated; tests passed 186/186; commit `9f841ea` and PR opened.