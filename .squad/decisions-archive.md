# Decisions (archive)

> Historical decision ledger predating the current `.squad/decisions.md` (entries through 2026-04-15). Preserved for reference; the active ledger is `.squad/decisions.md`.

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

---

## Archived from .squad/decisions.md on 2026-07-30

### 2026-04-12: Single Generic Container App Job

**Author:** Chewie (IaC Dev)  
**Status:** Implemented

**Context:** The original infra had 4 separate Container App Jobs — one per agent type (backend, frontend, tester, docs). All used the same container image but had hardcoded `AGENT_TYPE` env vars and different CPU/memory/scaling configs.

**Decision:** Replace the 4 jobs with ONE generic `squad_agent_job`. The queue message JSON contains `agent_type`, and `entrypoint.sh` parses it at runtime. This eliminates per-type infrastructure sprawl and makes adding new agent types a zero-infra-change operation.

**Changes:**
- `infra/main.tf`: Removed `local.agent_jobs` map and `module "agent_jobs"` with `for_each`. Added `module "squad_agent_job"` — single job, no `AGENT_TYPE` env var, configurable via `var.agent_job_config`.
- `infra/variables.tf`: Added `agent_job_config` object variable with cpu (default 1.0), memory (default 2Gi), max_executions (default 10), timeout_seconds (default 1800) — all with validation rules.
- `infra/outputs.tf`: Replaced `agent_job_names` map output with scalar `agent_job_name`.

**Consequences:**
- Adding new agent types requires zero Terraform changes.
- Scaling is uniform across all agent types (0–10 max executions).
- Per-type resource tuning, if needed later, moves into container logic or queue routing.

### 2026-04-12: Identity-Based Storage Auth for Function App

**Author:** Chewie (IaC Dev)  
**Status:** Implemented

**Context:** Subscription policy enforces `KeyBasedAuthenticationNotPermitted` on storage accounts. Function App's `AzureWebJobsStorage` connection string approach was blocked.

**Decision:** Switch to identity-based storage using system-assigned managed identity. Replaced `AzureWebJobsStorage` with `AzureWebJobsStorage__accountName`. Added RBAC: Blob Data Owner, Queue Data Contributor, Storage Account Contributor.

### 2026-04-12: KEDA Scaler — Managed Identity Auth

**Author:** Coordinator  
**Status:** Implemented

**Context:** KEDA azure-queue scaler used connection string secret for auth. Subscription policy blocks shared key access (`allowSharedKeyAccess=false` enforced, cannot override). KEDA never triggered because connection string was invalid.

**Decision:** Create User-Assigned Managed Identity (UAMI) for the Container App Job. Use `identity` field at the KEDA scale rule level instead of `auth[].secretRef`. Replaced AVM job module with `azapi_resource` because azurerm provider doesn't support identity-based KEDA auth. ACR image pull also switched from admin credentials to UAMI + AcrPull role.

**Changes:**
- `azurerm_user_assigned_identity.squad_agent` created with Queue Data Reader, Queue Data Contributor, AcrPull roles
- `azapi_resource.squad_agent_job` replaces `module.squad_agent_job` (AVM)
- API version: `2025-01-01`, `schema_validation_enabled = false` (azapi schema behind ARM API)
- Storage `shared_access_key_enabled = false` (honest about policy enforcement)

**Consequences:**
- KEDA triggers correctly — 14 executions detected immediately after deploy
- No shared keys or connection strings anywhere in the platform
- azapi_resource used instead of AVM module (minor drift from AVM-everywhere pattern)

### 2026-04-12: Container Self-Dequeues via Managed Identity

**Author:** Lando (Container Dev)  
**Status:** Implemented

**Decision:** Container dequeues messages from Azure Storage Queue using `az storage message get --auth-mode login` with UAMI. Requires `az login --identity --client-id` before queue operations. Messages are deleted after parsing to prevent reprocessing. Empty queue = clean exit (exit 0).

### 2026-04-12: SquadStorage Connection for Queue Output Binding

**Author:** Bodhi (Function Dev)  
**Status:** Implemented

**Decision:** Function App queue output binding uses `connection="SquadStorage"` with `SquadStorage__queueServiceUri` app setting for identity-based auth, decoupled from host runtime's `AzureWebJobsStorage`.

### 2026-04-13: Replace squad-cli with gh CLI Workflow

**Author:** Lando (Container Dev)  
**Status:** Implemented

