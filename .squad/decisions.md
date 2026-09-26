# Squad Decisions

## Active Decisions

### 2026-09-24T21-43-32: Resolve sandbox personas dynamically from Squad initialization
**By:** Squad
**What:** Resolve sandbox personas dynamically from Squad initialization
**References:** .squad/team.md, .squad/routing.md, .squad/casting/registry.json
**Why:** Multi-agent ACA Sandbox orchestration must never hard-code cast names such as Chewie, Lando, or Cassian. The Coordinator reads the repository's initialized Squad roster, routing rules, casting registry, and agent charters, then selects agents by role and task fit. Persistent cast names are execution identities only after Squad init has assigned them. Brownfield repositories follow the same contract after Squad initialization. Queue and task manifests should carry stable role/member identifiers plus the resolved persistent name and roster revision.

### 2026-09-24T21-47-12: Use standalone versioned contracts with dependency-free validation
**By:** Wedge
**What:** Use standalone versioned contracts with dependency-free validation
**References:** .squad/decisions.md, .squad/decisions/inbox/squad-resolve-sandbox-personas-dynamically-from-squad-in.md, docs/architecture.md
**Why:** PR 1 will add a versioned contracts directory under contracts/aca-sandbox/v1 with JSON Schema 2020-12 documents, illustrative fixtures, and a Node.js built-in validation script/test. The schemas will model dynamic logical member IDs, resolved persistent names, charter references, roster revision/hash, task ownership, dependencies, baseline SHA, provider, and schema version without embedding this repository's cast names. Existing ACA Job queue payloads remain valid through an explicit backward-compatible legacy envelope plus optional extensions. Cross-field fan-out invariants (baseline and roster data, dependency references, no hard-coded roster assumptions) will be enforced by the validator/tests rather than changing runtime behavior.

### 2026-09-25T16-23-53: Legacy queue messages always resolve to aca-job
**By:** Wedge
**What:** Legacy queue messages always resolve to aca-job
**References:** PR 2 reviewer rejection, agents/base/lib/queue.sh, agents/base/providers/dispatch.sh, agents/base/entrypoint.sh
**Why:** Legacy queue messages without provider metadata must resolve to `aca-job` unconditionally. Environment variables such as `SQUAD_PROVIDER` or `EXECUTION_PROVIDER` must not reroute legacy ACA Job messages. Unsupported provider metadata, including the current `aca-sandbox` stub, is validated before queue acknowledgement so the message remains queued instead of being deleted before the provider failure. This preserves the existing delete-before-work behavior only for validated `aca-job` messages.

### 2026-09-25T20-26-26: Use azapi Sandbox Group plus dedicated dispatcher identity
**By:** Chewie
**What:** PR 3 models ACA Sandbox infrastructure behind `enable_aca_sandbox`. Terraform creates `Microsoft.App/sandboxGroups@2026-07-01` with `azapi_resource` because AzureRM has no native resource, and creates a new sandbox dispatcher UAMI only when the flag is enabled. The dispatcher identity receives only `Container Apps SandboxGroup Data Owner` at the Sandbox Group scope. Persona sandboxes receive no identity or RBAC in this PR.
**References:** infra/terraform/sandbox.tf, infra/terraform/variables.tf, infra/terraform/outputs.tf, docs/infrastructure.md, docs/architecture.md
**Why:** The flag keeps existing ACA Job infrastructure a no-op by default while adding the smallest GA Sandbox control-plane surface. A dedicated dispatcher identity avoids expanding the existing shared `squad_agent` UAMI and establishes the intended security boundary. ACR authentication for Sandbox Groups and any dispatcher federated credential are left as follow-ups because they are not verified in this PR.

