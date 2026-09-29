# ACA Sandbox dispatcher

The dispatcher is the trusted PR 5 fan-out boundary. It reads a `coordinator-execution` plan, validates it with the v1 contract validator, creates one sandbox per task, stages the repository from a local git bundle at the plan baseline, runs the persona worker, downloads artifacts, runs the integration sandbox after all required persona tasks succeed, and writes `dispatcher-summary.json`.

```powershell
node dispatcher\cli.js --plan plan.json --repo . --out .dispatcher-out --client fake --concurrency 3
```

The default client is `fake`. It creates local sandbox directories under the output directory and executes the real `agents/sandbox/runner/persona-run.sh` with bash. The live client is opt-in only:

```powershell
$env:SQUAD_ENABLE_ACA_SANDBOX = '1'
$env:SQUAD_SANDBOX_GROUP_NAME = '<sandbox-group-name>'
$env:SQUAD_ACA_BIN = '<absolute-pinned-aca-path>'
$env:SQUAD_SANDBOX_IMAGE_REF = 'crsquadacaa6b49feb.azurecr.io/squad-sandbox-lab/persona@sha256:<64-hex-digest>'
node dispatcher\cli.js --plan plan.json --repo . --out .dispatcher-out --client aca --repo-full-name owner/repository --issue-number 42
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

`SQUAD_SANDBOX_IMAGE_REF` must be an immutable `sha256` digest under
`crsquadacaa6b49feb.azurecr.io/squad-sandbox-lab/`. Both persona and
integration create specs carry the same image. Fake mode needs no image.
The live adapter currently fails with `unverified_image_contract` before
spawning a create command, even when the controlled-probe opt-in is set.
Inspect the pinned CLI help and verify image selection and ACR pull behavior
before implementing its actual create flags. Do not assume an image is selected
implicitly or treat the override as authorization for production dispatch.

Artifact paths are validated before download and again while writing. Paths must be relative POSIX paths, must not use Windows reserved device names, must not end a segment with a dot or space, must not contain colons or control characters, and must not collide after Unicode NFC normalization and case folding within one manifest.

The live client depends on `aca sandbox exec` forwarding stdin to the sandbox process. That behavior is UNVERIFIED until live ACA validation. If stdin is not supported, the only planned fallback is an also UNVERIFIED mode-600 env JSON file on a runner-only tmpfs path, read once by the same bootstrap and deleted immediately after read.

The persona worker now records `logs/isolation-mode.txt`. In the sandbox image it runs as root only long enough to keep staging/output directories private and execute Copilot as the separate `copilot-agent` user. Local tests without root or without that user run in `same-user` mode and assert the marker explicitly.

CI on Linux should set `SQUAD_REQUIRE_PROC_ARGV_TEST=1` when running `agents/sandbox/test/persona-run.test.js`. Without `/proc` cmdline support the argv credential test is skipped locally, but CI must fail instead of accepting a skipped argv evidence check.

## Live ACA verification checklist

These items are isolated in `dispatcher/clients/aca-cli-client.js` and remain UNVERIFIED until a controlled manual run against a real Sandbox Group:

- Exact `aca sandbox create` flags and JSON output format.
- Exact `aca sandbox exec` argv and environment behavior.
- Whether `aca sandbox exec` forwards stdin to the sandbox process for bootstrap environment delivery.
- Whether native file transfer exists. The adapter currently uses base64 over exec stdin/stdout.
- Sandbox delete behavior and timeout behavior.
- ACR authentication from a Sandbox Group.
- Exact immutable image selection flag and pull identity.

## Manual workflow and rollout gates

`.github/workflows/squad-sandbox-manual.yml` is workflow-dispatch only. It takes
an issue number, a repository-relative plan path, the exact repository name,
and an execution mode. `fake` is the default and uses a no-op Copilot stub with
the fake sandbox client. The stub writes a deterministic smoke patch under the
first validated owned path, so integration can verify a real patch without
pretending to perform the task objective. It has no Azure, Copilot, or GitHub
write credential. The workflow uploads only the dispatcher summary,
integration manifest, and integrated patch for one day. It does not upload
runner logs or the baseline bundle. Dispatcher artifacts are contract-checked,
hash-verified, path-checked, and scanned for token material before integration.
Use `dispatcher/fixtures/workflow-manual-plan.example.json` for the offline
smoke path only. It is a static sample roster, not a production coordinator
plan, and should not be selected in live mode.
Live plans must also include an `issue` object containing the exact selected
`repo` (owner/repository) and `issue_number` (positive integer). Older plans
without a binding remain usable only in fake mode. Both workflow preflight
and direct ACA dispatch, as well as the publisher, independently reject absent or mismatched live bindings
before authentication or network requests. Publisher preflight also checks
the plan run ID and baseline against the dispatcher outputs, so a stale plan
cannot publish another execution.
The publisher's fake client is covered offline by the dispatcher tests against
a local bare Git remote; the manual fake mode does not attempt GitHub
publication.

The plan file must live in the checked-out repository. Because a tracked plan
cannot contain the SHA of the same commit without a self-reference, set its
top-level and task `baseline_sha` values to the exact sentinel
`$CHECKED_OUT_SHA`. Preflight substitutes the full GitHub checkout SHA into a
private temporary copy, validates the resulting v1 contract, and passes only
that materialized plan onward. A literal SHA is accepted only when it equals
the checked-out commit. The preflight rejects malformed or absolute paths,
traversal, symlinked path components, invalid repository or issue inputs, and
any commit mismatch before Azure authentication.

Squad CI checks committed whitespace changes, not the clean checkout's
working-tree diff. PR checks use the merge-base of the full-history checkout
and PR base SHA; push checks use the before-to-after range. The first push
uses the new commit's parent or the empty tree for a root commit. A missing
base fails the CI job rather than silently skipping the check.

Live sandbox dispatch is a separate opt-in. Select `live`, enable
`enable_sandbox_live`, and configure the protected `squad-sandbox-dispatch`
environment. A dedicated Linux runner with label `squad-aca-cli` must already
have the trusted ACA CLI installed; `SQUAD_ACA_BIN` must name its absolute
executable path. Configure these environment variables:

| Name | Purpose |
| --- | --- |
| `SQUAD_SANDBOX_GROUP_NAME` | Existing Sandbox Group |
| `SQUAD_SANDBOX_AZURE_CLIENT_ID` | Dedicated dispatcher UAMI client ID |
| `SQUAD_SANDBOX_AZURE_TENANT_ID` | Azure tenant |
| `SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID` | Azure subscription |
| `SQUAD_ACA_BIN` | Absolute path to the pre-installed ACA CLI |
| `SQUAD_SANDBOX_IMAGE_REF` | Immutable digest of the approved lab image in the existing ACR |
| `SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT` | Must equal `1` for an explicitly acknowledged manual probe |

Store `SQUAD_COPILOT_TOKEN` as a protected environment secret. It must be a
fine-grained `github_pat_` token accepted for Copilot use. The UAMI is only for
Sandbox Group data-plane ownership. It is not a GitHub write identity and is
not sent into persona or integration sandboxes. The Copilot token is provided
to persona execution only; the integration phase receives no credential.

Live publication is a second, independent opt-in and is unavailable unless the
live dispatch job and integration both succeed. Configure required reviewers on
the `squad-publish` GitHub environment. Add environment variables
`GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID`, and store the PEM contents as
the protected `SQUAD_GITHUB_APP_PRIVATE_KEY_PEM` secret. Workflow code does not
retrieve the PEM from Key Vault yet. The publish job validates the successful
summary first, validates the PEM, stages it as a mode-600 file under
`RUNNER_TEMP`, and removes that exact file on exit. The App key and installation
write token are never made available to persona or integration execution. The
GitHub App installation needs only `contents: write`, `pull_requests: write`,
and `issues: write` on the target repository. GitHub Actions `GITHUB_TOKEN`
remains read-only.

The workflow uses the existing outbound routes only: GitHub Actions to Azure
OIDC and the configured ACA endpoint, plus the publisher to the target
repository's GitHub HTTPS API and git endpoints. It adds no Azure network
route. Missing runner, CLI, identity, group, Copilot, or App configuration
fails before the corresponding authentication or mutation step. The manual
workflow never fires from labels, and the legacy queue template remains on
ACA Jobs.

This workflow is not production-ready. Exact ACA create and exec behavior,
stdin forwarding, file transfer, deletion and timeout behavior, and Sandbox
Group ACR authentication are still unverified. `SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT=1`
is a deliberate controlled-probe gate, not proof of compatibility. Do not
enable unattended or label-driven Sandbox dispatch until the live checklist
passes. The workflow does not invent alternate CLI flags or silently switch
to file transfer.


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

## Publish phase

The publisher is the trusted PR 7 boundary. It never runs in a persona or integration sandbox. It consumes a succeeded `dispatcher-summary.json`, the integration artifact manifest, and the integrated patch:

```powershell
node dispatcher\cli.js publish `
  --summary .dispatcher-out\dispatcher-summary.json `
  --repo . `
  --plan plan.json `
  --repo-full-name owner/repo `
  --issue-number 42 `
  --issue-title "Issue title"
