# ACA Sandbox dispatcher

The dispatcher is the trusted PR 5 fan-out boundary. It reads a `coordinator-execution` plan, validates it with the v1 contract validator, creates one sandbox per task, stages the repository from a local git bundle at the plan baseline, runs the persona worker, downloads artifacts, runs the integration sandbox after all required persona tasks succeed, and writes `dispatcher-summary.json`.

```powershell
node dispatcher\cli.js --plan plan.json --repo . --out .dispatcher-out --client fake --concurrency 3 --auth-mode pat
```

## Opt-in issue flow

The legacy ACA Job workflow remains the default. The separate `squad-sandbox-issue.yml` workflow runs only for issues labeled `sandbox-run` when `SQUAD_ISSUE_FLOW_ENABLED` is `true`; `SQUAD_ISSUE_OPT_IN_NUMBER` can further restrict the allowed issue. A repository collaborator with write access must apply the label. The workflow runs a Lead routing stage and one to three scoped members in at most two dependency-ordered stages, integrates their changes, then publishes the validated result as a draft pull request.

Set `SQUAD_ISSUE_FLOW_ENABLED` as a repository variable to enable dispatch. Set `SQUAD_ISSUE_OPT_IN_NUMBER` as a `squad-sandbox-issue` environment variable to restrict it to one issue, and configure the ACA settings in that environment. In `squad-publish`, set `SQUAD_GITHUB_APP_ID` and `SQUAD_GITHUB_APP_INSTALLATION_ID` as variables and `SQUAD_GITHUB_APP_PRIVATE_KEY_PEM` as a secret. The flow uses `sandbox:*` lifecycle labels and `squad:<member>` routing labels; it does not run unless explicitly enabled.

### Member ownership and stages

Routing decisions may include `depends_on: ["<member id>"]` per member. Independent members run in stage 1; members depending only on independent members run in stage 2. Self-dependencies, unknown or duplicate dependencies, cycles, three-stage graphs, and overlapping owned paths are rejected. Stage 2 starts from the combined stage-1 patch, so a dependent tester can read the implementation. Final integration checks run once against the combined result. Publication uses one patch against the original baseline and credits every contributing member.

Infrastructure roles (including Infra and Terraform) may own only `examples/terraform/**` or concrete `.tf` and `.md` files beneath `examples/terraform/`; they cannot own production `infra/**`, workflow, dispatcher, scripts, or team files. Testing and documentation role detection takes precedence, so Terraform Validation & Module Tests remains testing, and Module Documentation & Examples remains documentation. Existing implementation, testing, and documentation scopes are unchanged. The example directory need not exist before routing.

The Node-only `verify-infra-files` integration check requires selected files to exist, be regular and non-empty, have balanced Terraform braces, and contain no obvious hardcoded secret assignments. It rejects symlinks and is not a substitute for `terraform validate` or deployment validation.

`issue-stages.cjs` reserves AI credits per member against one aggregate budget (the workflow allows 30 per member, 90 total). The issue report shows each member's stage. Member artifacts retain patch-only diagnostics, including member patches, per-stage combined patches, and the final combined patch, even when integration fails. Failed stages prevent dependent execution and publication. Existing opt-in gates, protected environments, and permissions remain unchanged.

## Local Windows operator path

> Local operation is the selected first execution host. No persistent GitHub
> runner, paid VM, runner registration, or OIDC trust change is required.
> **Image released, full live flow not proven:** the corrected credit-bounded
> image is published and digest-verified. See the worker's release receipt below.
> Do not use the old probe or pre-credit-limit digest as the corrected release.

From this checkout in PowerShell 7.3 or newer, run the durable read-only helper:

```powershell
.\infra\hooks\sandbox-lab-local.ps1 -PreflightOnly
```

This intentionally exits with an explicit missing-image/plan/approval blocker.
It checks installed Node 22+, Azure CLI and the absolute installed
`%USERPROFILE%\.aca\bin\aca.exe` at `1.0.0-preview.4`. It uses only the existing
isolated `%USERPROFILE%\.squad-sandbox-lab\azcfg` Azure context (override with
`-AzureConfigDir` if needed), requires its default account to be enabled in
subscription `e69b8a95-fe38-42da-b5e6-e3e0a833cf9e` and tenant
`49ff7219-653a-4644-8540-71d16dbf9c16`, and reads only the approved lab
group, pull identity, sandbox inventory and disk inventory in `swedencentral`.
It never logs in, sets an account, obtains an explicit access token, retrieves
registry/GitHub credentials, creates or deletes resources, or writes a
materialized plan or output directory. Azure CLI may maintain its own isolated
cache when making authenticated reads; the default Azure configuration stays
untouched. Missing or expired isolated login fails closed rather than repairing it.

The helper sets configuration and gates only in the current process, strips
inherited credentials/service-identity selectors from tool children, and restores
every changed environment variable on success or error (including absence).
It never reads `.env` or secret files, changes git configuration, or selects
publication. **Preflight does not check a Copilot token or prove image contents,
token entitlement, RBAC sufficiency for writes, or the full live dispatcher flow.**

### First real task prerequisites

