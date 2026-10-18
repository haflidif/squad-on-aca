# Opt-in ACA Sandbox issue flow

> **Preview:** This workflow is separate from the default ACA Job queue path. It creates temporary ACA Sandboxes and a draft pull request. Keep it disabled until you configure the Sandbox Group, identity, image, GitHub environments, and OIDC trust.

Try this after setup:

```text
Label issue #<number> with sandbox-run
```

The `squad-sandbox-issue.yml` workflow routes work through your Squad roster, runs members in dependency-ordered stages, integrates their patches, applies optional trusted postprocess steps, and publishes one draft pull request. The existing `squad-queue.yml` workflow remains the default ACA Job path. The Sandbox workflow stays off unless you explicitly enable it.

## Consume the packaged engine

You do not need to fork this repository or copy `scripts/`, `dispatcher/`, `contracts/`, or `agents/` into your target repository. Start with the issue workflow in `.github/workflows/squad-sandbox-issue.yml` from the engine release you select. Replace every local `uses: ./.github/actions/sandbox-engine` step with the same full commit pin:

```yaml
- uses: actions/checkout@v4
  with:
    persist-credentials: false
    ref: ${{ github.sha }}
- uses: haflidif/squad-on-aca/.github/actions/sandbox-engine@<full-40-character-commit-sha>
- name: Build the Lead plan
  run: squad-engine plan --stage lead --event "$GITHUB_WORKSPACE/.squad-issue/event.json" --out "$GITHUB_WORKSPACE/.squad-issue/lead-plan.json" --require-opt-in
```

Replace the SHA placeholder with a reviewed engine commit, not a branch or mutable tag. Retain the complete workflow's gate, environment protections, permissions, artifacts, job ordering, and publish checks. The example above only shows how to load and invoke the package after the gate has captured the request. Apply the same pin to the optional conflict-hint and manual workflows if you use them. The external conflict-hint workflow does not need its engine-only `sparse-checkout` list.

The action bundles the engine through the selected repository commit, sets up the pinned Node.js version, and adds `squad-engine` to `PATH`. Commands map to the existing entrypoints: `plan`, `route`, `stages`, `revise`, `report`, `postprocess`, `install-tools`, `preflight`, `dispatch`, `diagnose`, and `stage-pem`. Arguments pass through unchanged without shell evaluation. `dispatch publish` invokes the existing trusted publisher.

The working directory and `--repo "$GITHUB_WORKSPACE"` always refer to your trusted target checkout. Your roster, charters, `.squad/sandbox-flow.json`, captured requests, and generated plans stay there. `SQUAD_ENGINE_ROOT` and the action's `engine-root` output refer only to the pinned engine bundle. GitHub-script steps load engine modules from that root, never from target `scripts/`. Do not check out a PR head or a sandbox patch as trusted engine code.

Keep the App private key and write installation token in the protected publish job. Do not pass them to the action setup, dispatcher, postprocess, or sandbox. Metadata jobs retain their existing limited workflow-token writes. Packaging does not change runtime behavior or enable execution: `SQUAD_ISSUE_FLOW_ENABLED`, the single-issue `SQUAD_ISSUE_OPT_IN_NUMBER`, and all existing opt-in checks still apply.

## How the flow works

1. A repository collaborator with write access applies `sandbox-run` to an open issue.
2. The workflow validates the issue and the exact opt-in issue number before Azure authentication.
3. The Lead selects one to three active non-lead members with disjoint owned paths. The repository config supplies path limits by member kind or exact role.
4. Independent members run in the first stage. Members that depend on first-stage work run in the second stage. The flow supports up to two stages and a bounded AI-credit budget.
5. The dispatcher validates each patch and integrates the combined result. Generic checks verify patch application, scope, symlinks, and likely secret material.
6. Optional postprocess steps run from the trusted base checkout. The workflow records a run binding for the final patch.
7. A GitHub App publishes one draft PR. Lifecycle labels and a report comment record the result.

Issue text, comments, member output, and PR diffs are untrusted task data. They do not grant additional repository or workflow permissions. The flow reads `.squad/sandbox-flow.json` from the trusted checkout, never from a member patch or PR branch.

## Prerequisites and bootstrap steps

