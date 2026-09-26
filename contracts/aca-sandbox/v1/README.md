# ACA Sandbox contracts v1

These contracts define the data exchanged by the planned coordinator, persona
dispatch, artifact, provider, and integration boundaries. They are contracts
only. PR 1 does not provision sandboxes, dispatch workers, apply patches, or
publish to GitHub.

## Contract lifecycle

1. Squad initialization resolves the current roster. The coordinator records a
   stable logical member ID, the resolved persistent name, the charter
   reference, required capabilities, and the roster revision and hash.
2. The coordinator creates an execution plan from the repository baseline SHA.
   Every task has an owner, dependencies, provider, schema version, and
   `owned_paths`.
3. A future dispatcher will convert each plan task into a
   `persona.dispatch` envelope. Consumers must reject a dispatch whose baseline
   or roster snapshot does not match the execution context. Persona dispatch
   envelopes must carry `owned_paths`, which the sandbox worker treats as exact
   file paths or segment-aware directory prefixes for fail-closed patch
   enforcement. A dispatch path must be equal to or narrower than the matching
   task ownership path in the coordinator execution plan.
4. A persona returns a `persona.result` and artifact references.
5. The dispatcher sends verified persona patch artifacts to a separate
   `integration.dispatch` envelope. The integration sandbox applies patches in
   dependency and task ID order, then returns an `integration.result` plus an
   artifact manifest for the integrated patch.
6. A trusted-host publisher consumes a succeeded `dispatcher.summary`,
   revalidates the integrated patch, creates one deterministic branch and
   commit from the baseline, opens one draft pull request, updates lifecycle
   labels, comments on the issue, and writes a `publish.result` receipt.

## Compatibility guarantee

The existing ACA Job queue message remains valid with only these required
fields:

```json
{
  "issue_number": 42,
  "agent_type": "example-agent",
  "repo": "example-owner/example-repo",
  "title": "Illustrative legacy ACA Job task"
}
```

The queue schema uses explicit variants:

- **Legacy ACA Job**: exactly the four fields currently emitted.
- **Revision**: the existing `type: "revise"` payload and its revision fields.
- **Provider-extended fan-out**: `type: "fanout"` with a structured provider
  object, task identity, baseline SHA, and complete roster snapshot.

The legacy `agent_type` field remains for compatibility and is treated as an
opaque legacy routing value. New fan-out contracts never use it as an identity.
They carry a stable logical member ID, resolved persistent name, charter
reference, membership kind, capabilities, and roster revision/hash.

Squad built-ins such as Coordinator, Scribe, Ralph, Rai, and optional
`@copilot` are represented in a roster snapshot as `function` or `system`
members. They are not assumed to be project personas and are not encoded by
name in these schemas.

## Provider boundary

Provider details are represented by an opaque provider ID, kind, contract
version, and optional configuration reference. A provider owns execution
mechanics and limits. Coordinator and persona contracts carry provider identity
but do not embed ACA provisioning or worker implementation details.

## Dynamic roster resolution

Schemas intentionally contain no cast names, fixed roles, or team-size limits.
Logical member IDs and resolved names are values supplied by Squad
initialization. `charter_ref`, `membership`, `capabilities`, and the roster
revision/hash make the resolution auditable and prevent a later roster change
from silently changing task ownership. Validation additionally checks unique
task IDs, owner identity, capability coverage, provider consistency, baseline
consistency, acyclic dependencies, and non-overlapping task ownership.

## Path ownership semantics

`owned_paths` are repository-relative path scopes. A scope matches the exact
path or a segment-aware descendant path: `src` matches `src/file.txt` and
`src/nested/file.txt`, but does not match `src-other/file.txt`. A trailing slash
or `/**` has the same meaning as the directory prefix without changing segment
boundaries.

Validation rejects absolute paths, any `..` path segment, overlapping task
ownership in one execution plan, and any scope that overlaps protected paths:

- `.squad/**`
- `.github/workflows/**`

Ignored untracked files are part of ownership validation. A persona-created
ignored file outside `owned_paths` is a violation. Ignored files inside
`owned_paths` are reported as artifacts by the sandbox runner and excluded from
the patch because Git intentionally omits ignored content from normal diffs.

## Validation

The validator uses only Node.js built-ins and checks JSON Schema constraints
plus cross-task invariants such as unknown dependencies, dependency cycles, and
fan-out context requirements:

```text
node contracts/aca-sandbox/v1/tools/validate.js \
  coordinator-execution.schema.json \
  contracts/aca-sandbox/v1/fixtures/dynamic-multi-agent-execution.example.json
node --test contracts/aca-sandbox/v1/test/*.test.js
```

The fixture names and values are illustrative and are not normative roster
entries.