1. Select the corrected immutable credit-bounded runner image. The scoped
   `.azure\image-release-scope` AZCLI validation/publication plan validates image
   publication only, not the broader deployment. The released digest is recorded
   in `agents\sandbox\README.md`; use that receipt rather than a mutable tag or
   the pre-credit-limit image. The known old `cea1d310…` probe image is rejected
   by this helper.
2. Use a reviewed **lab repository checkout**, not this personal repository.
   Its `origin` must identify `AzureViking/squad-on-aca-sandbox-lab` without
   credentials. Place a schema-valid single-persona plan inside that checkout,
   with the actual checked-out baseline SHA (no `$CHECKED_OUT_SHA` template),
   roster-derived owner, bounded owned paths, and exact selected lab repo/issue
   binding. Dirty working-tree edits are not included in the baseline bundle;
   ensure the reviewed lab baseline contains the intended implementation.
3. Obtain explicit approval for the bounded real task and remaining unverified
   client behavior. The wrapper requires `-AllowUnverifiedClient`, concurrency
   exactly `1`, timeout `1000`–`300000` ms, an empty sandbox inventory, and a new
   output directory. A host timeout does not cancel remote execution; inspect
   exact-ID cleanup in the dispatcher summary and retain a disk if cleanup fails.
4. Supply a licensed fine-grained `github_pat_` credential as caller-process
   `SQUAD_COPILOT_TOKEN` immediately before the real command, using your secure
   process-only credential mechanism. Do not paste it in command arguments,
   transcripts, plans or files. No real token was acquired or used during this
   preparation. The existing dispatcher consumes it once and uses its protected
   transient host/tmpfs transport; the wrapper restores caller environment,
   so remove the caller token yourself after the operation.

After prerequisites 1–3, the exact **configuration preflight** command shape is:

```powershell
.\infra\hooks\sandbox-lab-local.ps1 -PreflightOnly `
  -RepoPath 'C:\path\to\reviewed-lab-checkout' `
  -PlanPath 'plans\reviewed-task.json' `
  -Repository 'AzureViking/squad-on-aca-sandbox-lab' -IssueNumber '<real-issue-number>' `
  -ImageRef 'crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:<approved-new-64-hex-digest>' `
  -Concurrency 1 -TimeoutMs 300000 -AllowUnverifiedClient
