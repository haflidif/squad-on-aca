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
4. A persona returns a `persona.result` and artifact references. A future
   integrator combines those results into an `integration.result`.

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
