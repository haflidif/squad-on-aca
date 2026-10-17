# Opt-in ACA Sandbox issue flow

> **Preview:** This workflow is separate from the default ACA Job queue path. It creates temporary ACA Sandboxes and a draft pull request. Keep it disabled until the target repository has the required Sandbox Group, identity, image, GitHub environments, and OIDC trust.

Try this after setup:

```text
Label issue #<number> with sandbox-run
```

The `squad-sandbox-issue.yml` workflow routes work through the Squad roster, runs members in dependency-ordered stages, integrates their patches, applies trusted postprocess steps, and publishes one draft pull request. The existing `squad-queue.yml` workflow remains the default ACA Job path. This Sandbox workflow stays off unless you explicitly enable it.

---

## How the flow works

1. A repository collaborator with write access applies `sandbox-run` to an open issue.
2. The workflow validates the issue and the exact opt-in issue number before Azure authentication.
3. The Lead selects one to three active non-lead members with disjoint owned paths.
4. Independent members run in the first stage. Members that depend on first-stage work run in the second stage. The workflow allows a maximum of two stages and reserves a bounded AI-credit budget.
5. The dispatcher verifies each patch and runs integration checks against the combined result.
6. Trusted postprocess steps run from the target repository's checked-out configuration. The workflow then validates a run binding for the final patch.
7. A GitHub App publishes one draft PR. Lifecycle labels and a report comment record the result.

The issue title, issue body, comment, member output, and PR diff are untrusted task data. They do not grant additional repository or workflow permissions.

## Prerequisites and bootstrap steps

The current Terraform and Bicep bootstrap paths create the legacy ACA Job resources by default. Terraform can create the optional Sandbox Group and dispatcher identity when `enable_aca_sandbox = true`. The complete Sandbox Group image-pull configuration is not yet bootstrapped by the standard setup path. Configure and verify that resource separately before enabling this workflow.

1. **Create or install a GitHub App** on the target repository. Grant `contents: write`, `pull_requests: write`, and `issues: write`. Record the App ID and installation ID. Generate a private key and store it only as the `SQUAD_GITHUB_APP_PRIVATE_KEY_PEM` secret in the protected `squad-publish` environment.
2. **Create the `squad-sandbox-issue` GitHub environment** and restrict deployments to the repository's protected default branch. Use required reviewers for the environment if required by your organization.
3. **Create the `squad-publish` GitHub environment** and configure required reviewers and branch restrictions. Set `SQUAD_GITHUB_APP_ID` and `SQUAD_GITHUB_APP_INSTALLATION_ID` as environment variables or repository variables. Set `SQUAD_GITHUB_APP_PRIVATE_KEY_PEM` as an environment secret. The workflow stages and removes a temporary key file only in the publish job.
4. **Configure Azure OIDC trust** on the Sandbox dispatcher user-assigned identity. The subject for the issue workflow is `repo:<owner>/<repository>:environment:squad-sandbox-issue`; issuer is `https://token.actions.githubusercontent.com`; audience is `api://AzureADTokenExchange`. The Terraform optional Sandbox Group path creates this environment subject for each `target_repos` entry when enabled. Create the GitHub environment before the first Azure login. If your organization customizes GitHub OIDC subjects, match the exact `sub` claim used by that repository.
5. **Set issue-flow variables.** Set `SQUAD_ISSUE_FLOW_ENABLED` to `false` initially. The bootstrap sets `SQUAD_ISSUE_OPT_IN_NUMBER` to `0`; replace it with the single approved issue number before enabling the flow. The gate job reads these repository variables before it can access a protected environment.
6. **Set Sandbox runtime variables** in the `squad-sandbox-issue` environment, or as repository variables when appropriate:

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

   Do not use a mutable image tag for a live run. The persona image is separate from the legacy `agents/base/` ACA Job image. The image-pull identity and Sandbox Group registry configuration must be validated for your Azure environment.
7. **Bootstrap labels and review access.** The Terraform setup and post-provision hooks create `sandbox-run` and the lifecycle labels for each target repository. Squad creates member labels from `.squad/team.md`. Confirm a maintainer can apply `sandbox-run` and approve the protected environments.
8. **Enable one issue only.** Set `SQUAD_ISSUE_FLOW_ENABLED` to `true`, set `SQUAD_ISSUE_OPT_IN_NUMBER` to the approved issue number, then apply `sandbox-run`. Remove the label or turn the variable off after the test.

The workflow uses the current Actions token for Copilot requests. It does not use a stored Copilot PAT in the persona sandbox. The publish App key is not passed to the dispatcher or sandbox.

## Configure postprocess steps

Postprocess is optional. If `.squad/sandbox-postprocess.json` is absent, the workflow copies the integrated patch through unchanged and records its run binding. Configuration is read from the checked-out target repository, not from PR code. Only argv-based `terraform`, `terraform-docs`, and `node` commands are accepted. Shell command strings are not supported. Each step must declare a path scope, a unique name, and an optional bounded timeout. The workflow rejects changes outside that scope.