```

After separate real-task approval and credential supply, use the same command
**without `-PreflightOnly`** and add `-OutDir 'C:\path\to\new-run-output'`.
The helper calls the existing `dispatcher\cli.js dispatch --client aca`, then
integration; it does not install a stub, register a runner, or call the publisher.
Review `dispatcher-summary.json`, integration artifacts and cleanup failures.
Do not delete the shared disk or blindly repeat a failed operation.

## Direct dispatcher entrypoint

The default client is `fake`. It creates local sandbox directories under the output directory and executes the real `agents/sandbox/runner/persona-run.sh` with bash. The live client is opt-in only:

For the approved Windows lab, prefer the guarded helper above. Direct live CLI
use is a lower-level entrypoint and also needs the isolated Azure context,
reviewed image/plan and explicit unverified-client approval.

```powershell
$env:SQUAD_ENABLE_ACA_SANDBOX = '1'
$env:SQUAD_SANDBOX_GROUP_NAME = '<sandbox-group-name>'
$env:SQUAD_SANDBOX_RESOURCE_GROUP_NAME = '<resource-group>'
$env:SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID = '<subscription-id>'
$env:SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID = '<ACR-pull-UAMI-client-id>'
$env:SQUAD_SANDBOX_REGION = 'swedencentral'
$env:SQUAD_ACA_BIN = '<absolute-pinned-aca-path>'
$env:SQUAD_SANDBOX_IMAGE_REF = 'crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:<64-hex-digest>'
node dispatcher\cli.js --plan plan.json --repo . --out .dispatcher-out --client aca --repo-full-name owner/repository --issue-number 42
```

## Flow

### Bounded Copilot execution

Each persona defaults to **30 soft AI credits** using pinned Copilot CLI
**1.0.96** and exactly one `--max-ai-credits <value>` argv pair. To explicitly
select another supported limit, use `--max-ai-credits N`, programmatic
`maxAiCredits` (or `config.maxAiCredits`), or `SQUAD_COPILOT_MAX_AI_CREDITS`.
Precedence is CLI/top-level option, configuration, then environment; all supplied
values are validated before sandbox creation. Only safe integers **>= 30** are
accepted: lower values, zero, empty values and arbitrary option strings fail
closed rather than rounding up or disabling the limit.

The dispatcher records the numeric limit in `persona.dispatch.max_ai_credits`
and sends the matching runner-only environment value through the existing
allowlisted bootstrap. Neither setting reaches Copilot's environment, and
integration receives neither. This is a **per-persona soft AI-credit limit, not
a hard USD cap or aggregate run budget**; in-flight requests can exceed it.
Do not increase the default to circumvent an originally approved smaller budget.

1. Validate the execution plan with `contracts/aca-sandbox/v1/tools/validate.js`.
2. Build a schema-valid `persona.dispatch` envelope from each task and the roster snapshot in the plan. Persona names are values from the plan, never code constants.
3. Run ready tasks up to the concurrency limit. If a dependency fails, dependent tasks are marked `skipped` and are not dispatched.
4. Create a sandbox labeled by execution ID, task ID, and logical member ID. The
   live adapter adds a stable `squad_name` label derived from the spec name and
   uses the generated sandbox UUID, not that label, as the handle. Caller labels
   must not use the reserved `squad_name` key, keys must start with a letter
   and use only letters, digits, `_`, `.` or `-`, and values must not contain
   commas, `=`, or control characters. Invalid labels fail before any Azure call.
5. Create a local git bundle for the exact baseline commit, upload it, clone it inside the sandbox, and detach to the baseline SHA. No remote URL or GitHub token is placed in the sandbox.
6. Upload the dispatch envelope and run the persona worker.
7. Start a fixed runner bootstrap. The live ACA adapter stages its JSON environment payload in a mode-600 host file inside an access-restricted temporary directory, copies it into a mode-700 directory on verified `/dev/shm` tmpfs, sets the remote file to mode 600, and feeds it to the bootstrap through shell redirection. The bootstrap validates an allowlist, sets runner-only variables, and execs the persona runner. Copilot auth modes are explicit (`--auth-mode pat|actions`): `pat` requires fine-grained `github_pat_` tokens, while `actions` accepts the current job-scoped `GITHUB_TOKEN` only from the workflow runtime (`GITHUB_ACTIONS=true` and a repository context). Actions tokens are opaque; their prefix is not used as authentication proof. Actions mode rejects known PAT prefixes and must be separately opted into by the workflow. The workflow token is scoped to the Copilot request step on the runner and is never forwarded as an Azure/OIDC credential. Classic `ghp_` tokens are rejected.
8. Download `persona-result.json`, `artifact-manifest.json`, and artifacts listed in the manifest.
9. Revalidate result contracts, recompute artifact sha256 values, scan downloaded files for credential material, and re-check patch paths against owned and protected paths.
10. Delete the persona sandbox in a `finally` block. Delete failures are recorded in the task summary.
11. If every required persona task succeeded, create a fresh integration sandbox labeled with `phase=integration`. Upload the same baseline bundle plus verified persona patches. No Copilot token or credential variable is sent.
12. Run the integration runner through the same environment bootstrap. The live adapter uses the protected tmpfs-file transport; the offline fake client retains its stdin-only test transport. Integration receives no Copilot credential. The runner applies patches deterministically by dependency order and task ID, validates ownership again, optionally runs argv-only check commands, and emits an integrated patch.
13. Download integration artifacts, validate schemas and sha256 values, rescan for credential patterns, and verify the integrated patch path set equals the union of persona patch path sets.
14. Verify the integrated patch without checkout. The dispatcher builds a bare verification repository from the bundle, disables system and global git config, disables hooks, disables LFS and filters, writes a blanket attributes override, and applies patches to temporary index files only. For every changed path, the integrated patch must produce the same index mode, blob ID, and raw blob bytes as the single persona patch that owns that path.
15. Delete the integration sandbox in a `finally` block.

## Credential and artifact boundary

The dispatcher reads `SQUAD_COPILOT_TOKEN` once at startup and immediately removes it from `process.env`. Every dispatcher child process is then launched with an explicit sanitized environment. The filter removes `SQUAD_COPILOT_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GITHUB_PAT`, names matching `TOKEN`, `SECRET`, `PASSWORD`, or a trailing `PAT`, plus any secret keys listed by dispatcher configuration. This is defense in depth for `git bundle`, the fake client, and the live `aca` CLI process.

Inside the persona runner, Copilot's `HOME` and `XDG_CONFIG_HOME` are private
per-run directories on verified `/dev/shm` tmpfs. The pinned CLI's extracted
public package cache is separately stored on the sandbox disk through
`COPILOT_PKG_CACHE_HOME`; that cache contains no token, user configuration, or
credential state. `COPILOT_AUTO_UPDATE=false` keeps the worker on the image's
verified CLI version. The integration sandbox receives no Copilot credential
or package cache.

Azure identity variables required by the local `aca` CLI are preserved where they are not secrets, including `AZURE_CLIENT_ID`, managed identity endpoint variables, and other non-secret `AZURE_*` values. `AZURE_CLIENT_SECRET` is intentionally stripped if present and should not be required for this dispatcher path.

The dispatcher redacts the injected Copilot token and common GitHub token prefixes from its logs and summaries. It also rejects any runner stdout, stderr, or downloaded artifact that contains the token. The token is never written to the dispatch envelope, bundle, `aca` command arguments, local `aca` process environment, or log files. Live runner environment delivery uses a transient host staging file protected by POSIX mode 600 inside a mode-700 directory, or by a verified current-user-only Windows ACL; failure to establish that protection stops before upload. The remote copy is placed in a mode-700 directory on verified `/dev/shm` tmpfs, changed to mode 600 before the bootstrap starts, read once by stdin redirection, and removed by the remote shell cleanup trap plus a host-side cleanup attempt. No payload bytes are placed in CLI arguments or local process environment. If remote cleanup fails, the call fails with a `ACA_RUNNER_ENV_CLEANUP_FAILED` error even when another step already failed. The message states that secret staging may remain in sandbox tmpfs until the sandbox is deleted and includes the redacted primary failure, never the payload. The task or integration summary records that message, and the sandbox is still deleted in the `finally` block. The fake client remains offline-only and retains its stdin-based test path.

`SQUAD_ACA_BIN` can point the live client at a specific ACA CLI executable. This is mainly for pinned installations and tests that place a stub executable ahead of the real CLI.

`SQUAD_SANDBOX_IMAGE_REF` must be an immutable sha256 digest beneath
`crsquadacaa6b49feb.azurecr.io/squad/`; mutable tags are rejected.
The live adapter requests a managed disk image with the regional ACA Sandboxes
v2 API at `management.swedencentral.azuredevcompute.io`. Every ACA CLI command
(sandbox create, exec, `fs cp`, delete, and disk-image delete) explicitly passes
`--region swedencentral --subscription <SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID>`
`--resource-group <SQUAD_SANDBOX_RESOURCE_GROUP_NAME>` before the command, so no
ambient CLI context is used. The subscription must be a UUID and the resource
group and sandbox group names are validated at client start. CLI failures report
the exit code plus at most 400 characters of CLI output, with bearer tokens,
JWTs, GitHub tokens, and signature or secret query values redacted. `SQUAD_SANDBOX_REGION` defaults to `swedencentral`;
other regions are rejected because endpoint selection is fixed. It obtains an Azure
access token through the existing Azure CLI login for audience
`https://management.azuredevcompute.io`, submits `source.kind=registry`,
`source.imageUrl`, and `source.managedIdentityClientId`, then polls the
`operation-location` until a terminal result. Only a validated
`diskImage.id` UUID is used to boot sandboxes through
`aca sandbox create --disk-id <uuid>`. The image pull identity client ID is
separate from the dispatcher UAMI used for the Azure login. Tokens are held
only in the REST request authorization header and are not logged or passed to
the ACA CLI.