**Decision:** Removed `@bradygaster/squad-cli` from container. Entrypoint uses `gh` CLI directly for GitHub operations (clone, PR create). Work performed by `@github/copilot` CLI in `--yolo` mode.

### 2026-04-13: Copilot CLI --yolo with Graceful Fallback

**Author:** Lando (Container Dev)  
**Status:** Implemented

**Decision:** Container runs `copilot --yolo` for AI coding. If Copilot fails, falls back to a diagnostic work artifact so the PR pipeline always completes. Container is ephemeral/isolated — yolo mode is safe.

### 2026-04-14: `/squad revise` PR Feedback Loop

**Author:** Lando (Container Dev)  
**Status:** Implemented

**Context:** After Squad creates a PR, reviewers need a way to request targeted revisions without manually editing bot-owned branches. The existing pipeline only supports new-issue → PR creation; there's no feedback loop for iterating on review comments.

**Decision:** Add a `/squad revise` command that triggers from PR comments. A new GitHub Actions workflow (`squad-revise.yml`) collects review feedback, validates guards (branch pattern, bot authorship, write access, no concurrent revisions), and enqueues a `type: "revise"` message to the same Azure Storage Queue. The entrypoint dispatches on `MSG_TYPE`: "revise" checks out the existing branch, validates HEAD hasn't moved (stale check), builds a revision prompt with inline review comments + diff context, runs Copilot CLI, pushes additive commits (no force-push), comments results on the PR, and removes the `squad:revising` label. The existing "new" flow is unchanged.

**Changes:**
- `agents/workflows/squad-revise.yml`: New workflow template — `issue_comment` trigger, 6 guards, OIDC queue auth, feedback collection, acknowledgement comment.
- `agents/base/entrypoint.sh`: `MSG_TYPE` dispatch (if/else) wrapping existing flow. Revision flow shares auth and Copilot invocation but skips dedup, branch creation, and PR creation.

**Consequences:**
- Reviewers can iterate on bot PRs without leaving GitHub — just comment `/squad revise`.
- `squad:revising` label prevents concurrent revision races.
- Stale-SHA check prevents revisions on moved branches.
- Existing new-issue flow is structurally identical (wrapped in else branch).

### 2026-04-13: GitHub Provider for Actions Variables

**Author:** Chewie (IaC Dev)  
**Status:** Implemented

**Context:** The `squad-queue.yml` workflow needs 5 GitHub Actions repository variables on each target repo (client ID, tenant ID, subscription ID, storage account, queue name).

**Decision:** Added `integrations/github ~>6.0` Terraform provider to manage GitHub Actions variables as IaC using existing `var.github_token` (fine-grained PAT). Owner derived from first entry in `var.target_repos`. All 5 variables created per repo using `for_each`.

**Consequences:**
- GitHub Actions variables now Terraform-managed — no manual steps for new target repos
- Adding new target repo to `var.target_repos` automatically provisions OIDC federated credential AND 5 workflow variables
- Provider assumes all target repos share same owner (multi-owner support would require provider aliasing)

### 2026-04-13: Key Vault + GitHub App Auth for Container Job

**Author:** Chewie (IaC Dev)  
**Status:** Implemented

**Context:** Wedge's architecture decision (wedge-github-app-auth.md) calls for replacing PAT-based container auth with GitHub App auth, storing private key in Azure Key Vault with UAMI-based access.

