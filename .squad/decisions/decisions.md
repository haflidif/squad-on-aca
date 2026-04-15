# Decisions

# Decision: Remove Function App Infrastructure

**Author:** Chewie (IaC Dev)  
**Status:** Implemented  
**Date:** 2026-04-14

**Context:** The Function App (timer-triggered issue poller) was the original mechanism for detecting new GitHub issues and enqueuing work to the Storage Queue. This has been fully replaced by GitHub Actions workflows (`squad-queue.yml` and `squad-revise.yml`) that authenticate via OIDC and push messages directly to the queue — no intermediate Azure compute needed.

**Decision:** Remove all Function App infrastructure from `infra/main.tf`:
1. `module "function_service_plan"` — Consumption (Y1) App Service Plan
2. `module "function_app"` — Python 3.11 Function App with timer trigger
3. Three `azurerm_role_assignment` resources granting the Function App's system-assigned managed identity access to the Storage Account (Blob Data Owner, Queue Data Contributor, Storage Account Contributor)
4. `function_app_name` output from `outputs.tf`
5. Updated `github_token` variable description — no longer used for issue polling, only for Terraform GitHub provider

**What was preserved:**
- Storage Account and Queue — still used by GitHub Actions (enqueue) and KEDA/Container App Job (dequeue)
- `var.github_token` — still required by the `integrations/github` Terraform provider for managing Actions variables
- All UAMI resources and RBAC — used by Container App Job and KEDA scaler

**Consequences:**
- Eliminates ~$0/month (Consumption plan was near-free) but removes unused infrastructure surface area
- One fewer AVM module dependency (`avm-res-web-serverfarm`, `avm-res-web-site`)
- Simplifies the Terraform state and reduces plan/apply time
- The `function/` source directory still exists but is now dead code (separate cleanup)

---

# Decision: OIDC Federated Identity Credentials for GitHub Actions

**Author:** Chewie (IaC Dev)  
**Status:** Implemented  
**Date:** 2026-04-13

**Context:** GitHub Actions workflows in target repositories need to push messages to the Azure Storage Queue to trigger squad agent jobs. Previously this would require storing Azure credentials as GitHub secrets.

**Decision:** Add `azurerm_federated_identity_credential` resources on the existing UAMI (`squad_agent`) using OIDC federation with GitHub Actions. Each target repo gets a federated credential with subject `repo:{owner/repo}:ref:refs/heads/main`. The UAMI already has `Storage Queue Data Contributor` on the storage account, so no additional RBAC is needed. New variable `target_repos` (list of `owner/repo` strings) controls which repos are authorized.

**Changes:**
- `infra/variables.tf`: Added `target_repos` variable
- `infra/main.tf`: Added `azurerm_federated_identity_credential.github_actions` with `for_each`
- `infra/outputs.tf`: Added `squad_agent_client_id` and `squad_agent_tenant_id` outputs

**Consequences:**
- Zero secrets needed in GitHub repos — workflows use `azure/login` with OIDC
- Subject scoped to `refs/heads/main` — only workflows running on the default branch can authenticate (issue-triggered workflows run on default branch, so this works)
- Adding a new repo is a single entry in `target_repos`

---

# Decision: Replace Azure Function with GitHub Actions Workflow

**Author:** Bodhi (Function Dev)
**Date:** 2026-04-13
**Status:** Implemented

**Context:** The timer-triggered Azure Function (`function/`) was the intended bridge from GitHub issues to Azure Storage Queue. It never fully worked in production due to:

1. **Consumption plan + identity-based storage** — The `AzureWebJobsStorage` identity-based connection was blocked by subscription policy (`KeyBasedAuthenticationNotPermitted`), and the workaround (`AzureWebJobsStorage__accountName`) was fragile on the Consumption plan.
2. **Polling model** — Timer triggers poll every N minutes, adding latency. GitHub issues are event-driven — we should react to them, not poll for them.
3. **GitHub PAT** — The Function App needed a GitHub PAT stored as an app setting. This is a secret that needs rotation.

**Decision:** Replace the Azure Function with a GitHub Actions workflow template (`agents/workflows/squad-queue.yml`). Target repos copy this into `.github/workflows/`.

**Key design choices:**

- **OIDC federated credentials** — `azure/login@v2` exchanges a GitHub OIDC token for an Azure access token. No secrets stored anywhere.
- **Event-driven** — Fires instantly when a `squad:*` label is added to an issue. No polling delay.
- **Two-layer dedup** — Adding `squad:processing` itself triggers another `labeled` event. The workflow catches this with: (1) direct label name check, (2) existing label check on the issue.
- **Same queue message schema** — `{issue_number, agent_type, repo, title}` — no changes to entrypoint.sh needed.

**Consequences:**

- The `function/` directory and its Azure Function App infra can be retired (separate task — coordinate with Chewie).
- Each target repo needs: (a) the workflow file, (b) 5 repository variables, (c) a federated credential on the UAMI.
- UAMI needs `Storage Queue Data Message Sender` role (likely already covered by existing `Queue Data Contributor`).
- Latency drops from minutes (timer poll) to seconds (event trigger).

---

# Decision: Container Dedup Logic for Issue Processing

**Author:** Lando (Container Dev)
**Status:** Implemented
**Date:** 2026-04-13

**Context:** KEDA can trigger multiple container instances for the same queue message (race conditions, redelivery). Without dedup, two containers could clone the same repo, work the same issue, and create conflicting PRs.

**Decision:** Added four dedup gates to `entrypoint.sh` after GitHub auth:
1. **Label gate** — Check `squad:processing` label presence
2. **Queued check** — Detect `squad:queued` (already done)
3. **Existing PR search** — Branch-name regex matching (precise)
4. **Remote branch check** — Detect `squad/*` remote branches (race window)

On successful PR creation, labels swap: `squad:processing` → `squad:queued`. When dedup detects an existing PR, labels are auto-corrected to match state.

**Consequences:**

- Duplicate work is prevented at four layers (label, queue state, PR, branch).
- All dedup operations are non-fatal — failures log warnings but don't kill the container.
- The label lifecycle (`squad:processing` → `squad:queued`) gives visibility into pipeline state from the GitHub Issues UI.
- The GitHub Actions workflow that enqueues messages should skip issues that already have `squad:processing` or `squad:queued` labels.

---

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

