# ACA Sandbox Runner Image Release Scope

> **Status:** Deployed
> **Recipe:** AZCLI
> **Scope:** Build and publish one unique, immutable persona-worker image to the existing approved ACR. This scoped plan does not validate the broader ACA Sandbox deployment plan.

## Approval and limits

**Credit-limit follow-up, 2026-10-13:** Haflidi approved the tightly coupled
production runner fix and a new unique image publication. Every persona defaults
to `--max-ai-credits 30` with Copilot CLI 1.0.96. This is a soft per-persona
AI-credit limit, not a hard USD cap. This follow-up does not run live AI, create
cloud sandboxes, change federation/RBAC, operate the shared disk, or publish git
changes. The older release below is history, not proof for the updated bytes.

Haflidi explicitly approved applying the verified runner and Copilot package-cache fixes, building a uniquely tagged image, publishing it to the existing `crsquadacaa6b49feb` registry, and verifying its digest. No tag may be overwritten. The existing shared disk, legacy ACA Job, managed environment, identities, role assignments, Terraform state, GitHub organization policy, and billing settings are out of scope.

The source checkout is `feature/aca-sandbox-ga` at `d2fa31702f2ad83407af4810ccd97a695d24c4cf`, plus pre-existing uncommitted changes. No commit, push, PR, or merge is authorized. The local WSL Docker build pins the official GitHub Copilot CLI 1.0.96 release asset and its SHA-256; it does not install Copilot from npm and creates no persistent compute host. A narrow allowlisted scratch context and ephemeral Docker authentication are permitted.

## Azure context

- Subscription: `e69b8a95-fe38-42da-b5e6-e3e0a833cf9e`
- Tenant: `49ff7219-653a-4644-8540-71d16dbf9c16`
- Existing ACR: `crsquadacaa6b49feb.azurecr.io`
- ACR resource group: `rg-squad-aca-dev-a6b49feb`
- Build location: existing registry's `swedencentral` region.
- Azure CLI profile: process-local `AZURE_CONFIG_DIR` at `%USERPROFILE%\.squad-sandbox-lab\azcfg`; do not change the global Azure context.

## Resource and role scope

No ARM resources are created, updated, or deleted. The Bicep template only references the existing ACR and is used for read-only validation/what-if. The operator's existing registry authorization is used for base-image pull and one uniquely tagged image push; no role assignment or credential change is permitted.

| Resource | Planned deployment | Current state / validation |
| --- | --- | --- |
| `Microsoft.ContainerRegistry/registries` | 0 | Existing registry only; validate with read-only ARM checks. |
| Other Azure resources | 0 | None in scope. |

## Validation checks

- All validation checks pass:
  - [x] AZCLI core validation: CLI version, isolated-context authentication, Bicep build, resource-group validation, and zero-change what-if.
  - [x] Docker build verification: WSL Ubuntu Docker built the dirty-source snapshot; root and UID 10001 production-image proofs passed.
  - [x] Azure Policy assignments were read at the existing ACR resource-group scope; no policy changes or exemptions.
- [x] Official AZCLI core validation script passed for the read-only existing-ACR template; what-if reported zero Create, Modify, and Delete.
- [x] Docker context allowlist includes only sandbox runtime and contract files; no environment files, session artifacts, or credentials are in the build context.
- [x] Focused auth, dispatcher-preflight, and runner/Dockerfile tests passed; Linux image validation now exercises the credential and Git boundaries rather than relying on Windows-only skips.
- [x] Static RBAC review found no role assignment or identity changes in the scoped Bicep template. Existing caller roles were read-only inspected; no RBAC changes were made.
- [x] ACR repository tags were checked read-only. The only existing persona image tag is `e5e721a`; candidate `runner-1-0-96-cache-595803ec` was absent.
- [x] Deployment gate: publish the unique image and verify its manifest digest, runner hash, source label, and Copilot CLI version.

## Section 7: Validation proof

**Release follow-up correction:**  The coordinator verified `/usr/bin/docker` and Docker server `27.5.1` in WSL Ubuntu. Haflidi approved unique-image publication; bounded scratch files are permitted. Earlier observations are retained as history, not current blockers.

**2026-10-13 (UTC):**