### 2026-09-25T20-45-38: Sandbox worker uses pre-staged read-only repository workspaces and protected path fail-closed checks
**By:** Lando
**What:** Sandbox worker uses pre-staged read-only repository workspaces and protected path fail-closed checks
**References:** agents/sandbox/, contracts/aca-sandbox/v1/, agents/base/providers/aca-sandbox.sh, docs/architecture.md, docs/infrastructure.md
**Why:** PR 4 sandbox persona workers obtain source from a dispatcher-pre-staged repository working copy supplied by environment, then verify HEAD equals the dispatch baseline before running Copilot. The sandbox image does not include Azure login, Key Vault, Storage Queue, GitHub App JWT, GitHub CLI, or publication modules. Persona patches are audited with `git diff --binary`. The worker fails closed when changed paths are outside the dispatcher-supplied owned path allowlist, or when any patch touches protected control-plane paths (`.squad/**` and `.github/workflows/**`). ACR authentication for Sandbox Groups remains unverified and is a PR 5 follow-up.

### 2026-09-25T21-01-17: Persona sandbox credential and filesystem boundary
**By:** Wedge
**What:** The PR 4 persona sandbox runner treats path ownership, symlink checks, and credential leak detection as defense in depth. Copilot initially receives injected credentials only as a scoped process environment variable, and the final approved runner executes Copilot under an `env -i` allowlist so persona processes cannot see runner output paths or unrelated host state. The runner redacts token-looking output, detects output tampering, and fails closed without emitting an unredacted patch on credential leakage or tampering. Symlinks resolving outside the repository, changed symlinks whose targets are outside owned paths, and changes outside dispatcher-supplied `owned_paths` fail closed.
**References:** PR 4 review findings, agents/sandbox/runner/persona-run.sh, agents/sandbox/runner/path-scope.js, agents/sandbox/README.md, contracts/aca-sandbox/v1/README.md
**Why:** Copilot's subprocesses can still use credentials intentionally supplied to the sandbox while Copilot is running, so the real boundary is the sandbox, least-privilege short-lived credentials, no write credentials, and dispatcher-side revocation. Runner checks reduce accidental leakage and path escape risk but do not replace filesystem isolation.

