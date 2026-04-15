# Project Context

- **Owner:** Haflidi Fridthjofsson
- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues
- **Created:** 2026-04-12

## Core Context

Agent Wedge initialized as Lead. Responsible for architecture, code review, documentation, and scope management across the squad-on-aca platform.

Key project components:
- `infra/` — Terraform infrastructure using Azure Verified Modules (ACA Environment, Container App Jobs, Storage, ACR, Function App, Log Analytics)
- `agents/` — Agent base Dockerfile with git, gh CLI, Go, Node.js, squad-cli
- `function/` — Python Azure Function (timer-triggered issue poller → Storage Queue)
- `.github/` — GitHub Actions workflows for Ralph heartbeat and event-driven triage

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
### 2026-04-15: OSS Governance Files Published
- Created **CONTRIBUTING.md** — comprehensive guide covering bug reporting, feature requests, PR workflow, local dev prerequisites (Terraform, Azure CLI, Docker, Python, GitHub CLI), code style (terraform fmt, Python black/ruff/pep8), and explicit note that .squad/ directory is Squad framework showcase and not contributor-modified.
- Created **CODE_OF_CONDUCT.md** — Contributor Covenant v2.1 with proper attribution, covering expected community behavior, unacceptable harassment, and enforcement escalation.
- Created **SECURITY.md** — Private disclosure workflows (GitHub Security Advisories preferred, email fallback), response timeline (48h), clear distinction between security issues (auth/creds/injection/misconfiguration) and regular bugs, infrastructure scope, and strict warnings about never committing secrets, subscription IDs, or .tfstate files.
- All three files align with OSS publication checklist; addresses governance gap identified in April 14 audit.

### 2026-04-12: README v2 — Single Job + Event Flow + Two-Repo Architecture
- Updated README to reflect single generic Container App Job decision (eliminated 4 hardcoded job diagram)
- Added "How It Works" section explaining 7-step event flow: issue creation → Ralph triage → Function polling → queue → KEDA scaling → agent work → Scribe logging
- Added "Two-Repo Architecture" section clarifying separation: squad-on-aca (platform) vs app repos (where agents work)
- Introduced MVP status badge to set expectations
- Kept AVM modules table and cost breakdown for reference
- Architecture diagram now shows single generic job, eliminating confusion about per-type infrastructure

### 2026-04-14: Comprehensive docs/ Folder — Adoption-Ready Documentation
- Created `docs/architecture.md` — deep architecture docs with 3 Mermaid diagrams (E2E sequence, component diagram, entrypoint flowchart), dual-auth pattern explanation, KEDA scaling model, message flow architecture, RBAC matrix, and container image architecture.
- Created `docs/thought-process.md` — 10 detailed decision rationales covering Container App Jobs vs AKS, KEDA+queue vs webhooks, GitHub App vs PAT, dual-token pattern, identity-based auth, azapi vs AVM, single generic job, self-dequeue, yolo mode, Squad agent mode, and ACR caching.
- Created `docs/limitations.md` — 13 documented limitations categorized by severity (critical/operational/minor) with mitigations: Copilot PAT dependency, runtime limits, no persistent workspace, manual secrets, Docker Hub rates, single queue, no retry, OIDC per-repo, App installation scope, Windows quirks, Squad state conflicts, branch collisions, PR body limits.
- Created `docs/adoption-guide.md` — full step-by-step guide: prerequisites checklist, GitHub App creation, Terraform configuration, infrastructure deployment, secret upload, container build, workflow installation, E2E testing, adding repos, customization, revision loop setup, troubleshooting, and cost worksheet.

### 2026-04-14: Open-Source Readiness Audit Complete
- Performed comprehensive 10-category audit: Secrets, LICENSE, README, Docs, Code Quality, .squad/ directory, GitHub Actions, Infrastructure, Container/Function code, Blog-worthiness
- **Critical findings:** .pem file and tfstate files not properly in .gitignore (risk: accidental exposure). Requires immediate rotation of GitHub App private key.
- **Status:** ⚠️ ALMOST READY — 3 critical (secrets) + 4 minor (governance) fixes needed. Estimated 1–2 hours to publish-ready.
- **Blog potential:** ⭐⭐⭐⭐⭐ (5/5). Unique angle: Squad multi-agent orchestration on serverless (/month vs  AKS). Production-grade code, transparent decisions, comprehensive docs.
- **Governance files missing:** CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md (easy to add, standard practice).
- **.squad/ directory:** Recommend curated .squad-example/ directory to showcase Squad framework without exposing team internals.
- **Strengths:** Excellent README, 8 supporting docs with architecture diagrams, parameterized Terraform (no hardcoding), identity-based auth throughout, well-reasoned code (554 lines Terraform, 184 Python, comprehensive bash entrypoint). Zero TODO/FIXME/HACK comments in production code.
- **Decision:** Approved to proceed with publication path: fix secrets, add governance files, create Squad example directory. Decision document written to .squad/decisions/inbox/wedge-oss-readiness.md.
- **Blog structure provided:** Hook on cost ( vs ), problem/solution/proof/CTA framework. Title: "Running AI Agents for /Month — Container App Jobs vs. AKS".

### 2026-04-15: Compiled Comprehensive Blog Source Material
- Created `docs/blog-source-material.md` — rich source document for Haflidi's Blog Squad to write the open-source announcement blog post / LinkedIn article.
- 10 sections covering: origin story, architecture overview, 7 detailed struggles & breakthroughs, Squad framework integration, what works well, limitations, potential, technical reference, 10 punchy callout quotes, and raw data (file inventory, decisions summary, key code links).
- Mined all project sources: README.md, 8 docs/ files, .squad/decisions.md, .squad/team.md, all 7 agent history.md files, entrypoint.sh, main.tf, function_app.py, both workflow templates.
- Angle: journey and discovery (not cost savings). Emphasis on struggles (GitHub App licensing gap, identity-based auth battles, KEDA azapi escape hatch, container self-dequeue surprise, Copilot TTY requirement, single-job simplification).
- Designed as complete raw material so Blog Squad can write a 2,000–3,000 word post without reading source code.

### 2026-04-15: Blog Source Material Updated — Function App → GitHub Actions Evolution
- Added **Struggle 8: Function App → GitHub Actions Simplification** to `docs/blog-source-material.md`.
- Documented the first approach: Python Azure Function with timer trigger, polling GitHub API every few minutes, enqueuing messages to Storage Queue via identity-based output binding. Bodhi built it — worked but added complexity.
- Captured the "why we moved away": timer-based polling delay vs event-driven instant response, infrastructure overhead (service plan + function app + 3 RBAC assignments), another moving part to maintain, policy friction with `allowSharedKeyAccess=false`.
- Detailed the replacement: `squad-queue.yml` GitHub Actions workflow triggering on `issues.labeled` event, OIDC federated auth (zero secrets), `az storage message put --auth-mode login`, zero Azure infrastructure beyond Storage Queue.
- Added the lesson: sometimes the simplest solution isn't the first one; GitHub Actions is already authenticated, event-driven, deployed at scale; "build it, learn from it, simplify it" is productive iteration.
- Added 2 new key quotes to "Key Quotes / Callout-Worthy Lines" section:
  - "We built an Azure Function to poll GitHub. Then we realized GitHub Actions was already doing the polling for us."
  - "One YAML file replaced an entire Function App, service plan, and three RBAC assignments."
- This narrative adds authenticity to the blog: shows real evolution and learning, not just "we built it perfect from day 1".

