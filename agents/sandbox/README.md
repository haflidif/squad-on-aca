# Persona sandbox worker

This image runs a single `persona.dispatch` envelope inside an ACA Sandbox. It is
not the legacy ACA Job worker and must not publish to GitHub.

## Inputs

The trusted dispatcher supplies:

- `SQUAD_PERSONA_DISPATCH_PATH` or the first runner argument: path to the
  `persona.dispatch` JSON envelope.
- `SQUAD_SOURCE_REPO_PATH`: a pre-staged repository working copy whose `HEAD`
  must already equal the envelope `baseline_sha`.
- `SQUAD_OUTPUT_DIR`: output directory for `persona-result.json`,
  `artifact-manifest.json`, logs, and the audit patch.
- `SQUAD_COPILOT_TOKEN` or `COPILOT_TOKEN`: the Copilot credential delivered by
  the dispatcher through the exec bootstrap stdin payload. The runner reads it
  into a non-exported shell variable at startup, immediately unsets the exported
  credential variables, and never places it in `runuser`, `setpriv`, `env`, or
  Copilot argv.
- `SQUAD_COPILOT_BIN`: optional test override for the Copilot CLI binary.
- `max_ai_credits` in the dispatch envelope and runner-only
  `SQUAD_COPILOT_MAX_AI_CREDITS`: per-persona soft AI-credit limit. If both are
  supplied, they must agree. Omission defaults to **30**. Values must be safe
  integers at least 30, the minimum supported by pinned Copilot CLI **1.0.96**.
  Invalid or conflicting values fail before cloning or invoking Copilot.

Every persona invocation uses the fixed argv
`--yolo --agent squad --max-ai-credits 30` (or the explicitly validated numeric
limit). No free-form Copilot option string is accepted or shell-split.
This is a **soft AI-credit limit**, not a hard USD or billing cap; an in-flight
request can exceed it. It applies separately to each persona, not the whole
fan-out. Integration does not invoke Copilot and receives no credit setting.
The image build checks both CLI version and presence of `--max-ai-credits`.

## Repository acquisition

PR 4 uses a dispatcher-pre-staged repository as the primary source mechanism.
The runner clones that local path with `--no-hardlinks`, removes the clone
remote, then verifies `git rev-parse HEAD` equals the dispatch `baseline_sha`.
A mismatch writes failed result artifacts and exits nonzero before Copilot runs.

## Path boundary

The dispatch envelope `owned_paths` field is required by the runner. Each value
is treated as an exact file path or segment-aware directory prefix. `src`
matches `src/file.txt`, but not `src-other/file.txt`. Values ending in `/**`
are treated as the same directory prefix. After Copilot exits, the runner checks
`git diff --no-renames -z --name-only` against the baseline so rename sources,
rename destinations, additions, modifications, and deletions are all validated.
It also checks non-ignored and ignored untracked files. A persona-created
ignored file outside `owned_paths` is a violation. Ignored files inside
`owned_paths` are reported in `logs/ignored-untracked.txt` and excluded from the
patch.

The runner fails closed if any changed or untracked path is outside
`owned_paths` or touches protected paths:

- `.squad/**`
- `.github/workflows/**`

The patch is retained for audit after ownership failures, but never when
credential leakage is detected.

## Symlink and credential boundaries

Before and after Copilot runs, the runner scans the working tree for symlinks,
including tracked, untracked, and ignored entries. It fails closed if any
symlink resolves outside the repository root. If a changed path is itself a
symlink, its target must resolve inside the repository and inside `owned_paths`.
This is defense in depth. The primary filesystem boundary remains the ACA
Sandbox isolation model: read-only mounts outside the workspace and no ambient
write credentials in the persona environment.