One disk image is created per dispatcher client and shared only among that
dispatch's persona and integration sandboxes. After all sandbox deletion
attempts succeed, the dispatcher deletes that exact returned disk UUID and
waits for the ACA CLI deletion command. If sandbox deletion failed, it retains
the disk image; disk cleanup failures and intentional retention are recorded
in `disk_image_deletion_error` and fail the dispatcher summary. This is
run-scoped cleanup, not a persistent shared-image lifecycle. The live disk
delete command and sandbox deletion passed the bounded 2026-10-09 lifecycle
probe below; deletion failures and deletion while remote work is still running
remain unverified.

The API body and disk-id boot path were verified against the portal and a
successful direct request. The client fails closed on malformed operation
locations/responses, non-success HTTP status, failed operations, and polling
timeouts. Fake mode needs no image or Azure configuration.

Artifact paths are validated before download and again while writing. Paths must be relative POSIX paths, must not use Windows reserved device names, must not end a segment with a dot or space, must not contain colons or control characters, and must not collide after Unicode NFC normalization and case folding within one manifest.

Live runner delivery depends on `aca sandbox fs cp` and `/dev/shm` being available in the sandbox. The protected-file design fails closed if `/dev/shm` is not mounted as tmpfs, is not writable, or the required owner/mode checks fail. `aca sandbox exec` stdin forwarding is unsupported by the installed CLI, so the live adapter does not pass runner payloads to its stdin stream.

The persona worker now records `logs/isolation-mode.txt`. In the sandbox image it runs as root only long enough to keep staging/output directories private and execute Copilot as the separate `copilot-agent` user. Local tests without root or without that user run in `same-user` mode and assert the marker explicitly.

CI on Linux should set `SQUAD_REQUIRE_PROC_ARGV_TEST=1` when running `agents/sandbox/test/persona-run.test.js`. Without `/proc` cmdline support the argv credential test is skipped locally, but CI must fail instead of accepting a skipped argv evidence check.

## Live ACA verification checklist

Verified in a credential-free probe against ACA CLI `1.0.0-preview.4`, group
`sbg-squad-aca-sandbox-lab`, region `swedencentral`:

