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