The runner writes logs, patch, result, manifest, ignored path reports, and other
outputs to a private staged artifact directory first. After every artifact is
written, it scans the full staged tree, including file names and path-derived
messages, for the injected token value and common GitHub token prefixes. Only a
clean staged tree is moved to `SQUAD_OUTPUT_DIR`. The Copilot process receives a minimal explicit environment: `PATH`, a
persona-only `HOME` and `XDG_CONFIG_HOME` on verified `/dev/shm` tmpfs, the
public package-cache path `COPILOT_PKG_CACHE_HOME` on the sandbox disk,
`COPILOT_AUTO_UPDATE=false`, `LANG`, `TERM`, and the scoped `GITHUB_TOKEN`.
Runner paths such as `SQUAD_OUTPUT_DIR`, staging paths, source repository paths,
and dispatcher paths are not inherited by Copilot. The package cache contains
only the CLI's extracted public package; it does not contain credentials,
Copilot configuration, or a user home.

The image removes group and other write permissions from the copied runtime
and contracts, including Windows-derived file modes. The root-owned runner
cannot be modified by the unprivileged Copilot UID.

`SQUAD_OUTPUT_DIR` must be empty before the runner starts. The runner also checks
that it is still empty immediately before publishing staged artifacts. If
anything appears there, the directory is cleared and only a minimal failed result
and manifest with `output_tampered` are published. If credential material appears
anywhere, the staged tree is discarded and the output directory receives only a
minimal failed result and manifest with `credential_leak`; no patch, logs, or
persona-derived paths are emitted. Logs are still redacted for normal display,
but this final fail-closed gate wins.

The Copilot process receives its token through file descriptor 3. The runner
opens the descriptor from an anonymous pipe, starts a small
`copilot-launch.sh` wrapper with the minimal non-secret environment, and the
wrapper reads fd 3, closes it, exports `GITHUB_TOKEN`, and execs Copilot. This
keeps the token out of process argv while still giving Copilot the environment
variable it requires.

PR 5 closes the same-UID follow-up for the container image. The image creates a
separate `copilot-agent` user and the runner, when started as root, keeps the
staging and output directories owned by the runner side with mode `700` while
running Copilot with `runuser` or `setpriv`. The worktree and persona home are
owned by `copilot-agent`, so Copilot can edit source but cannot read or write
the runner artifact directories. The runner records the mode in
`logs/isolation-mode.txt`. When running under root, the runner scopes Git
invocations on the `copilot-agent`-owned worktree and source directory with
exact `-c safe.directory` flags so privileged Git operations (`rev-parse`, `add`,
`diff`, `ls-files`) succeed without modifying global configuration or
permitting wildcard directory trust.

Local tests that do not run as root or do not have the `copilot-agent` user use
an explicit `same-user` mode and assert that marker. That path is for offline
developer validation only. The container path is the intended artifact boundary.
The dispatcher, not the persona process, downloads and verifies final artifacts
after the runner exits.

## Build context

Build the persona worker from the repository root, not from `agents/sandbox`:

```bash
docker build -f agents/sandbox/Dockerfile -t squad-persona-sandbox:local .
```

The Dockerfile-specific ignore file at `agents/sandbox/Dockerfile.dockerignore`
keeps the root build context narrow. It includes only the sandbox runtime files
and the required ACA sandbox contract tool copied into
`/opt/squad/contracts/aca-sandbox/v1/`. Do not use the legacy
`docker build agents/sandbox` form, because runtime contract dependencies live
outside that directory.

### Credit-bounded image release (2026-10-13)

- Immutable image:
  `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:4b4a2c0ac696630e17a2ec06241aafa2b6ddb3ed57e7385d7d71a4dcfa84c23d`.
- Unique tag: `runner-creditcap-1-0-96-20261013T121607Z-03ce4f75324f`.
- Dirty build-source manifest SHA-256:
  `03ce4f75324f0972427d47e4569cfd09e3477330b41eefad005cf2f80edac90f`.
- Copilot CLI: **1.0.96**, with actual version and `--max-ai-credits` support
  verified. Actual production argv capture is
  `["--yolo","--agent","squad","--max-ai-credits","30"]`.
