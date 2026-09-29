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
clean staged tree is moved to `SQUAD_OUTPUT_DIR`. The Copilot process receives a
minimal explicit environment: `PATH`, a persona-only `HOME`, `LANG`, `TERM`, and
the scoped `GITHUB_TOKEN`. Runner paths such as `SQUAD_OUTPUT_DIR`, staging
paths, source repository paths, and dispatcher paths are not inherited by
Copilot.

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
`logs/isolation-mode.txt`.

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

### npm registry on managed build hosts

The build stage installs `@github/copilot` from the `NPM_REGISTRY` build arg,
which defaults to the public `https://registry.npmjs.org/`. CI uses that default.

Docker builds do not inherit the host npm configuration (`.npmrc`, global or
user config, or environment). On a managed machine where the public npm registry
is blocked, pass your organization's approved internal mirror explicitly:

```bash
docker build -f agents/sandbox/Dockerfile \
  --build-arg NPM_REGISTRY=https://<approved-internal-npm-mirror>/ \
  -t squad-persona-sandbox:local .
```

Use the full registry URL including any path segment, exactly as reported by
`npm config get registry` on the host. A bare host name can return 404.

Only use this for a mirror that serves public packages without authentication.
Do not put auth tokens, passwords, or credentials in the URL, and do not pass
npm auth through build args or build secrets for this image. Build arg values
are recorded in build metadata. Before `npm install` runs, the build stage
executes `agents/sandbox/build/validate-npm-registry.js`, which rejects
non-`https://` values, `@` userinfo, query strings (for example `?token=`),
fragments and malformed URLs without printing the value. TLS verification stays
enabled; do not disable `strict-ssl` to work around mirror certificate issues.


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