## Integration dispatch

`integration-dispatch.schema.json` is additive in v1. It carries the run
context, ordered task patch references, task ownership, dependencies, an
`allow_3way` flag encoded as `"true"` or `"false"`, and optional check commands.
Check commands are argv arrays only. Shell strings are rejected so the runner can
execute them without a shell and with an explicit minimal environment. The
default integration policy keeps 3-way patch application off because persona
owned paths are expected to be disjoint.

The integration runner validates the actual index delta for each patch by
comparing `git write-tree` snapshots before and after `git apply --index`.
Validation uses `--no-renames`, so both sides of a rename are checked against
the task's `owned_paths`. Integration rejects symlink mode `120000`, gitlink
mode `160000`, `.git/**` paths, and executable-bit additions by default. A task
can opt in to executable-bit additions with `allow_executable_bits: "true"`.

Checks run only after the integrated patch has been written and hashed. The
runner snapshots the source index tree, fingerprints every source worktree file
including ignored and untracked files, and fingerprints `.git/config`,
`.git/hooks/**`, and `.git/info/**`. Each check runs in a fresh materialized
copy of the integrated tree with no `.git` directory. Edits inside that copy do
not affect the emitted patch. Any write back to the source worktree, source
index, or source git metadata fails with `checks_mutated_tree`.

Integration check commands require an integrated tree with no symlink or gitlink
entries. Before materializing a check copy, the runner lists the full tree with
`git ls-tree -r -z --full-tree` and rejects mode `120000` or `160000` with
`check_tree_contains_symlink`. It also lstat-walks the materialized copy as a
defense-in-depth check. This restriction applies only when checks are
configured. Without check commands, the runner does not materialize a check tree
and unchanged baseline symlinks do not block integration.

Git plumbing output uses a bounded large-output policy and fails with
`output_limit_exceeded` if exceeded. `SQUAD_INTEGRATION_MAX_PLUMBING_BYTES` can
lower the bound for tests, but it must be a positive integer and cannot exceed
268435456 bytes. Check output is log data and may be truncated with
`truncated: true`. Check timeout handling must terminate the full process tree;
Linux sandbox CI should set `SQUAD_REQUIRE_PROCESS_TREE_KILL_TEST=1` to make the
process-tree kill evidence mandatory.

Dispatcher verification is independent from runner verification. It builds a
bare verification repository from the baseline bundle, disables system and
global git config, points hooks at an empty directory, disables LFS and filters,
overrides attributes with `* -text -filter -diff -merge`, and applies the
integrated and persona patches with `git apply --cached` against temporary
index files. The verifier never performs checkout, add, hash-object, or
worktree update operations. Its hardened git wrapper only allows the small
plumbing command set needed for index-only verification. It compares mode, blob
ID, and raw blob bytes for every persona-owned path and repeats the delta policy
for symlinks, gitlinks, `.git/**`, protected paths, ownership union, and
executable-bit additions.

## Publish result

`publish-result.schema.json` is additive in v1. It is a publisher receipt, not a
replacement for `dispatcher-summary.schema.json`. The dispatcher summary remains
the operational fan-out and integration receipt. The publish receipt records the
single branch, commit SHA, draft pull request number and URL, whether the
execution created or reused an existing pull request, and the lifecycle label
changes. Keeping publication output separate avoids implying that every
dispatcher run has been published.

Publisher idempotency is keyed by the deterministic publish branch. An open pull
request for that branch is returned as `idempotency: "existing"` after the
publisher rechecks the head SHA, tree, and parent, then repairs lifecycle labels
and the single marker comment if needed. A closed or merged pull request for
that branch fails closed before any push or new pull request. If the branch
exists with the matching tree and parent but no pull request, the publisher
creates the pull request without re-pushing only when the existing commit message
and author and committer name and email exactly match the publisher-generated
commit. Author and committer timestamps may differ. If the branch exists with a
different commit, publication fails closed and no successful `publish.result` is
written. Because GitHub creates pull requests by branch name, the publisher
checks the returned PR `head.sha` after creation and records a failed receipt if
the branch moved between the push and PR creation.
# Coordinator issue binding

`coordinator-execution.issue` binds a plan to `{ "repo": "owner/repository",
"issue_number": 42 }`. The repository is a strict owner/repository name and the
issue number is a positive integer. Existing v1 plans and the checked-in offline
example may omit `issue` only in fake or offline execution for backward
compatibility. A live dispatch or live publish requires the binding and rejects
any difference from its selected repository and issue. The trusted publisher
checks the binding independently, along with the plan run ID and baseline SHA,
before requesting an installation token or starting git network operations.
An offline fixture without `issue` can never be published live.