- Digest-bound proofs pass as root and UID 10001, including credential isolation,
  tmpfs credential HOME, disk package cache, leak/protected-path failure,
  applicable integration output and all **21** runtime/contract file hashes.
- Targeted Linux suite: **125 passed, 0 failed, 2 separately covered skips**;
  dedicated root Git test: **1/1**; host contract/auth/bootstrap/credit/local
  preflight/Dockerfile suite: **49/49**.

The release validates image publication only. It runs no live AI or cloud
sandbox, changes no infrastructure/RBAC, and does not validate the broader
deployment plan. The previous image without credit passthrough is not this
release. Use the scoped `.azure\image-release-scope` proof for release details.

### Pinned Copilot CLI release

The build stage downloads GitHub Copilot CLI `v1.0.96` from the official
`github/copilot-cli` release and verifies the Linux x64 archive against its
published SHA-256 checksum before extracting it. The build also checks the
installed CLI version. It does not install packages from npm.


## Integration runner

The same image also contains `runner/integrate-run.sh` for PR 6 integration. It
does not run Copilot and must not receive credentials. The dispatcher supplies
an `integration.dispatch` envelope, the baseline git bundle, and verified persona
patch files.

The runner installs its cleanup trap before creating work directories, verifies
the cloned bundle `HEAD` equals `baseline_sha`, requires a clean tree, applies
each patch with `git apply --check` followed by `git apply --index`, and keeps
3-way application off unless the envelope explicitly sets `allow_3way` to
`"true"`. It rechecks changed paths against each task's `owned_paths`, rejects
protected paths, and rejects any path touched by more than one patch.

Path validation is based on the index delta between `git write-tree` snapshots
taken immediately before and after each persona patch is applied. The runner
uses `--no-renames` for that delta, so rename sources, rename destinations,
deletions, additions, and mode-only changes are all checked against ownership.
Integration rejects symlink mode `120000`, gitlink mode `160000`, any `.git/**`
path, and executable-bit additions by default. A task must explicitly set
`allow_executable_bits: "true"` in the integration dispatch before an executable
mode addition is accepted.

Optional checks are argv arrays, never shell strings. They run with a minimal
allowlisted environment, a timeout, and captured output. Before checks run, the
runner writes `patches/integrated.patch`, records its sha256, snapshots the
source index tree, fingerprints every source worktree file, and fingerprints
`.git/config`, `.git/hooks/**`, and `.git/info/**`. Each check then runs in a
fresh materialized copy of that tree with no `.git` directory. Edits in the
copy are allowed and cannot change the emitted patch. If a check somehow writes
back to the source tree or source git metadata, the post-check verification
fails with `checks_mutated_tree`.
Check stdout and stderr may be truncated in result logs and then set
`truncated: true`.

Repositories with symlinks or gitlinks anywhere in the integrated tree cannot
use integration check commands in v1. The runner lists the complete tree before
materializing any check copy and fails with `check_tree_contains_symlink` if it
finds mode `120000` or `160000`. A second lstat walk after materialization is a
defense-in-depth guard against unexpected symlinks in the throwaway copy. If no
check commands are configured, no check tree is materialized and an unchanged
baseline symlink does not block integration.

Git plumbing output uses a separate large capture limit. The integrated patch is
streamed to disk and hashing is done from the file. If patch output, path lists,
or other plumbing output exceed `SQUAD_INTEGRATION_MAX_PLUMBING_BYTES`, the
runner fails closed with `output_limit_exceeded` instead of silently truncating.
The limit must be a positive integer and is capped at 268435456 bytes.
The shell wrapper creates exact temporary directories with `mktemp -d` and its
trap removes only those recorded paths, never a glob of sibling directories.

Check timeouts terminate the whole process tree. Linux CI for the sandbox image
must set `SQUAD_REQUIRE_PROCESS_TREE_KILL_TEST=1` so a missing process-tree
kill mechanism fails validation instead of being reported as a local skip.
