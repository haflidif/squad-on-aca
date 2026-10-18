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
2. Export the deployed platform descriptor to `.squad/platform.json` in the target. Review it against the platform descriptor schema. Bind `.squad/execution.json` to the descriptor's actual `platform_id` and matching backend.
3. Initialize Squad in the target with your chosen members and charters. Configure `.squad/sandbox-flow.json` with your own allowed paths and checks if needed. No Terraform-specific application checks are installed.
4. Configure the backend-specific OIDC identity and repository variables. Jobs needs its queue and storage variables. Sandbox needs its immutable worker image, dispatcher and publisher settings, credentials, and protected execution/publish environments. Use the [infrastructure guide](infrastructure.md) and [routing guide](sandbox-issue-flow.md).
5. Review the callers and retire competing ingress. Set `enabled` to `true` in `.squad/execution.json` only after the descriptor and protections are ready. Set the target repository variable `SQUAD_EXECUTION_BACKEND` to the same backend as the final explicit admission step. Both the installed router variable guard and execution setting must allow admission.

Installing `sandbox` alone does not opt a repository into live execution. For a backend switch, pause admission, drain work, provision the destination, and review its binding before enabling it. Existing receipts keep their original provider binding.

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