- `sandbox create --group ... --disk-id <uuid> --cpu 1000m --memory 2048Mi --label ...` creates a sandbox. There is no `--name`; output is plain text even when JSON output is requested. The progress line `Creating sandbox <uuid>...` is written to stderr and `Created sandbox: <uuid>` to stdout (confirmed with a raw `-o table` capture). The adapter requires exactly one matching line on each stream with the same UUID, rejects any extra, blank, or reordered line, and uses only the generated UUID as the handle. If the output cannot be verified, the error states that a sandbox may exist and disk-image deletion stays blocked until it is checked and removed manually.
- `sandbox exec --group ... --id <uuid> -c <command>` runs a command string. Stdin is not forwarded. Argument vectors are converted to POSIX single-quoted command strings.
- Native `sandbox fs cp` transferred a harmless local file to `<sandbox-id>:<remote-path>` and back with matching SHA256. The live adapter uses this API, not base64 over exec.
- `sandbox delete --group ... --id <uuid> --yes` cleaned up the temporary sandbox; a follow-up list was empty.
- Live-verified on 2026-10-01 through the adapter itself, with every command pinned to region, subscription and resource group: `create` returned sandbox `20074df2-6048-4444-8796-94e2802fcde5`; `execWithEnvironment` confirmed `/dev/shm` is tmpfs, copied the env JSON into a private tmpfs directory, the bootstrap consumed it through shell redirection and returned the expected path, and cleanup of the staging file and directory completed; the adapter then deleted the sandbox and `sandbox list` returned `[]`. Only non-secret values were sent (`/tmp/aca-probe-source`, `/tmp/aca-probe-output`); no Copilot or other credential was used. The shared disk image was left intact.
- Live-verified on 2026-10-09 (15:07:15–15:08:38 UTC), under explicit approval
  for exactly one disposable disk and sandbox: the adapter's v2 disk-image
  client pulled the immutable image
  `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:cea1d310e7109c18d24ae57de153565c722284382c89d0bc1b441840f59e2875`
  through the existing pull identity. It created disk
  `9ba335ea-3d20-4723-9492-86195aea1d71` (name
  `squad-8db2bece-9ec4-4e23-aa24-bf4f2f499e3e`) and sandbox
  `9fa8f3cd-4ede-4463-b8e6-a770b06d94c0` with `1000m` CPU, `2048Mi`
  memory and label
  `lifecycle_probe=lifecycle-c84b701b-0be4-44b1-8c73-22004c48e71e`.
  `execWithEnvironment` delivered only harmless `FAKE_LIFECYCLE_MARKER`
  and `SQUAD_OUTPUT_DIR` strings to the fixed bootstrap. The existing host
  process runner's 5-second timeout returned `timedOut=true`, exit code `124`,
  while a remote Node runner waited 12 seconds. CLI stdout did not capture
  the runner's start message; a unique PID marker proved the runner reached
  the environment handoff. Immediate inspection found PID 69 still alive
  with matching process argv; after a further 13-second wait, the delayed
  marker existed and that process had exited. **The local CLI timeout did
  not cancel remote execution.** Both inspections confirmed the exact
  `/dev/shm/squad-runner-4f3a5b30-0f4f-49ef-9b91-2c49246b4c58`
  directory and its `environment.json` were absent despite the timeout.
  Host staging was also empty and removed. In `finally`, the adapter
  deleted the exact sandbox, then successfully deleted the exact disposable
  disk through `sandboxgroup disk delete --wait-timeout 180`. Final
  inventory contained no sandboxes and only shared disk
  `63561979-2a62-4cb9-bb0e-fdf96a8adad4`, still `Ready`.

Treat `timedOut=true` as a failed host wait, not proof of remote cancellation.
The dispatcher's `finally` sandbox deletion is the resource teardown boundary;
environment-file removal alone cannot terminate a runner or erase environment
values already held by that process. Successful exact-ID deletion and inventory
confirmation are sufficient for this probe's resource cleanup, but the runner
had finished before deletion. This probe does **not** establish how quickly
deletion terminates an actively running process. Keep deletion failures visible
and retain the run disk when sandbox cleanup fails or is uncertain.

The adapter now matches those create/exec/copy/delete forms, and the tmpfs
environment handoff is live-verified as above. The code still verifies the
`/dev/shm` tmpfs mount and restrictive ownership/modes on every run and fails
closed otherwise. POSIX mode checks and Windows ACL setup are covered by offline
tests. Still unverified live: remote cancellation or active-process termination
on sandbox deletion, a handoff carrying a real Copilot credential, and the full
persona plus integration dispatcher flow. The bounded probe verified local
timeout semantics and disposable disk deletion, not those remaining gates.
Both probes intentionally retained the shared disk image. Do not use a Copilot credential for
any follow-up transport probe. Publication remains disabled.

## Manual workflow and rollout gates

`.github/workflows/squad-sandbox-manual.yml` is workflow-dispatch only. It takes
an issue number, a repository-relative plan path, the exact repository name,
and an execution mode. `fake` is the default and uses a no-op Copilot stub with
the fake sandbox client. The stub writes a deterministic smoke patch under the
first validated owned path, so integration can verify a real patch without
pretending to perform the task objective. It has no Azure, Copilot, or GitHub
write credential. The workflow uploads only the dispatcher summary,
integration manifest, and integrated patch for one day. It does not upload
runner logs or the baseline bundle. Dispatcher artifacts are contract-checked,
hash-verified, path-checked, and scanned for token material before integration.
Use `dispatcher/fixtures/workflow-manual-plan.example.json` for the offline
smoke path only. It is a static sample roster, not a production coordinator
plan, and should not be selected in live mode.
Live plans must also include an `issue` object containing the exact selected
`repo` (owner/repository) and `issue_number` (positive integer). Older plans
without a binding remain usable only in fake mode. Both workflow preflight
and direct ACA dispatch, as well as the publisher, independently reject absent or mismatched live bindings
before authentication or network requests. Publisher preflight also checks
the plan run ID and baseline against the dispatcher outputs, so a stale plan
cannot publish another execution.
The publisher's fake client is covered offline by the dispatcher tests against
a local bare Git remote; the manual fake mode does not attempt GitHub
publication.

