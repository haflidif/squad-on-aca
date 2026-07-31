# Decision: opt-in job execution assertion and teardown-always pattern

**Date:** 2026-07-31
**Author:** Cassian (Tester)
**Issue:** #9 — azd/Bicep support
**Status:** Accepted

---

## Context

Implementing e2e testing tooling for the azd/Bicep deployment path (issue #9). Two key design choices required decisions:
1. Whether to automatically trigger a live Container App Job execution as part of the smoke test.
2. How to guarantee teardown runs even when smoke tests fail.

---

## Decisions made

### 1. Job execution assertion is OPT-IN

**Decision:** The `--run-job` / `-RunJob` flag must be explicitly passed to trigger a job execution. It is off by default.

**Rationale:**
- Job executions consume Azure Container App Job minutes and may queue work items.
- The execution requires Key Vault secrets (`github-app-private-key`, `copilot-pat`) to be uploaded manually — a step that happens after provision but is not automated in the e2e loop.
- A fresh deploy has no real work items in the queue, so a triggered execution tests cold-start behavior only, not real processing.
- Most smoke-test runs (e.g., quick iteration on infra changes) don't need the cost or the dependency on out-of-band secret upload.

**When to use `--run-job`:** Deliberately, after secrets are uploaded, to validate the full agent startup path.

---

### 2. Teardown always runs (trap / try-finally pattern)

**Decision:** `azd down --force --purge` runs unconditionally at script exit, whether smoke tests pass, fail, or the script is interrupted. Implemented via `trap teardown EXIT INT TERM` (bash) and `try/finally` (PowerShell).

**Rationale:**
- Orphaned Azure resources incur ongoing charges.
- A failed smoke test should not leave a provisioned stack running.
- Debug mode is available via `--skip-teardown` / `-SkipTeardown` for engineers who need to inspect a failed deploy.

**`--purge` by default:** Key Vault uses soft-delete. Without `--purge`, the vault name is reserved for the soft-delete retention period (7 days by default), blocking reuse of the same environment name. For ephemeral test loops, immediate purge is the right default. Use `--no-purge` / `-NoPurge` if soft-delete retention is required.

---

## Alternatives considered

- **Always run job execution:** Rejected — too expensive and fragile for routine smoke tests.
- **Teardown only on success:** Rejected — leaves orphaned resources on failure, the worst-case outcome.
- **Teardown as a separate script step:** Rejected — a `finally`/trap is safer because it handles script interruption (Ctrl+C, CI cancellation).