### 2026-09-25T21-48-15: PR 4 reviewer lockout lifted by Haflidi so Wedge can fix the remaining runner findings
**By:** Squad (Coordinator)
**What:** PR 4 reviewer lockout was lifted by Haflidi so Wedge could make the final persona sandbox runner revision after all previous implementers had been rejected on the artifact.
**References:** decision feb6a61a-b876-47d8-a137-340964306d0b, PR 4 agents/sandbox/**, Cassian R3 findings
**Why:** Lando, Wedge, and Chewie were each rejected on the PR 4 persona sandbox runner path, leaving no eligible fixer and causing a deadlock. Haflidi explicitly lifted Wedge's lockout. Wedge then fixed Cassian's third-round findings by isolating Copilot with an environment allowlist, preventing persona access to output paths, adding output tamper detection, ensuring `path-scope.js` is packaged into the image, and installing cleanup traps early. Cassian stayed reviewer and approved round 4.

### 2026-09-25T22-28-54: PR 5 dispatcher stages repositories by baseline git bundle
**By:** Lando
**What:** The trusted ACA Sandbox dispatcher creates a local git bundle for the coordinator plan baseline commit, uploads that bundle into each persona sandbox, clones from the bundle inside the sandbox, and detaches to the baseline SHA before running the persona worker.
**References:** dispatcher/dispatcher.js, dispatcher/README.md, docs/architecture.md
**Why:** This keeps repository remotes and GitHub credentials out of persona sandboxes while preserving a verifiable source baseline for every task. The live ACA file-transfer mechanism remains isolated behind the SandboxClient adapter until PR 6 verifies the real CLI/API behavior.

### 2026-09-25T22-28-59: PR 5 closes persona artifact boundary with separate Copilot UID and dispatcher verification
**By:** Lando
**What:** The sandbox image creates a separate `copilot-agent` user. When the runner starts as root in the image, it keeps staging and output directories private to the runner side and executes Copilot through `runuser` or `setpriv` as `copilot-agent`. The dispatcher collects artifacts after runner exit, revalidates result contracts, recomputes sha256 values, scans for credentials, and rechecks patch paths against owned and protected paths.
**References:** agents/sandbox/Dockerfile, agents/sandbox/runner/persona-run.sh, dispatcher/dispatcher.js
**Why:** PR 4's same-UID runner boundary was defense in depth, not a hard filesystem boundary. Separating the Copilot UID in the image and moving final artifact trust to the dispatcher prevents persona code from being the authority for its own output.

### 2026-09-25T22-29-03: PR 5 adds a dedicated dispatcher summary schema
**By:** Lando
**What:** PR 5 adds `dispatcher-summary.schema.json` instead of reusing `integration-result.schema.json`. The dispatcher summary records sandbox lifecycle details, per-task skip and failure reasons, host artifact paths, and sandbox deletion errors.
**References:** contracts/aca-sandbox/v1/schemas/dispatcher-summary.schema.json, dispatcher/dispatcher.js
**Why:** Integration results describe later patch application outcomes. Dispatcher execution needs a narrower operational receipt for fan-out, artifact collection, verification, and cleanup without implying that patches were integrated or published.

### 2026-09-25T22-50-13: Use stdin bootstrap for ACA Sandbox runner environment
**By:** Wedge
**What:** The trusted dispatcher delivers runner environment variables to ACA Sandbox personas by starting a fixed `exec-with-env.js` bootstrap and writing a single JSON object to stdin. The bootstrap validates an allowlist, sets only approved runner variables, and execs the persona runner.
**References:** PR 5, dispatcher/dispatcher.js, dispatcher/clients/aca-cli-client.js, agents/sandbox/runner/exec-with-env.js
**Why:** Passing `SQUAD_SOURCE_REPO_PATH`, `SQUAD_OUTPUT_DIR`, or `SQUAD_COPILOT_TOKEN` through `aca sandbox exec` argv or the local aca process environment can expose credentials or make local tests bypass the live delivery path. Stdin keeps the token out of argv and out of the local spawn environment while still letting the runner receive the values it needs. This depends on `aca sandbox exec` forwarding stdin to the sandbox process and remains unverified until live ACA validation; if stdin is unsupported, the only planned fallback is an also-unverified mode-600 env JSON file on runner-only tmpfs, read once by the same bootstrap and deleted immediately.

### 2026-09-25T22-50-17: Use fd handoff for Copilot token inside persona runner
**By:** Wedge
**What:** The persona runner must not pass the Copilot token through `runuser`, `setpriv`, env, or Copilot argv. It opens file descriptor 3 from an anonymous pipe containing the token and launches `copilot-launch.sh` with a minimal non-secret `env -i` allowlist. The launcher reads fd 3, closes it, exports `GITHUB_TOKEN`, and execs Copilot.
**References:** PR 5, agents/sandbox/runner/persona-run.sh, agents/sandbox/runner/copilot-launch.sh, agents/sandbox/test/persona-run.test.js
**Why:** Copilot CLI requires `GITHUB_TOKEN` in its own environment, but putting `GITHUB_TOKEN=<token>` in argv makes it visible through process command lines. The fd handoff keeps the token out of parent argv while still limiting token lifetime to the Copilot process environment. The same mechanism is used for same-user local fallback and separate-user container execution.

### 2026-09-26T03:05:00+02:00: PR 5 dispatcher spawn hygiene and parser hardening
**By:** Chewie
**What:** The final PR 5 dispatcher revision strips credential environment variables from every dispatcher child process, deletes the Copilot token from `process.env` at startup, applies Windows device-name-aware artifact path validation with collision detection, rejects duplicate JSON keys through a strict flat parser, and gates `/proc` argv assertions behind `SQUAD_REQUIRE_PROC_ARGV_TEST` so unsupported hosts do not produce vacuous coverage.
**References:** PR 5, dispatcher/**, agents/sandbox/runner/exec-with-env.js, agents/sandbox/test/persona-run.test.js, dispatcher/README.md
**Why:** Cassian's first two review rounds showed that protecting only the target sandbox process was insufficient: local adapters and helper processes could inherit credentials, Windows host paths had extra reserved-name escape risks, and `JSON.parse` silently hides duplicate keys. Cassian approved round 3 after dispatcher, sandbox, and contract tests passed. Live ACA CLI flags, stdin forwarding, file transfer, and ACR authentication remain unverified and are tracked in `dispatcher/README.md`.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