The plan file must live in the checked-out repository. Because a tracked plan
cannot contain the SHA of the same commit without a self-reference, set its
top-level and task `baseline_sha` values to the exact sentinel
`$CHECKED_OUT_SHA`. Preflight substitutes the full GitHub checkout SHA into a
private temporary copy, validates the resulting v1 contract, and passes only
that materialized plan onward. A literal SHA is accepted only when it equals
the checked-out commit. The preflight rejects malformed or absolute paths,
traversal, symlinked path components, invalid repository or issue inputs, and
any commit mismatch before Azure authentication.

Squad CI checks committed whitespace changes, not the clean checkout's
working-tree diff. PR checks use the merge-base of the full-history checkout
and PR base SHA; push checks use the before-to-after range. The first push
uses the new commit's parent or the empty tree for a root commit. A missing
base fails the CI job rather than silently skipping the check.

Live sandbox dispatch is a separate opt-in. Select `live`, enable
`enable_sandbox_live`, and configure the protected `squad-sandbox-dispatch`
environment. A dedicated Linux runner with label `squad-aca-cli` must already
have the trusted ACA CLI installed; `SQUAD_ACA_BIN` must name its absolute
executable path. Configure these environment variables:

| Name | Purpose |
| --- | --- |
| `SQUAD_SANDBOX_GROUP_NAME` | Existing Sandbox Group |
| `SQUAD_SANDBOX_RESOURCE_GROUP_NAME` | Resource group containing the Sandbox Group |
| `SQUAD_SANDBOX_AZURE_CLIENT_ID` | Dedicated dispatcher UAMI client ID |
| `SQUAD_SANDBOX_AZURE_TENANT_ID` | Azure tenant |
| `SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID` | Azure subscription |
| `SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID` | Client ID of the UAMI granted ACR pull |
| `SQUAD_SANDBOX_REGION` | ACA region; must be `swedencentral` for the configured data plane |
| `SQUAD_ACA_BIN` | Absolute path to the pre-installed ACA CLI |
| `SQUAD_SANDBOX_IMAGE_REF` | Approved tag or sha256 digest OCI reference in the existing ACR |
| `SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT` | Must equal `1` for an explicitly acknowledged manual probe |

Store `SQUAD_COPILOT_TOKEN` as a protected environment secret. It must be a
fine-grained `github_pat_` token accepted for Copilot use. The UAMI is only for
Sandbox Group data-plane ownership. It is not a GitHub write identity and is
not sent into persona or integration sandboxes. The Copilot token is provided
to persona execution only; the integration phase receives no credential.

Live publication is a second, independent opt-in and is unavailable unless the
live dispatch job and integration both succeed. Configure required reviewers on
the `squad-publish` GitHub environment. Add environment variables
`GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID`, and store the PEM contents as
the protected `SQUAD_GITHUB_APP_PRIVATE_KEY_PEM` secret. Workflow code does not
retrieve the PEM from Key Vault yet. The publish job validates the successful
summary first, validates the PEM, stages it as a mode-600 file under
`RUNNER_TEMP`, and removes that exact file on exit. The App key and installation
write token are never made available to persona or integration execution. The
GitHub App installation needs only `contents: write`, `pull_requests: write`,
and `issues: write` on the target repository. GitHub Actions `GITHUB_TOKEN`
remains read-only.

The workflow uses the existing outbound routes only: GitHub Actions to Azure
OIDC and the configured ACA endpoint, plus the publisher to the target
repository's GitHub HTTPS API and git endpoints. It adds no Azure network
route. Missing runner, CLI, identity, group, Copilot, or App configuration
fails before the corresponding authentication or mutation step. The manual
workflow never fires from labels, and the legacy queue template remains on
ACA Jobs.

This workflow is not production-ready. Basic create/exec/copy/delete syntax is
verified, and the protected tmpfs environment handoff passed a credential-free live
probe. A bounded lifecycle probe also verified local CLI timeout without remote
cancellation, environment staging cleanup after timeout, and disposable disk
deletion. Active-process termination on sandbox deletion and the complete live
dispatcher flow remain unverified. The controlled-probe gate is
not proof of compatibility. Do not enable unattended or label-driven Sandbox
dispatch until the live checklist passes. Publication remains disabled.

### Lab readiness checkpoint (2026-10-12)

- Verified both dedicated managed identity client IDs and tenant through the
  isolated lab Azure CLI context. The Sandbox Group reports `Succeeded` in
  `swedencentral`. Added and read back only the missing protected environment
  variables `SQUAD_SANDBOX_RESOURCE_GROUP_NAME`,
  `SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID`, and `SQUAD_SANDBOX_REGION`.
- Kept the required reviewer, main-only branch policy, admin-bypass prohibition,
  and previously approved sole-maintainer self-review exception unchanged.
  Repository and dispatch-environment secret-name lists are empty.
- **OIDC remains blocked:** GitHub subject-template metadata reports an immutable,
  lowercase repository prefix. The existing dispatcher federated credential
  trusts the legacy name-only `repo:AzureViking/...` subject. Review and align the
  exact subject under separate authorization; no token exchange or trust change
  occurred. Also review the preflight's exact-case lab repository comparisons.