```

Live GitHub mutation is opt-in only. The real REST client refuses unless both `--live` and `SQUAD_ENABLE_PUBLISH=1` are present. Offline tests use `FakeGitHubClient` and a local bare git repository as the remote.

The publish preflight fails closed before requesting any installation token when the dispatcher summary or integration artifact manifest is invalid, the manifest run ID or baseline SHA does not match the execution plan and summary, the integration status is not `succeeded`, the integrated patch path or sha256 does not match both the summary and artifact manifest, or required issue metadata is missing. `--baseline-sha` is only a checked assertion against the manifest value. It cannot override manifest or plan metadata. The target repository name must be a validated `owner/repo` value, cannot contain `..`, and cannot end in `.git`. After the scoped installation token is created, the publisher fetches the target branch from an explicit repository URL built from that validated name and an allowed host, then verifies that the target branch contains the recorded baseline SHA. If the target branch has moved forward but still contains the baseline, v1 does not rebase or merge. It creates the publish branch directly from `baseline_sha`, so the draft PR shows that the branch is behind.

Publication is idempotent by execution ID. The branch name is deterministic from the issue number, execution ID, and sanitized issue-title slug. The publisher first rebuilds the expected tree from the verified integrated patch and the recorded baseline. It then looks up pull requests for that deterministic head branch with `state=all`. If an open pull request already exists for that branch, reuse is allowed only when the pull request head SHA equals a freshly fetched remote branch SHA, the branch commit tree equals the rebuilt expected tree, and the branch commit has exactly one parent equal to `baseline_sha`. The publisher also repairs the lifecycle labels and the single marker comment if an open pull request is reused. If a closed or merged pull request already exists for the branch, publication fails closed with no new pull request and no push. If the branch already exists with no pull request, the same tree and parent check must pass before the publisher creates the pull request without re-pushing. In that branch-exists-no-PR path, the existing commit message and author and committer name and email must exactly match the publisher-generated commit. Only author and committer timestamps may differ. Any missing branch, stale PR head, tree mismatch, parent mismatch, message mismatch, or identity mismatch fails closed. `--update` is refused in v1.

GitHub creates pull requests by branch name, not by a caller-supplied commit SHA. After PR creation, the publisher compares the returned PR `head.sha` with the commit it just published. A mismatch records a failed publish receipt and stops before label or comment updates. This detects, but does not prevent, the residual race where the branch changes between the create-only push and pull request creation.

The commit is created with git plumbing and no worktree checkout. The publisher reads the baseline tree into a temporary index, applies the integrated patch with `git apply --cached`, repeats the independent delta policy, writes the tree, and runs `git commit-tree`. Hooks, global config, system config, filters, LFS smudge, and worktree-updating git commands are disabled. Commit identity mirrors the ACA Job path: `squad-aca-bot[bot] <3362344+squad-aca-bot[bot]@users.noreply.github.com>`.

Push and fetch never use the checkout's remote configuration. They use the explicit repository URL, defaulting to `https://github.com/<owner>/<repo>.git`. The token extra header is scoped to that exact URL with `http.https://github.com/<owner>/<repo>.git.extraheader`, not to all of `github.com`. Remote git children disable redirects, disable credential helpers, disable system and global config, use a fresh empty global config file under a private per-run directory, use a fresh isolated home directory, disable terminal prompts, and point hooks at a fresh empty real directory with mode `0700`. Stale `.publish-work` hook paths and symlinked hook directories are not reused, and the per-run directory is removed after publish exits. Push uses one create-only refspec guarded by an empty `--force-with-lease=refs/heads/<branch>:` expectation, so an existing branch cannot be overwritten. If the remote branch exists with mismatched verified content, the publisher fails. The installation token is kept in memory only. The publisher deletes private key path and token environment variables after reading them, strips credential-like variables from every child process, and passes the token only through scoped git config environment variables so it never appears in argv.