The Terraform and Bicep bootstrap paths create the legacy ACA Job resources by default. Optional Sandbox resources must be configured separately before enabling this flow.

1. **Create or install a GitHub App** on the target repository. Grant `contents: write`, `pull_requests: write`, and `issues: write`. Set its App ID and installation ID as `SQUAD_GITHUB_APP_ID` and `SQUAD_GITHUB_APP_INSTALLATION_ID` in the protected `squad-publish` environment. Store its private key as the `SQUAD_GITHUB_APP_PRIVATE_KEY_PEM` environment secret. Do not put the key in repository files or pass it to a dispatcher or sandbox.
2. **Create the `squad-sandbox-issue` environment** and restrict deployments to the protected default branch. Add required reviewers if your organization requires them.
3. **Create the `squad-publish` environment** with its own branch restrictions and required reviewers. The publish workflow needs the GitHub App variables and private key described above.
4. **Configure Azure OIDC trust** on the Sandbox dispatcher identity. For this workflow, the default subject is `repo:<owner>/<repository>:environment:squad-sandbox-issue`. Use issuer `https://token.actions.githubusercontent.com` and audience `api://AzureADTokenExchange`. Create the GitHub environment before the first Azure login. If your organization customizes OIDC subjects, match the exact `sub` claim used by the repository.
5. **Set the issue-flow variables** at repository scope. Start with `SQUAD_ISSUE_FLOW_ENABLED=false`. Set `SQUAD_ISSUE_OPT_IN_NUMBER=0`; replace it with the one approved issue number before enabling the flow.
6. **Set Sandbox runtime variables** in the `squad-sandbox-issue` environment, or at repository scope when appropriate:

   | Variable | Value |
   |---|---|
   | `SQUAD_SANDBOX_GROUP_NAME` | Configured ACA Sandbox Group name |
   | `SQUAD_SANDBOX_REGION` | Azure region configured for the Sandbox Group |
   | `SQUAD_SANDBOX_RESOURCE_GROUP_NAME` | Resource group containing the Sandbox Group |
   | `SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID` | Client ID of the identity authorized to pull the persona image |
   | `SQUAD_SANDBOX_AZURE_CLIENT_ID` | Client ID of the trusted dispatcher identity |
   | `SQUAD_SANDBOX_AZURE_TENANT_ID` | Azure tenant ID |
   | `SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
   | `SQUAD_SANDBOX_IMAGE_REF` | Immutable persona image reference with a SHA-256 digest |

   Do not use a mutable image tag for a live run. The persona image differs from the legacy `agents/base/` ACA Job image. Verify the image-pull identity and registry permissions for your Azure environment.
7. **Create labels.** Ensure the repository has `sandbox-run`, `sandbox:processing`, `sandbox:queued`, `sandbox:revising`, `sandbox:ready`, and `sandbox:failed`. Bootstrap hooks create these labels. Squad creates member labels from `.squad/team.md`. Confirm a maintainer can apply `sandbox-run` and approve protected environments.
8. **Enable one issue only.** Set `SQUAD_ISSUE_FLOW_ENABLED=true`, set `SQUAD_ISSUE_OPT_IN_NUMBER` to that issue number, then apply `sandbox-run`. Turn the variable off after the test if you do not want to keep the flow enabled.

The workflow uses the Actions token for Copilot requests. It does not use a stored Copilot PAT in the persona sandbox. The publish App key is isolated to the publish job.

## Configure the flow

Place one trusted configuration file at `.squad/sandbox-flow.json` on the base branch. Version 1 is strictly validated: unknown fields, malformed globs, unsafe command arguments, missing tool pins, and out-of-range timeouts reject the run. The engine does not read this file from PR code.

The top-level shape is:

```json
{
  "version": 1,
  "members": {},
  "postprocess": {
    "tools": {},
    "steps": []
  }
}
```

`members` is optional. Each value has an `allowed_paths` array of repository-relative globs. Supported kinds are `implementation`, `testing`, `infrastructure`, and `documentation`. You can use `role:<exact role text>` for a role-specific override. For example:

```json
{
  "version": 1,
  "members": {
    "implementation": { "allowed_paths": ["src/**", "tests/**"] },
    "testing": { "allowed_paths": ["tests/**"] },
    "documentation": { "allowed_paths": ["docs/**", "README.md"] },
    "role:Build engineer": { "allowed_paths": ["build/**"] }
  }
}
```

If you omit the file or a member kind, the default scope is `**`. The Lead still assigns disjoint scopes, and the engine always blocks `.github/**`, `.squad/**`, any `.git` path, absolute paths, traversal, symlinks that escape the checkout, and the Squad engine's own files when it runs in the bootstrap repository. These denials cannot be changed by configuration. Integration has generic safety checks only; per-kind custom check commands are not supported yet.

### Postprocess steps

Postprocess is optional. Without `postprocess`, the workflow passes the integrated patch through unchanged and records its run binding. A step runs only when its `paths` match at least one touched patch path. Each step has a unique name, an argv array, a path scope, and an optional `timeout_ms` between 1,000 and 600,000. Commands do not run through a shell.

`tools` maps an executable name to a pinned `version`, HTTPS `url`, and SHA-256 checksum. The generic installer downloads the declared artifact, verifies its checksum, and installs the executable in the workflow temp directory. ZIP files are supported when they contain exactly one regular file whose basename matches the declared tool name. `node` is built into the runner and does not need a tool pin. Do not use mutable URLs or placeholder checksums in a live config.

A minimal configuration with no postprocess is:

```json
{
  "version": 1,
  "members": {
    "implementation": { "allowed_paths": ["src/**"] }
  }
}
```

A Node example that formats one matched file is:

```json
{
  "version": 1,
  "members": {
    "implementation": { "allowed_paths": ["src/**"] }
  },
  "postprocess": {
    "tools": {},
    "steps": [
      {
        "name": "format-source",
        "run": ["node", "-e", "require('node:fs').writeFileSync('src/generated.js', 'generated\\n')"],
        "paths": ["src/**"],
        "timeout_ms": 30000
      }
    ]
  }
}
```

This Terraform example uses a pinned official Linux archive. Replace the checksum with the SHA-256 for the exact downloaded artifact before use:

```json
{
  "version": 1,
  "members": {
    "infrastructure": { "allowed_paths": ["infra/**"] }
  },
  "postprocess": {
    "tools": {
      "terraform": {
        "version": "1.9.8",
        "url": "https://releases.hashicorp.com/terraform/1.9.8/terraform_1.9.8_linux_amd64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
      }
    },
    "steps": [
      {
        "name": "terraform-format",
        "run": ["terraform", "fmt", "-recursive", "-check"],
        "paths": ["infra/**/*.tf"],
        "timeout_ms": 120000
      }
    ]
  }
}
```

The all-zero checksum is a format placeholder only and will fail download verification. Replace it with the official artifact digest. The Terraform brace check is not part of the generic flow. Add a repository-appropriate check as an explicit postprocess step if needed.

The engine checks every postprocess step's filesystem changes. A step that changes a denied or out-of-scope path fails, even if its configured glob is broad. Keep scopes as narrow as possible.

## Revise a Sandbox PR

A trusted repository collaborator can comment on an open Sandbox PR:

```text
/squad revise <instructions>
```

To restrict routing to one member, use that member's logical ID:

```text
/squad revise <member-id>: <instructions>
```

The workflow accepts only PRs authored by the publisher App in the `squad/aca-sandbox/issue-*` branch namespace. It checks the commenter association, preserves the original member assignment, and validates the captured PR head against the base branch. The member stage revises the existing branch rather than creating a replacement PR. A compare-and-swap head lease prevents the workflow from overwriting a branch that changed after validation.

If the base branch has advanced but is not included in the PR, the workflow refuses to continue. Merge the base branch into the PR branch and resolve conflicts manually. The `squad-sandbox-conflicts.yml` workflow adds a deduplicated conflict hint when GitHub confirms that an owned PR conflicts with the base branch. The workflow does not resolve conflicts automatically.

The existing ACA Job `/squad revise` workflow continues to handle its own branches. Sandbox PRs use the distinct `squad/aca-sandbox/issue-*` namespace, so the two revise workflows do not process the same PR.

## Labels

| Label | Meaning |
|---|---|
| `sandbox-run` | Input label that requests the opt-in Sandbox issue workflow |
| `sandbox:processing` | Work is being dispatched |
| `sandbox:queued` | A draft PR has been published and awaits review |
| `sandbox:revising` | A validated revise run is in progress |
| `sandbox:ready` | Dispatch and publication completed successfully |
| `sandbox:failed` | A stage, cleanup, postprocess, or publication failed |
| `squad:<member>` | Member assignment labels used on the PR and by revise routing |

Bootstrap hooks create the trigger and lifecycle labels. Squad and the publisher create member labels. The run updates lifecycle labels as work moves through dispatch and publication.

## Troubleshooting

Integration checks run in a Git-free copy of the integrated tree. The dispatcher passes the validated changed paths as data, including paths from previous member stages. Checks never discover a parent repository or scan unrelated runner files. Patch application and scope checks still run in the integration worktree before this isolated check. This host-side change does not require a persona image rebuild.

`verify-generic-changes` returns `INTEGRATION_CHECK_FAILED` with a safe reason in the dispatcher summary. Reasons include `DENIED_PATH:<path>`, `ESCAPES_REPO:<path>`, `SYMLINK_ESCAPE:<path>`, `SECRET_PATTERN:<path>`, `FILE_INSPECT_FAILED:<path>`, and `CHECK_CONTEXT_INVALID`. No file content is reported. For `CHECK_CONTEXT_INVALID`, update the dispatcher and plan generator together so the check receives its changed-path context.


| Code or symptom | Meaning and next step |
|---|---|
| `NO_CHANGES` | The combined member patches are empty. A revise run reports this on the existing PR and skips postprocess and publication. Check whether the requested change already exists or needs a more specific objective. |
| `POSTPROCESS_ARGUMENTS_INVALID` | The postprocess CLI received a missing, duplicate, or malformed argument. Rerun the workflow and inspect its trusted invocation. |
| `SANDBOX_FLOW_CONFIG_INVALID` | The config has an unsupported field, malformed glob, invalid tool pin, unsafe argv, or invalid timeout. Fix `.squad/sandbox-flow.json` on the base branch. |
| `SANDBOX_TOOL_CHECKSUM_FAILED` | A downloaded tool does not match its configured digest. Verify the HTTPS URL and SHA-256 for the exact artifact. |
| `POSTPROCESS_STEP_FAILED` | A configured command failed or timed out. Check its argv, tool pin, runner compatibility, and timeout. |
| `POSTPROCESS_SCOPE_VIOLATION` | A step changed a denied or out-of-scope file. Narrow the step or fix the tool configuration. |
| `REVISE_MAIN_NOT_INCLUDED` | The PR branch does not contain the current base branch. Merge the base branch, resolve conflicts, then post a new revise comment. |
| `REVISE_BRANCH_HEAD_MOVED` | The PR head changed after the revise request was captured. Review the new changes and post a new revise comment. |
| Head lease refusal | The remote branch no longer matches the captured PR head. The workflow does not overwrite it. Inspect the PR and rerun only with a newly validated request. |
| `SQUAD_ISSUE_OPT_IN_NUMBER` mismatch | The issue number is not the approved issue. Set the exact issue number or keep the flow disabled. |
| Azure OIDC login fails | Confirm the environment exists and the identity FIC subject matches `repo:<owner>/<repository>:environment:squad-sandbox-issue`. |
| Image pull fails | Verify the immutable image digest, image-pull client ID, registry permissions, and Sandbox Group image identity configuration. |

See [Troubleshooting](troubleshooting.md) for legacy ACA Job failures and additional diagnostics.

## Disable or roll back

To stop new Sandbox issue runs, set `SQUAD_ISSUE_FLOW_ENABLED=false` or remove the `sandbox-run` label. The flow is disabled by default. The existing ACA Job dispatch remains unchanged and is still the default path. Keep `squad-queue.yml` and the legacy ACA Job resources in place. Do not delete a Sandbox Group or identity until running work has stopped and cleanup has been verified.

## Related documentation

- [Adoption guide](adoption-guide.md)
- [Infrastructure](infrastructure.md)
- [Dispatcher reference](../dispatcher/README.md)
- [Troubleshooting](troubleshooting.md)