- The repository runner API returns zero registered runners. Organization runner
  access returns HTTP 403, so organization runner availability is **unknown**.
  Existing WSL supports offline Docker checks, but its profile-free tool lookup
  finds no native Node or ACA executable. It is not a configured dedicated
  dispatcher host or a registered GitHub runner.
- The corrected image builds locally, but artifact-only release validation still
  blocks ACR publication. Do not bind the old digest to the fixed runner.
  Lab `main` still lacks that runner fix. No image reference, CLI path,
  unverified-client opt-in, credential, or publication configuration was added.
- Focused lab-helper and workflow-preflight tests pass **28/28** in an isolated,
  network-disabled Linux container using a non-root user and an LF-normalized
  source copy. Native Windows preflight testing passes 17, fails the offline
  integration check, and skips one unavailable symlink check. This is offline
  evidence, not a live dispatcher result.

At that checkpoint, the next step was to resolve the image-release gate and approve a credential-free image/lifecycle
probe. Before a real task, separately choose a trusted execution host, resolve
OIDC subject compatibility, provide an entitled protected Copilot credential,
and approve the issue-bound task, runtime and cost ceiling. Do not silently
register WSL as a runner. Publication stays disabled.

The 2026-10-13 scoped image release supersedes the image blocker in this
historical checkpoint. It adds the validated default **30 soft AI-credit**
per-persona bound and publishes a new immutable image, without executing live AI,
changing OIDC/RBAC, enabling GitHub publication, or claiming full live-flow proof.


## Integration phase

Integration is automatic unless the caller passes `--no-integrate`. The phase is
fail closed. If any required persona task failed or was skipped, integration is
marked `skipped` and the overall dispatcher summary remains failed. If
integration runs and fails, the overall summary is failed even when all persona
tasks succeeded.

The integration envelope is `integration.dispatch`. It contains patch artifact
paths and sha256 values, task dependencies, `owned_paths`, optional check
commands, and `allow_3way`. The dispatcher sets `allow_3way` to `"false"` unless
the plan explicitly opts in. This preserves the disjoint-owned-path assumption.

The integration runner emits `integration-result.json`,
`artifact-manifest.json`, and on success `patches/integrated.patch`. The
dispatcher independently revalidates the result, compares the runner-reported
patch sha256 with the manifest sha256, and verifies the integrated patch against
the baseline bundle without creating a worktree checkout. Verification uses a
hardened git environment with system and global config disabled, hooks pointed
at an empty directory, LFS smudge disabled, and `.gitattributes` filters
neutralized. Patches are applied with `git apply --cached` against temporary
index files read from the baseline tree, so clean and smudge filters cannot
normalize content during verification. The verifier never checks out a worktree
and its git wrapper allows only `init`, `fetch`, `rev-parse`, `read-tree`,
`apply --cached`, `ls-files`, `cat-file`, `write-tree`, `diff`, and
`diff-tree`. This keeps checkout hooks, worktree update hooks, and filter
commands out of the verification path. The dispatcher then performs the
content-level equality check against persona-owned patch output.

The dispatcher repeats the integration delta policy against the verified
integrated index. It rejects symlink mode `120000`, gitlink mode `160000`,
`.git/**` paths, protected paths, paths outside the union of persona-owned
patch paths, and executable-bit additions unless the owning task has
`allow_executable_bits: "true"`.

Checks run after the runner has already written and hashed the integrated patch.
The runner records the source index tree, a full source worktree fingerprint,
and selected source git metadata before checks. Each check runs in a throwaway
copy with no `.git` directory, and the source fingerprints must still match
afterward. A check that reaches back into the source tree or source git metadata
fails with `checks_mutated_tree`; edits inside the throwaway copy are ignored.

Integration check commands are not supported for repositories whose integrated
tree contains any symlink or gitlink, including unchanged baseline entries. The
runner fails closed with `check_tree_contains_symlink` before materializing the
check copy. Repositories with symlinks can still integrate patches when no
check commands are configured.

The integration runner rejects symlinks, gitlinks, `.git/**` paths, and
executable-bit additions unless a task explicitly opts in with
`allow_executable_bits: "true"`. Git plumbing output uses a large bounded
capture policy and fails with `output_limit_exceeded` if exceeded. The optional
`SQUAD_INTEGRATION_MAX_PLUMBING_BYTES` override must be a positive integer no
larger than 268435456 bytes. Check output is only log data, so it may be
truncated and marked with `truncated: true`.

## Publish phase

The publisher is the trusted PR 7 boundary. It never runs in a persona or integration sandbox. It consumes a succeeded `dispatcher-summary.json`, the integration artifact manifest, and the integrated patch:

```powershell
node dispatcher\cli.js publish `
  --summary .dispatcher-out\dispatcher-summary.json `
  --repo . `
  --plan plan.json `
  --repo-full-name owner/repo `
  --issue-number 42 `
  --issue-title "Issue title"
```

Live GitHub mutation is opt-in only. The real REST client refuses unless both `--live` and `SQUAD_ENABLE_PUBLISH=1` are present. Offline tests use `FakeGitHubClient` and a local bare git repository as the remote.

