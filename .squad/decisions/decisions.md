# Decisions

# Decision: Issue poller now requires squad:{member} label for enqueueing

**Author:** Bodhi (Function Dev)
**Date:** 2026-04-12
**Status:** Implemented

## Context

The original poller fetched issues with a generic `squad` label and enqueued ALL of them. The queue message had no `agent_type` field, so downstream jobs had no way to know which agent to run.

## Decision

The poller now only enqueues issues that have a `squad:{member}` label (e.g., `squad:chewie`). The member name becomes the `agent_type` in the queue message. Issues without a `squad:{member}` label are skipped — they haven't been triaged yet.

Queue message schema:
```json
{"issue_number": 42, "agent_type": "chewie", "repo": "haflidif/squad-on-aca", "title": "Fix auth endpoint"}
```

## Consequences

- Ralph (or a human) must apply a `squad:{member}` label before the poller will pick up an issue.
- The generic `SQUAD_LABELS` env var is no longer used; the poller fetches all open issues and filters by label pattern.
- Downstream container jobs receive `agent_type` in the message and can route accordingly via `entrypoint.sh`.


# Decision: Queue Message Parsing in Entrypoint

**Author:** Lando (Container Dev)
**Date:** 2026-04-12
**Status:** Proposed

## Context

The entrypoint script expected `AGENT_TYPE`, `GITHUB_REPO`, and `ISSUE_NUMBER` as separate env vars. With the single-job design (see decisions.md), agent_type is no longer baked into infra — it arrives in the queue message JSON.

## Decision

`entrypoint.sh` now reads a single `QUEUE_MESSAGE` env var containing JSON (`{"issue_number": N, "agent_type": "...", "repo": "owner/repo"}`), parses it with `jq`, and exports the fields. This means:

- The Azure Function dispatcher must set `QUEUE_MESSAGE` to the full JSON payload.
- `GITHUB_TOKEN` remains a separate env var (sourced from Key Vault via Container App secrets).
- No other agent-specific env vars are needed in the infra.

## Consequences

- The Function code (Chewie/R2's domain) must ensure the queue message format matches `{issue_number, agent_type, repo}`.
- Adding new fields to the message (e.g., `priority`) only requires entrypoint changes, not infra changes.