**Decision:** Implemented Phase 2 (Infrastructure) of Wedge's plan:
1. **Key Vault** (`azurerm_key_vault.squad`): RBAC-only, purge protection off (dev), standard SKU
2. **RBAC**: UAMI gets `Key Vault Secrets User` (runtime read), deployer gets `Key Vault Secrets Officer` (TF upload)
3. **Secret**: `github-app-private-key` stored via `azurerm_key_vault_secret`
4. **Container Job**: Removed `github-token` secret and `GITHUB_TOKEN` secretRef; added `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `KEY_VAULT_NAME`, `KEY_VAULT_SECRET_NAME` as plain env vars
5. **`var.github_token` kept**: Still used by GitHub Terraform provider and Function App

**Notes:**
- Used `rbac_authorization_enabled` instead of deprecated `enable_rbac_authorization`
- `terraform validate` passes clean
- Lando still needs to update `entrypoint.sh` (Phase 3) with JWT → installation token flow

### 2026-04-13: GitHub App Authentication Architecture

**Author:** Wedge (Lead)  
**Status:** Proposed

**Context:** Current fine-grained PAT authentication creates PRs under human user's identity, preventing owner from reviewing own agent-created PRs.

**Decision:** Replace fine-grained PAT with GitHub App ("squad-bot") that:
- Creates PRs as `squad-bot[bot]`, enabling human review
- Generates short-lived installation tokens (1hr expiry, auto-rotated)
- Stores private key in Azure Key Vault (UAMI with MI auth)
- Works seamlessly with `gh` CLI and `git push`

**Key Architecture Decisions:**
1. **GitHub App Creation:** MANUAL ONE-TIME SETUP (Terraform GitHub provider cannot create Apps, only manage installations)
2. **Key Storage:** Azure Key Vault + UAMI Auth (PEM as secret, RBAC via Secrets User role)
3. **Entrypoint Changes:** JWT → Installation Token Flow (before git/gh operations)
4. **Terraform Variables:** Replace `github_token` with `github_app_id`, `github_app_installation_id`, `github_app_private_key_pem`
5. **Workflow Impact:** No workflow changes required; keep using `${{ github.token }}`

**Implementation Phases:**
- Phase 1: Manual GitHub App setup (owner creates App via UI, generates PEM, provides App ID/Installation ID)
- Phase 2: Infrastructure — Chewie implements Key Vault, RBAC, container env vars ✅ DONE
- Phase 3: Container entrypoint — Lando updates `entrypoint.sh` with JWT generation + token exchange
- Phase 4: Validation — test issue → verify PEM retrieval → verify JWT → verify token exchange → verify PR creation as bot

**Consequences:**
- Positive: PRs appear as bot identity, human can review; short-lived tokens reduce risk; PEM in Key Vault; UAMI auth; auto-rotation via ephemeral containers
- Negative: Manual App creation (not automatable); slightly complex entrypoint; requires `openssl` in container
- Neutral: Workflows unchanged; one App for all agent types

### 2026-04-14: Open-Source Readiness for squad-on-aca

**Author:** Wedge (Lead)  
**Status:** In Progress

**Context:** Haflidi requested comprehensive OSS readiness audit to prepare squad-on-aca for public GitHub publication.

**Audit Findings Summary:**
- Secrets & Sensitive Data: ❌ BLOCKER (.pem and tfstate need .gitignore)
- LICENSE: ✅ MIT valid
- README: ✅ Blog-worthy
- Documentation: ✅ Ready (with 3 missing governance files)
- Code Quality: ✅ Production-ready
- .squad/ directory: ⚠️ Needs decision
- GitHub Actions: ✅ OIDC, no secrets
- Terraform: ✅ Parameterized (verify no tfstate in history)
- Container/Function: ✅ Portable, secure
- Blog-Worthiness: ✅ HIGH IMPACT ($6 vs $72 cost hook)

**Critical Issues (Must Fix):**
1. `.pem` not in .gitignore — add immediately; rotate key after
2. `terraform.tfstate*` not in .gitignore — verify already there
3. Potential tfstate in git history — run `git log --full-history -- "*.tfstate"` to verify clean

**Approved Actions:**
1. Fix secrets: Add `.pem` to .gitignore, verify tfstate ignored, check git history
2. Create governance: CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md
3. Squad directory: Keep `.squad/` in repo as showcase (user directive)
4. Blog support: Save OSS_READINESS_AUDIT.md in repo root for reference

**Why This Matters:**
- Blog hook: "How we built a production AI agent platform on Azure for $6/month instead of $72"
- Unique angle: Squad + Container App Jobs + cost-effective + no secrets
- Audience: DevOps/SRE, AI/ML, GitHub community

**Timeline:**
- Immediately: Fix secrets (.gitignore, rotate key)
- Before announce (1–2 hours): Create governance files
- Before blog: Verify tfstate history, write post
- After publish: Monitor issues/PRs

**Success Criteria:**
✅ No secrets in public repo  
✅ All governance files present  
✅ .squad/ included as showcase  
✅ Blog post published (optional)  
✅ Ready for community contributions

### 2026-04-15T14:32Z: Retire Bodhi (Function Dev)
**By:** Haflidi Fridthjofsson (via Coordinator)
**What:** Bodhi retired from the squad — Function App was removed from the project, role no longer needed.
**Why:** The timer-based Azure Function poller was superseded by GitHub Actions workflows (squad-queue.yml, squad-revise.yml). No function code remains in the repo.