The publish preflight fails closed before requesting any installation token when the dispatcher summary or integration artifact manifest is invalid, the manifest run ID or baseline SHA does not match the execution plan and summary, the integration status is not `succeeded`, the integrated patch path or sha256 does not match both the summary and artifact manifest, or required issue metadata is missing. `--baseline-sha` is only a checked assertion against the manifest value. It cannot override manifest or plan metadata. The target repository name must be a validated `owner/repo` value, cannot contain `..`, and cannot end in `.git`. After the scoped installation token is created, the publisher fetches the target branch from an explicit repository URL built from that validated name and an allowed host, then verifies that the target branch contains the recorded baseline SHA. If the target branch has moved forward but still contains the baseline, v1 does not rebase or merge. It creates the publish branch directly from `baseline_sha`, so the draft PR shows that the branch is behind.

Publication is idempotent by execution ID. The branch name is deterministic from the issue number, execution ID, and sanitized issue-title slug. The publisher first rebuilds the expected tree from the verified integrated patch and the recorded baseline. It then looks up pull requests for that deterministic head branch with `state=all`. If an open pull request already exists for that branch, reuse is allowed only when the pull request head SHA equals a freshly fetched remote branch SHA, the branch commit tree equals the rebuilt expected tree, and the branch commit has exactly one parent equal to `baseline_sha`. The publisher also repairs the lifecycle labels and the single marker comment if an open pull request is reused. If a closed or merged pull request already exists for the branch, publication fails closed with no new pull request and no push. If the branch already exists with no pull request, the same tree and parent check must pass before the publisher creates the pull request without re-pushing. In that branch-exists-no-PR path, the existing commit message and author and committer name and email must exactly match the publisher-generated commit. Only author and committer timestamps may differ. Any missing branch, stale PR head, tree mismatch, parent mismatch, message mismatch, or identity mismatch fails closed. `--update` is refused in v1.

GitHub creates pull requests by branch name, not by a caller-supplied commit SHA. After PR creation, the publisher compares the returned PR `head.sha` with the commit it just published. A mismatch records a failed publish receipt and stops before label or comment updates. This detects, but does not prevent, the residual race where the branch changes between the create-only push and pull request creation.

The commit is created with git plumbing and no worktree checkout. The publisher reads the baseline tree into a temporary index, applies the integrated patch with `git apply --cached`, repeats the independent delta policy, writes the tree, and runs `git commit-tree`. Hooks, global config, system config, filters, LFS smudge, and worktree-updating git commands are disabled. Commit identity mirrors the ACA Job path: `squad-aca-bot[bot] <3362344+squad-aca-bot[bot]@users.noreply.github.com>`.

Push and fetch never use the checkout's remote configuration. They use the explicit repository URL, defaulting to `https://github.com/<owner>/<repo>.git`. The token extra header is scoped to that exact URL with `http.https://github.com/<owner>/<repo>.git.extraheader`, not to all of `github.com`. Remote git children disable redirects, disable credential helpers, disable system and global config, use a fresh empty global config file under a private per-run directory, use a fresh isolated home directory, disable terminal prompts, and point hooks at a fresh empty real directory with mode `0700`. Stale `.publish-work` hook paths and symlinked hook directories are not reused, and the per-run directory is removed after publish exits. Push uses one create-only refspec guarded by an empty `--force-with-lease=refs/heads/<branch>:` expectation, so an existing branch cannot be overwritten. If the remote branch exists with mismatched verified content, the publisher fails. The installation token is kept in memory only. The publisher deletes private key path and token environment variables after reading them, strips credential-like variables from every child process, and passes the token only through scoped git config environment variables so it never appears in argv.

The real GitHub client uses `node:https`, not `gh` or shell commands. It requests an installation token scoped to one repository with only `contents: write`, `pull_requests: write`, and `issues: write`. HTTPS responses are capped, request timeouts are enforced, invalid JSON fails closed, and API errors are bounded and redacted. Private key retrieval is PEM path only in v1 through `SQUAD_GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY_PATH`. The PEM path must be a regular file, not a symlink, no larger than 16 KiB, and parse as a private key with `crypto.createPrivateKey`. Automated Key Vault retrieval is not implemented. The manual workflow requires the PEM to be staged in a protected GitHub environment secret before publication can run.

The draft PR title, body, and issue comments strip C0 and C1 controls plus bidi and invisible formatting characters, neutralize `@` mentions and `#` references, cap lengths, and reject GitHub token-looking patterns. PR body text and issue comments also escape Markdown and HTML-sensitive characters. Label changes are limited to the ACA Job lifecycle labels from `agents/base/lib/issue-labels.sh`: `squad:processing`, `squad:queued`, and `squad:revising`.

The publisher writes `publish-result.json` by default next to the dispatcher summary. The receipt validates against `contracts/aca-sandbox/v1/schemas/publish-result.schema.json`.

UNVERIFIED:

- Live GitHub REST behavior is not exercised by tests. The request shapes are implemented from GitHub's stable REST API contract and gated behind `--live` plus `SQUAD_ENABLE_PUBLISH=1`.
- PR 8 must fetch the GitHub App private key from Key Vault or stage a PEM path before invoking the publisher.
