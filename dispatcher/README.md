# ACA Sandbox dispatcher

The dispatcher is the trusted PR 5 fan-out boundary. It reads a `coordinator-execution` plan, validates it with the v1 contract validator, creates one sandbox per task, stages the repository from a local git bundle at the plan baseline, runs the persona worker, downloads artifacts, and writes `dispatcher-summary.json`.

```powershell
node dispatcher\cli.js --plan plan.json --repo . --out .dispatcher-out --client fake --concurrency 3
```

The default client is `fake`. It creates local sandbox directories under the output directory and executes the real `agents/sandbox/runner/persona-run.sh` with bash. The live client is opt-in only:

```powershell
$env:SQUAD_ENABLE_ACA_SANDBOX = '1'
$env:SQUAD_SANDBOX_GROUP_NAME = '<sandbox-group-name>'
$env:SQUAD_ACA_BIN = 'aca'
node dispatcher\cli.js --plan plan.json --repo . --out .dispatcher-out --client aca
```

## Flow

1. Validate the execution plan with `contracts/aca-sandbox/v1/tools/validate.js`.
2. Build a schema-valid `persona.dispatch` envelope from each task and the roster snapshot in the plan. Persona names are values from the plan, never code constants.
3. Run ready tasks up to the concurrency limit. If a dependency fails, dependent tasks are marked `skipped` and are not dispatched.
4. Create a sandbox labeled by execution ID, task ID, and logical member ID.
5. Create a local git bundle for the exact baseline commit, upload it, clone it inside the sandbox, and detach to the baseline SHA. No remote URL or GitHub token is placed in the sandbox.
6. Upload the dispatch envelope and run the persona worker.
7. Start a fixed runner bootstrap and send a single JSON environment object on stdin. The bootstrap validates an allowlist, sets runner-only variables, and execs the persona runner. Classic `ghp_` tokens are rejected because ACA Sandbox Copilot credentials require fine-grained `github_pat_` tokens.
8. Download `persona-result.json`, `artifact-manifest.json`, and artifacts listed in the manifest.
9. Revalidate result contracts, recompute artifact sha256 values, scan downloaded files for credential material, and re-check patch paths against owned and protected paths.
10. Delete the sandbox in a `finally` block. Delete failures are recorded in the task summary.

## Credential and artifact boundary

The dispatcher reads `SQUAD_COPILOT_TOKEN` once at startup and immediately removes it from `process.env`. Every dispatcher child process is then launched with an explicit sanitized environment. The filter removes `SQUAD_COPILOT_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GITHUB_PAT`, names matching `TOKEN`, `SECRET`, `PASSWORD`, or a trailing `PAT`, plus any secret keys listed by dispatcher configuration. This is defense in depth for `git bundle`, the fake client, and the live `aca` CLI process.

Azure identity variables required by the local `aca` CLI are preserved where they are not secrets, including `AZURE_CLIENT_ID`, managed identity endpoint variables, and other non-secret `AZURE_*` values. `AZURE_CLIENT_SECRET` is intentionally stripped if present and should not be required for this dispatcher path.

The dispatcher redacts the injected Copilot token and common GitHub token prefixes from its logs and summaries. It also rejects any runner stdout, stderr, or downloaded artifact that contains the token. The token is never written to the dispatch envelope, bundle, argv, local `aca` process environment, or log files. Runner environment delivery uses stdin so `SQUAD_SOURCE_REPO_PATH`, `SQUAD_OUTPUT_DIR`, and `SQUAD_COPILOT_TOKEN` are not passed as `aca sandbox exec` arguments.

`SQUAD_ACA_BIN` can point the live client at a specific ACA CLI executable. This is mainly for pinned installations and tests that place a stub executable ahead of the real CLI.

Artifact paths are validated before download and again while writing. Paths must be relative POSIX paths, must not use Windows reserved device names, must not end a segment with a dot or space, must not contain colons or control characters, and must not collide after Unicode NFC normalization and case folding within one manifest.

The live client depends on `aca sandbox exec` forwarding stdin to the sandbox process. That behavior is UNVERIFIED until live ACA validation. If stdin is not supported, the only planned fallback is an also UNVERIFIED mode-600 env JSON file on a runner-only tmpfs path, read once by the same bootstrap and deleted immediately after read.

The persona worker now records `logs/isolation-mode.txt`. In the sandbox image it runs as root only long enough to keep staging/output directories private and execute Copilot as the separate `copilot-agent` user. Local tests without root or without that user run in `same-user` mode and assert the marker explicitly.

CI on Linux should set `SQUAD_REQUIRE_PROC_ARGV_TEST=1` when running `agents/sandbox/test/persona-run.test.js`. Without `/proc` cmdline support the argv credential test is skipped locally, but CI must fail instead of accepting a skipped argv evidence check.

## Live ACA verification checklist

These items are isolated in `dispatcher/clients/aca-cli-client.js` and remain UNVERIFIED until PR 6 runs against a real Sandbox Group:

- Exact `aca sandbox create` flags and JSON output format.
- Exact `aca sandbox exec` argv and environment behavior.
- Whether `aca sandbox exec` forwards stdin to the sandbox process for bootstrap environment delivery.
- Whether native file transfer exists. The adapter currently uses base64 over exec stdin/stdout.
- Sandbox delete behavior and timeout behavior.
- ACR authentication from a Sandbox Group.