The real GitHub client uses `node:https`, not `gh` or shell commands. It requests an installation token scoped to one repository with only `contents: write`, `pull_requests: write`, and `issues: write`. HTTPS responses are capped, request timeouts are enforced, invalid JSON fails closed, and API errors are bounded and redacted. Private key retrieval is PEM path only in v1 through `SQUAD_GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY_PATH`. The PEM path must be a regular file, not a symlink, no larger than 16 KiB, and parse as a private key with `crypto.createPrivateKey`. Automated Key Vault retrieval is not implemented. The manual workflow requires the PEM to be staged in a protected GitHub environment secret before publication can run.

The draft PR title, body, and issue comments strip C0 and C1 controls plus bidi and invisible formatting characters, neutralize `@` mentions and `#` references, cap lengths, and reject GitHub token-looking patterns. PR body text and issue comments also escape Markdown and HTML-sensitive characters. Label changes are limited to the ACA Job lifecycle labels from `agents/base/lib/issue-labels.sh`: `squad:processing`, `squad:queued`, and `squad:revising`.

The publisher writes `publish-result.json` by default next to the dispatcher summary. The receipt validates against `contracts/aca-sandbox/v1/schemas/publish-result.schema.json`.

UNVERIFIED:

- Live GitHub REST behavior is not exercised by tests. The request shapes are implemented from GitHub's stable REST API contract and gated behind `--live` plus `SQUAD_ENABLE_PUBLISH=1`.
- PR 8 must fetch the GitHub App private key from Key Vault or stage a PEM path before invoking the publisher.