The bootstrap repository does not contain an `examples/terraform/` directory, so do not add a live Terraform config here. For a bootstrapped target repository that has that directory, this is an example config to adapt:

```json
{
  "version": 1,
  "tools": {
    "terraform": "1.13.5"
  },
  "steps": [
    {
      "name": "terraform-format",
      "run": ["terraform", "fmt", "-recursive", "-check"],
      "paths": ["examples/terraform/**"],
      "timeout_ms": 120000
    }
  ]
}
```

Pin tool versions. Do not run a postprocess command against untrusted input or widen its path scope to `.github`, `.squad`, `dispatcher`, `scripts`, or `infra`. The command receives no shell interpretation. See [`issue-postprocess.cjs`](../scripts/issue-postprocess.cjs) for the exact validation rules.

## Revise a Sandbox PR

A trusted repository collaborator can comment on an open Sandbox PR:

```text
/squad revise <instructions>
```

To restrict routing to one member, use that member's logical ID:

```text
/squad revise <member-id>: <instructions>
```

The workflow accepts only PRs authored by a GitHub App bot in the `squad/aca-sandbox/issue-*` branch namespace, and it checks that the commenter has a trusted repository association. It preserves the original member assignment and validates the captured PR head against current `main`. The member stage revises the existing branch rather than creating a replacement PR. A compare-and-swap head lease prevents the workflow from overwriting a branch that changed after validation.

If main has advanced but is not included in the PR, the workflow refuses to continue. Merge current main into the PR branch and resolve conflicts manually. The `squad-sandbox-conflicts.yml` workflow adds one deduplicated conflict hint to an owned PR when GitHub confirms that it conflicts with main. The hint asks a maintainer to resolve the conflict and submit a new revise comment. The workflow never resolves conflicts automatically.

The existing ACA Job `/squad revise` workflow continues to handle its own `squad/<agent>/issue-<number>` branches. Sandbox PRs use the distinct `squad/aca-sandbox/issue-*` namespace, so the two revise workflows do not process the same PR.

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

Terraform and the post-provision hooks create the trigger and lifecycle labels. `squad init` and the publisher create member labels. Lifecycle labels are terminally cleaned up when a run completes.

## Troubleshooting

| Code or symptom | Meaning and next step |
|---|---|
| `NO_CHANGES` | The combined member patches are empty. A revise run reports this on the existing PR and skips postprocess and publication. Check whether the task already exists or needs a more specific objective. |
| `POSTPROCESS_ARGUMENTS_INVALID` | The postprocess CLI received a missing, duplicate, or malformed argument. Rerun the workflow and inspect the trusted workflow invocation. |
| `POSTPROCESS_CONFIG_INVALID` | The checked-out config has an unsupported field, executable, tool version, path, or timeout. Fix the repository config and rerun. |
| `REVISE_MAIN_NOT_INCLUDED` | The PR branch does not contain current main. Merge main and resolve conflicts manually, then post a new revise comment. |
| `REVISE_BRANCH_HEAD_MOVED` | The PR head changed after the revise request was captured. Review the new changes and post a new revise comment. |
| Head lease refusal | The remote branch no longer matches the captured PR head. The workflow does not overwrite it. Inspect the PR and rerun only with a new validated request. |
| `SQUAD_ISSUE_OPT_IN_NUMBER` mismatch | The issue number is not the single approved issue. Set the exact issue number or keep the flow disabled. |
| Azure OIDC login fails | Confirm the `squad-sandbox-issue` environment exists and the identity FIC subject exactly matches `repo:<owner>/<repository>:environment:squad-sandbox-issue`. |
| Image pull fails | Verify the immutable `SQUAD_SANDBOX_IMAGE_REF`, image-pull client ID, registry permissions, and Sandbox Group image identity configuration. |

See [Troubleshooting](troubleshooting.md) for legacy ACA Job failures and additional diagnostics.

## Disable or roll back

To stop new Sandbox issue runs, set `SQUAD_ISSUE_FLOW_ENABLED` to `false` or remove the `sandbox-run` label. The workflow is disabled by default. Existing ACA Job dispatch remains unchanged and is still the default product path. To roll back a deployment, disable the optional `enable_aca_sandbox` Terraform feature, keep the issue-flow variable false, and leave the legacy ACA Job resources and `squad-queue.yml` workflow in place. Do not delete a Sandbox Group or identity until all running work has stopped and cleanup has been verified.

## Related documentation

- [Adoption guide](adoption-guide.md)
- [Infrastructure](infrastructure.md)
- [Dispatcher reference](../dispatcher/README.md)
- [Troubleshooting](troubleshooting.md)
