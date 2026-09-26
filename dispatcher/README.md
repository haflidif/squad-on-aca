# ACA Sandbox dispatcher

The dispatcher is the trusted PR 5 fan-out boundary. It reads a `coordinator-execution` plan, validates it with the v1 contract validator, creates one sandbox per task, stages the repository from a local git bundle at the plan baseline, runs the persona worker, downloads artifacts, runs the integration sandbox after all required persona tasks succeed, and writes `dispatcher-summary.json`.

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
10. Delete the persona sandbox in a `finally` block. Delete failures are recorded in the task summary.
11. If every required persona task succeeded, create a fresh integration sandbox labeled with `phase=integration`. Upload the same baseline bundle plus verified persona patches. No Copilot token or credential variable is sent.
12. Run the integration runner through the same stdin bootstrap. The runner applies patches deterministically by dependency order and task ID, validates ownership again, optionally runs argv-only check commands, and emits an integrated patch.
13. Download integration artifacts, validate schemas and sha256 values, rescan for credential patterns, and verify the integrated patch path set equals the union of persona patch path sets.
14. Verify the integrated patch without checkout. The dispatcher builds a bare verification repository from the bundle, disables system and global git config, disables hooks, disables LFS and filters, writes a blanket attributes override, and applies patches to temporary index files only. For every changed path, the integrated patch must produce the same index mode, blob ID, and raw blob bytes as the single persona patch that owns that path.
15. Delete the integration sandbox in a `finally` block.

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


## Integration phase

Integration is automatic unless the caller passes `--no-integrate`. The phase is
fail closed. If any required persona task failed or was skipped, integration is
marked `skipped` and the overall dispatcher summary remains failed. If
integration runs and fails, the overall summary is failed even when all persona
tasks succeeded.

The integration envelope is `integration.dispatch`. It contains patch artifact
paths and sha256 values, task dependencies, `owned_paths`, optional check
commands, and `allow_3way`. The dispatcher sets `allow_3way` to `"false"` unless
the plan explicitly opts in. This preserves the disjoint-owned-path assumption.

The integration runner emits `integration-result.json`,
`artifact-manifest.json`, and on success `patches/integrated.patch`. The
dispatcher independently revalidates the result, compares the runner-reported
patch sha256 with the manifest sha256, and verifies the integrated patch against
the baseline bundle without creating a worktree checkout. Verification uses a
hardened git environment with system and global config disabled, hooks pointed
at an empty directory, LFS smudge disabled, and `.gitattributes` filters
neutralized. Patches are applied with `git apply --cached` against temporary
index files read from the baseline tree, so clean and smudge filters cannot
normalize content during verification. The verifier never checks out a worktree
and its git wrapper allows only `init`, `fetch`, `rev-parse`, `read-tree`,
`apply --cached`, `ls-files`, `cat-file`, `write-tree`, `diff`, and
`diff-tree`. This keeps checkout hooks, worktree update hooks, and filter
commands out of the verification path. The dispatcher then performs the
content-level equality check against persona-owned patch output.

The dispatcher repeats the integration delta policy against the verified
integrated index. It rejects symlink mode `120000`, gitlink mode `160000`,
`.git/**` paths, protected paths, paths outside the union of persona-owned
patch paths, and executable-bit additions unless the owning task has
`allow_executable_bits: "true"`.

Checks run after the runner has already written and hashed the integrated patch.
The runner records the source index tree, a full source worktree fingerprint,
and selected source git metadata before checks. Each check runs in a throwaway
copy with no `.git` directory, and the source fingerprints must still match
afterward. A check that reaches back into the source tree or source git metadata
fails with `checks_mutated_tree`; edits inside the throwaway copy are ignored.

Integration check commands are not supported for repositories whose integrated
tree contains any symlink or gitlink, including unchanged baseline entries. The
runner fails closed with `check_tree_contains_symlink` before materializing the
check copy. Repositories with symlinks can still integrate patches when no
check commands are configured.

The integration runner rejects symlinks, gitlinks, `.git/**` paths, and
executable-bit additions unless a task explicitly opts in with
`allow_executable_bits: "true"`. Git plumbing output uses a large bounded
capture policy and fails with `output_limit_exceeded` if exceeded. The optional
`SQUAD_INTEGRATION_MAX_PLUMBING_BYTES` override must be a positive integer no
larger than 268435456 bytes. Check output is only log data, so it may be
truncated and marked with `truncated: true`.