- Official validation command, run from `.azure/image-release-scope` with process-local `AZURE_CONFIG_DIR=%USERPROFILE%\.squad-sandbox-lab\azcfg` and the explicit lab subscription: `validate-deployment.ps1 -Scope group -ResourceGroup rg-squad-aca-dev-a6b49feb -Template .\infra\main.bicep -Subscription e69b8a95-fe38-42da-b5e6-e3e0a833cf9e`. Result: **PASS** for Azure CLI, isolated-context authentication, Bicep compilation, group validation, and what-if (`Create: 0, Modify: 0, Delete: 0`).
- Azure Policy assignments were retrieved read-only at `/subscriptions/e69b8a95-fe38-42da-b5e6-e3e0a833cf9e/resourceGroups/rg-squad-aca-dev-a6b49feb`; all returned assignments were inherited from parent scopes. No policy changes were made.
- Read-only ACR queries through the isolated Azure profile confirmed repository `squad/persona-sandbox` has existing tag `e5e721a`, with digest `sha256:cea1d310e7109c18d24ae57de153565c722284382c89d0bc1b441840f59e2875`. Candidate tag `runner-1-0-96-cache-595803ec` is absent. Other untagged manifests were not modified.
- Docker daemon was unavailable. The image now pins the official [`copilot-linux-x64.tar.gz` v1.0.96 release asset](https://github.com/github/copilot-cli/releases/download/v1.0.96/copilot-linux-x64.tar.gz) and checks SHA-256 `66b60b58b14d72390f30d6d7f8480d18a0f05c111d132e4ff8f92ae637d413f8` from GitHub's [`SHA256SUMS.txt`](https://github.com/github/copilot-cli/releases/download/v1.0.96/SHA256SUMS.txt). No build or image mutation was attempted: local Docker is unavailable, and no local-context ACR build was started under the no-temporary-files constraint. No credentials or npm config files were read.
- Focused results: `agents/sandbox/test/dockerfile-release.test.js` **3/3 pass**; `dispatcher/test/auth.test.js` and `dispatcher/test/local-operation.test.js` **14/14 pass**; selected workflow gate tests **3/3 pass**; `agents/sandbox/test/persona-run.test.js` **2 pass, 20 skipped** (18 require `/dev/shm` tmpfs, one requires a Linux root environment whose Git operations work on the mounted filesystem, and one requires a Docker daemon). The first WSL root probe exposed an NTFS/WSL Git limitation; the test now skips that unsupported environment instead of failing. No real persona dispatch or integration run occurred.
- At that earlier checkpoint the image-publish and live-dispatch checks were incomplete. That historical checkpoint was **not Validated**; see the verified release follow-up below. Live AI dispatch is outside this release phase, and the broader ACA deployment plan is unchanged.

### Verified release follow-up

- The official AZCLI validation helper was re-run on the scoped workspace with the isolated Azure profile and explicit subscription. All five checks passed; what-if again reported **Create 0, Modify 0, Delete 0**. The direct resource-group Azure Policy query returned `[]`; no exemptions or policy changes were requested.
- Docker server **27.5.1** in WSL Ubuntu built image `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox:runner-1-0-96-20261013T114003Z-cc8f016d6a4f` for `linux/amd64`. The legacy builder worked after omitting the unsupported BuildKit-only `--progress` flag; no global tools were installed.
- Build context was a **132.1 kB allowlisted snapshot** containing only the Dockerfile, its allowlist, sandbox runtime, and contract tools/schemas. No repository auth files, session fixtures, Git metadata, or environment files were copied.
- Dirty source manifest SHA-256: `cc8f016d6a4f8710eb0183ebd16b2b0d82560be931f291e69d3169e5279ccb7b`. This identifies the actual file bytes, not merely HEAD `d2fa31702f2ad83407af4810ccd97a695d24c4cf`. The image labels explicitly record `io.squad.source.dirty=true` and the manifest hash.
- Image inspection exposed Windows-derived mode `777` on root-owned runner files. The Dockerfile now removes group/other write permissions from runtime and contracts. The revised image passed the UID 10001 non-writability assertion; the first unhardened candidate was not published.
- Production image proofs passed **5 checks as root and 5 as UID 10001** using the image's actual `exec-with-env.js`, `persona-run.sh`, `copilot-launch.sh`, and integration runner. They cover happy persona patch generation, fd token delivery/no token in argv, credential environment cleanup, tmpfs credential HOME removal, disk package-cache path, root-owned runner non-writability, credential-leak fail-closed output, protected workflow detection, real CLI version/help, and applicable integration output. All Copilot persona execution used an offline fixture, not live AI or GitHub credentials.
- Real public Copilot **1.0.96** populated the same `${STAGING_PARENT}/.copilot-package-cache` path used by production while credential HOME/XDG remained under verified `/dev/shm` tmpfs. Root-to-UID ownership behavior passed the existing dedicated Git regression **1/1, zero skips**.
- Existing Linux-image runner/integration/Dockerfile suite: **47 passed, 0 failed, 2 skipped**. The skipped native-root and nested-Docker checks in the UID 10001 suite are separately covered by the root production-image proofs and dedicated root Git test. The process-descendant test initially saw a zombie under bare PID 1; the suite passed with Docker `--init`, which correctly reaps children. No unrelated runner behavior was changed.
- Host auth/local-operation tests: **14/14**. Final Dockerfile release tests: **4/4**. Workflow-preflight selection: **7 passed, 1 Windows symlink skip**.
- Production runner file SHA-256: `595803ecab5b30fb90bd93486c04a9d9ffb19c06105282338ce34e17124c2970`.
- Build authentication used only `az acr login --expose-token --subscription ...` captured in process memory and piped to WSL Docker `--password-stdin`. The private per-operation Docker config was logged out and removed in `finally`; no token was printed or passed in argv. Default Azure and Docker profiles were not modified.

### Credit-limit release validation proof

- Official azure-validate workflow restarted for this scope and completed
  `LoadPlan`, `AddValidationSteps`, `RunValidation`, `BuildVerification`, and
  `StaticRoleVerification` after executing the corresponding checks.
- The official AZCLI `validate-deployment.ps1` helper passed all five checks on
  2026-10-13 UTC using only isolated
  `C:\Users\haflidif\.squad-sandbox-lab\azcfg` and explicit subscription
  `e69b8a95-fe38-42da-b5e6-e3e0a833cf9e`. Read-only existing-ACR what-if:
  **Create 0, Modify 0, Delete 0**. Direct group-scope policy assignments: `[]`.
- WSL Ubuntu Docker **27.5.1** built unique candidate
  `runner-creditcap-1-0-96-20261013T121607Z-03ce4f75324f` from an allowlisted
  **136.2 kB** dirty-source snapshot. Source-manifest SHA-256:
  `03ce4f75324f0972427d47e4569cfd09e3477330b41eefad005cf2f80edac90f`.
  Copilot CLI **1.0.96** release asset remains pinned to
  `66b60b58b14d72390f30d6d7f8480d18a0f05c111d132e4ff8f92ae637d413f8`.
  Build verifies both actual version and advertised `--max-ai-credits` support.
- Production runner SHA-256:
  `19cd5ea0dc76971b8f8352fd7067b99468c165189a0a5e1e93fcf3c406742511`.
  Actual-image fixture proofs passed **5/5 as root and 5/5 as UID 10001**:
  exact argv includes one `--max-ai-credits`, followed by one `30`; fd credential
  isolation, private tmpfs HOME cleanup, non-tmpfs disk package cache, root-owned
  immutable runner, credential-leak rejection, protected paths, real CLI
  version/help and deterministic integration patch applicability.
- Linux targeted suite: **125 passed, 0 failed, 2 skipped** across production
  runner, integration, environment helper, Dockerfile, dispatcher, auth and
  credit-limit tests. Dedicated root Git regression: **1/1, zero skips**.
  The two suite skips are the separately exercised root regression and
  unavailable nested-Docker check; actual Docker image proofs cover the latter.
  Host contracts/auth/local-preflight/credit/bootstrap/Dockerfile suite:
  **49/49 passed**.
- Initial test-harness failures were resolved before the gate: the synthetic
  checkout now avoids `/workspace` fake-client remote-path rewriting, a newly
  added test was moved out of a parent test, and the classic-PAT regression
  expects the auth helper's existing rejection message without changing auth.
- Static RBAC verification: scoped Bicep references only the existing registry;
  no resources, identities or role assignments are deployed.
- Credentials used only the approved registry token flow in process memory,
  Docker `--password-stdin`, and a private per-operation config removed in
  `finally`. The source context contains no auth files or secrets.

This proof validates the new candidate only. The credit-limit follow-up
deployment result below records its completed publication and immutable-digest
byte verification; the broader deployment remains outside this scope.

## Role assignment verification

- Status: Verified.
- Static scope: the existing-ACR Bicep reference has no deployed resources, service identities, or role assignment resources.
- Authorization: existing isolated-profile registry access only; no identities, admin settings, or roles changed.

## Deployment result

### Credit-limit follow-up result (2026-10-13)

The new official azure-validate workflow completed through `UpdateStatus` before
azure-deploy executed this approved **unique image publication only** release.

- Tag: `runner-creditcap-1-0-96-20261013T121607Z-03ce4f75324f`.
- Immutable image:
  `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:4b4a2c0ac696630e17a2ec06241aafa2b6ddb3ed57e7385d7d71a4dcfa84c23d`.
- Image config ID:
  `sha256:436b4dc130fa0ce4a5e59e9cf70151658b30dbab2699cc7941a2ee5e48b3c068`.
- Pull by digest succeeded. All **21** runtime/contract file hashes match the
  exact dirty-source manifest; actual pinned Copilot CLI is **1.0.96** and its
  help advertises `--max-ai-credits`.
- Root and UID 10001 proofs passed again against the immutable digest. Captured
  persona argv is exactly
  `["--yolo","--agent","squad","--max-ai-credits","30"]`; no duplicate flag,
  shell word splitting, free-form option injection or credential argv.
- Previous tag `runner-1-0-96-20261013T114003Z-cc8f016d6a4f` remains digest
  `sha256:6d42204ed58d5d58ba705a9319b664878444d6f90832aaaf404420d58599ec13`
  and update time `2026-10-13T11:45:16.3375108Z`. No tag was overwritten.
- Private build and push Docker auth directories were removed. Existing
  subscription, group and ACR were verified in the isolated profile. No
  provisioned identities/RBAC or application endpoints exist in this scope.
- Sanitized source, test, CLI, digest and credit-limit proof is preserved as
  session-file `creditcap-release-provenance.json`. No live AI, cloud sandbox,
  shared-disk operation, FIC, RBAC, git commit/push/reset or global context
  change was performed.

### Previous runner release (historical)

The official azure-validate workflow completed through `UpdateStatus` before invoking azure-deploy. The AZCLI deployment recipe executed only the approved existing-ACR image publication, not an ARM deployment or application update.

- Published tag: `runner-1-0-96-20261013T114003Z-cc8f016d6a4f`.
- Immutable image: `crsquadacaa6b49feb.azurecr.io/squad/persona-sandbox@sha256:6d42204ed58d5d58ba705a9319b664878444d6f90832aaaf404420d58599ec13`.
- Registry pull by immutable digest succeeded. Image config ID matches the tested local image: `sha256:06d09448f7e4375bf05862a09280c200d2834a37ccc150b5e92731922e64db27`.
- Digest-bound verification matched **all 20 runtime/contract source files** against the dirty-source manifest, verified root ownership and non-writable group/other modes, checked the source labels, and confirmed real Copilot CLI **1.0.96**. Root and UID 10001 production-image fixture proofs were repeated successfully against the immutable digest.
- Existing tag `e5e721a` remains `sha256:cea1d310e7109c18d24ae57de153565c722284382c89d0bc1b441840f59e2875`, with unchanged `lastUpdateTime` `2026-09-29T11:20:18.6607487Z`. Registry tags are exactly the old tag and the new unique tag.
- Pre-deploy checks confirmed the approved subscription, existing resource group, and existing registry in `swedencentral`. Registry admin access was already enabled; this operation did not enable it, use its credentials, or alter any registry setting.
- Azure-deploy provisioning, app endpoint checks, SQL migrations, and new managed-identity RBAC checks are **not applicable**: no resources or application identities were provisioned. Successful scoped token authentication, image push, and digest pull verify existing caller data-plane authorization; no roles changed.
- Both private Docker auth directories and config files were removed. Sanitized source manifest, image-byte verification, test results, commands, and workflow proof are preserved in the session files as `image-release-provenance.json`; Linux TAP evidence is `image-release-linux-tests.tap`.

This scoped **Deployed** status means image publication only. No sandbox create, disk delete, live AI task, commit, push, reset, or broader ACA Sandbox validation was performed. The coordinator owns the subsequent full-task phase.
