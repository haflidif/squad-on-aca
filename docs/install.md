# Install without a fork

> The installer prepares a local change for review. It does not deploy Azure, set GitHub variables or secrets, or enable execution.

Try a preview from an extracted Squad on ACA release:

```powershell
.\install.ps1 -Version v1.0.0 -Target C:\src\my-application -Backend jobs -Preview
```

Use any new or existing repository. Your application can use any language or infrastructure stack. The platform sources stay in the extracted release, outside your application. You do not need to fork or clone the platform repository.

## Get a release

1. Choose a release that includes the no-fork installer assets on the [releases page](https://github.com/haflidif/squad-on-aca/releases).
2. Download `squad-on-aca-<version>.tar.gz` and its `.sha256` file. Use these assets, not GitHub's automatically generated source archives.
3. Verify the archive checksum before extracting it. On PowerShell, use `Get-FileHash -Algorithm SHA256`. On Linux, use `sha256sum -c squad-on-aca-<version>.tar.gz.sha256`.
4. Extract the archive, then open a terminal in its `squad-on-aca` directory. Install Node.js 22 or later. Use PowerShell 7 or Bash for the entry point you choose.

The archive records both its release version and the full source commit in `release.json`. The installer accepts that tag or that full 40-character SHA, and rejects a different version. Every generated engine action reference uses the recorded SHA, never a moving branch or tag. A source checkout also works when the requested SHA or local tag points to its current HEAD. Use a verified release archive for reproducible installation bytes.

## Preview and install

PowerShell:

```powershell
.\install.ps1 -Version v1.0.0 -Target C:\src\my-application -Backend sandbox -Preview
.\install.ps1 -Version v1.0.0 -Target C:\src\my-application -Backend sandbox
```

Bash:

```bash
bash ./install.sh --version v1.0.0 --target "$HOME/src/my-application" --backend jobs --preview
bash ./install.sh --version v1.0.0 --target "$HOME/src/my-application" --backend jobs
```

Replace `v1.0.0` with the downloaded release version. The installer does not download a different release for you. `--ref` and `-Ref` are aliases for the version argument. Omit the backend to select `jobs`; the other supported value is `sandbox`. A new target directory does not need to exist. Initialize Git there yourself before committing the result.

Preview lists `ADD`, `CHANGE`, `KEEP`, and `CONFLICT` entries. It creates no directories, files, branches, commits, or remote changes, even when combined with `--open-pr`. The default operation makes local file changes only.

## Review the target-owned files

| File | Purpose |
|------|---------|
| `.github/workflows/squad-router.yml` | One admission router and local reusable workflow calls. Requires the repository backend variable before admission. |
| `.github/workflows/squad-queue.yml` | Jobs caller, with the engine pinned to a full SHA. |
| `.github/workflows/squad-sandbox-issue.yml` | Sandbox caller, with the engine pinned to a full SHA. |
| `.github/workflows/squad-sandbox-conflicts.yml` | Conflict hints, gated on the Sandbox backend variable. |
| `.squad/execution.json` | Selected backend, an unconfigured platform binding, and `enabled: false`. |
| `.squad/team.md` and `.squad/sandbox-flow.json` | Minimal scaffold, only when `.squad` is absent on first install. No fixed team, paths, tools, or application checks. |
| `.squad/aca-installation.json` | Versioned installation receipt with backend, release version, immutable action SHA, and SHA256 hashes of owned files. |
| `.squad/aca-installation.sha256` | Detects local edits to the receipt before a later install. This is an integrity check, not a signature. |

The installation receipt uses `contracts/backend/v1/schemas/installation.schema.json`. `platform_id` is optional before deployment. The installer does not invent a real Azure resource ID. The execution scaffold uses an explicit `unconfigured` placeholder so it cannot bind to a deployed platform.

The installer preserves an existing Squad roster, charters, decisions, and flow configuration. It does not copy the engine, dispatcher, platform infrastructure, or this platform's team into the target. Workflow callers remain reviewable target-owned files rather than hidden remote workflow execution.

## Ownership and upgrades

Re-running the same release with the same backend leaves unchanged owned files and their timestamps alone. An upgrade replaces an owned file only when its current bytes still match the receipt. User edits, pre-existing files without ownership, symbolic links, junctions, and hard-linked files are conflicts. The installer skips them and prints a proposed diff when the current file can be read safely. It never writes a `.new` sidecar.

Conflicts return success by default so you can review a partial proposal. Add `--strict` or `-Strict` to return a nonzero exit code for conflicts. Invalid options, runtime failures, and an archive/version mismatch always fail. A partial install keeps the old ownership hashes for skipped owned files; the receipt's release version describes the requested release, not a claim that every caller upgraded. Review all conflicts before activation.

The installer does not adopt pre-existing files, even if their bytes match its proposal. Keep those files under your own management, or move them aside after review and install again. If a file is already installer-owned, keep your edits and merge future proposals manually, or restore the recorded original before upgrading. Do not rewrite ownership hashes to bypass a conflict. An edited, missing, or invalid receipt/checksum pair stops the entire installation without writes.

Initializing your team or enabling execution deliberately changes some scaffold files. Later installs report those edits as conflicts and preserve them. An upgrade does not delete obsolete owned files or reset your active settings.

For an existing repository, check for other issue and revision workflows before activation. Retire or disable old ingress yourself so only one router can admit work. The installer does not disable unrelated workflows or migrate in-flight work. Keep an existing active installation paused while reviewing a replacement.

## Deploy and enable separately

1. Choose one platform deployment path from the extracted release: `infra/terraform` or Bicep through `azure.yaml` and `azd`. Set Terraform `execution_backend`, or azd `SQUAD_EXECUTION_BACKEND`, to the same `jobs` or `sandbox` value you installed. Review the plan before deploying. Follow the [adoption guide](adoption-guide.md) for identities, images, credentials, and protections. Infrastructure hooks and providers have their own GitHub-setting behavior; the repository installer never invokes them.
2. Run the shared activation step below from the extracted release. It validates the descriptor, writes `.squad/platform.json`, and prepares `.squad/execution.json` disabled by default. It prints the exact GitHub settings without changing GitHub.
3. Initialize Squad in the target with your chosen members and charters. Configure `.squad/sandbox-flow.json` with your own allowed paths and checks if needed. No application stack is assumed.
4. Review backend-specific OIDC subjects, repository variables, secrets and environment protections. Retire competing ingress, then explicitly enable the reviewed binding. Commit both JSON files through review to the trusted default branch.

### Activate from Terraform

Supply `jobs_image_ref` or `sandbox_image_ref` as an existing `registry/repository@sha256:<64 lowercase hex>` reference before applying. Mutable tags alone cannot activate either backend. Both pin variables already feed the deployed image and descriptor. Default Jobs provisioning still permits a mutable image for legacy compatibility, but its descriptor is null until pinned.

After an approved apply, run from the extracted release in PowerShell:

```powershell
terraform '-chdir=infra\terraform' output -json | node scripts\activate.cjs --terraform - --target C:\src\my-application --repo example/repository
```

On Linux or macOS, use the same Node.js script:

```bash
terraform -chdir=infra/terraform output -json | node scripts/activate.cjs --terraform - --target "$HOME/src/my-application" --repo example/repository
```

Alternatively save `terraform output -json` as a local JSON file and pass `--terraform <file>`. A selected `terraform output -json platform_descriptor` object is also accepted. Do not commit full Terraform output or state. Only the validated non-secret descriptor is copied to the target.

### Activate from azd

Before provisioning, set the selected immutable image and the target repositories for OIDC:

```powershell
azd env set SQUAD_EXECUTION_BACKEND sandbox
azd env set SQUAD_SANDBOX_IMAGE_REF 'example.azurecr.io/worker@sha256:<digest>'
azd env set TARGET_REPOS '["example/repository"]'
azd env set SQUAD_ACTIVATION_TARGET C:\src\my-application
```

Both postprovision hooks call the same Node.js script. With `SQUAD_ACTIVATION_TARGET`, they prepare disabled target JSON files. Without it, they preview only and write no repository files. They never apply GitHub settings or enable execution. The Jobs hook retains image build and Key Vault guidance; the Sandbox hook skips all Jobs setup. Node.js must be on PATH.

To rerun separately from the release root:

```powershell
node scripts\activate.cjs --azd --target C:\src\my-application --repo example/repository
```

The script reads the hook's descriptor environment value, or calls `azd env get-values --output json` when absent. An exported JSON values file works with `--azd-values <file>`. `--descriptor <file>` accepts a descriptor directly. No shell exports are evaluated. Both IaC paths expose `platform_descriptor_missing` with exact blockers for null descriptors. Activation rejects invalid or incomplete Sandbox descriptors without modifying files or GitHub. Legacy Terraform mixed inventory (`enable_aca_sandbox=true`) is never an activation destination.

### Review settings, then enable

Default activation changes only the two local JSON files, not GitHub. Re-running an unchanged binding preserves bytes and timestamps. `--preview` makes the whole operation write-free. An existing enabled binding is preserved on an identical rerun; changing its backend, platform or descriptor requires a prior pause. Use `--repo` on enabled reruns so OIDC validation can check the repository.

The output lists every backend variable, including Sandbox image-pull identity, and names any required secrets. Sandbox needs `SQUAD_GITHUB_APP_ID`, `SQUAD_GITHUB_APP_INSTALLATION_ID`, and secret `SQUAD_GITHUB_APP_PRIVATE_KEY_PEM` in protected environment `squad-publish`. Jobs queue dispatch needs no GitHub secret; its worker still needs the App key and Copilot PAT in Key Vault. Never paste secret values into descriptors or source files.

Only an explicit `--apply` with an installed, authenticated `gh` applies known non-secret repository variables. For Sandbox, provide `--app-id <id> --installation-id <id>` or azd `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID`. Secrets and protections always remain manual. Settings apply is not transactional; a CLI failure stops immediately and reports failure. Inspect partial settings before retrying. No branch, commit, push, Actions run or deployment is created by activation.

Before applying, stop any old settings writer. Existing Terraform GitHub resources still own their variables and labels. If transferring ownership, remove the corresponding resource configuration and state ownership without remote deletion, using a reviewed `removed` block with `lifecycle { destroy = false }` or explicit state removal. Confirm the next plan neither recreates nor deletes them. Do not remove target repositories from OIDC just to stop GitHub settings writes. Never have Terraform and activation manage the same variable concurrently.

After verifying the printed settings, OIDC subjects, required environment protections, caller workflows, roster and single ingress, rerun with `--enable --repo example/repository`. This explicitly sets local `enabled: true`. `--enable` alone still does not contact GitHub. Set the printed repository variable `SQUAD_EXECUTION_BACKEND` last, or use `--apply` after the checks. Review and commit the binding before requesting work.

### Migrate legacy settings and switch backend

Activation detects `SQUAD_ISSUE_FLOW_ENABLED`, `SQUAD_ISSUE_OPT_IN_NUMBER` and `sandbox-run` references in target workflow files or process settings. To include existing remote settings without a default network call, export `gh variable list --repo example/repository --json name,value` and pass that file as `--legacy-settings <file>`. No secret values are read. A warning explains the replacement: one router, `.squad/execution.json`, `squad:<member>` requests, and optional generic `squad` requests for Sandbox. Retired variables no longer activate or restrict routing. Delete them manually only after stopping their old writer and retiring old independently triggered workflows.

To switch Jobs to Sandbox or back:

1. Set `enabled: false` on the current binding, or rerun activation with its current descriptor and `--disable`, then commit the pause. Do not change backend-specific variables yet. Let admitted Actions runs, Jobs queue messages and Sandbox executions drain.
2. Provision a separate destination with the desired selector and immutable image. Preserve the old deployment and credentials. Never flip an existing resource selector and accept a destructive plan as an activation shortcut.
3. Run activation against the destination descriptor while paused. Review its binding and settings. Use `--enable` only after the destination and protections are ready, then commit through review.
4. Keep in-flight issues and open PR revisions on their original receipt backend. Activation never rewrites receipts. Keep the old platform, settings and protected environments available until those references close. A switch between deployments of the same backend also requires retaining old settings, or waiting until all old PRs close, because repository variables are not versioned per receipt.
5. Retire old resources only in a separately reviewed operation. Failed or ambiguous claims require reconciliation, not relabeling to force a different backend.

## Optional branch and pull request

Add `--open-pr` or `-OpenPr` only when you want the installer to create a branch, commit its explicit changed paths, push that branch to `origin`, and open a PR through the authenticated `gh` CLI. Git and `gh` must be available, and the target must be a clean Git repository root. This is an explicit network operation; the default install is not.

Conflicts prevent PR creation. A no-op install creates no branch or PR. Preview never checks credentials or creates a PR. If a Git, signing, push, or PR operation fails, the installer reports failure and leaves the local changes and any completed Git operations for you to inspect; it does not reset or roll back your repository. Existing Git signing settings still apply to the generated commit.

## Build a release locally

Maintainers can package a committed revision without running CI or contacting Azure:

```powershell
$sha = git rev-parse HEAD
node scripts\package-release.cjs --version v1.0.0 --ref $sha --output .\release
```

The script reads committed Git objects, not working-tree files. Commit the installer and router first. `--ref` accepts a full SHA or an existing local tag, not a branch. The version labels the archive and its metadata; publish the corresponding tag at the same commit. The output contains a `.tar.gz` archive and a SHA256 checksum file. Existing output files are not overwritten.

The archive includes the pinned engine action, its dispatcher/scripts/contracts and worker source dependencies, the four caller templates, Terraform and Bicep sources, azd hooks, `azure.yaml`, both installers, and installation guidance. Local Squad state, ignored files, environment files, private keys, Terraform variable values, and Terraform state are excluded. Keep reviewed examples such as `terraform.tfvars.example` free of secrets. There is no release CI workflow in this slice; publishing assets is a separate maintainer action.

Run the offline checks with:

```powershell
node --test scripts\install.test.cjs contracts\backend\v1\test\contracts.test.cjs
```

Related: [Adoption guide](adoption-guide.md), [Backend contract](backend-contract.md), [Infrastructure](infrastructure.md).
