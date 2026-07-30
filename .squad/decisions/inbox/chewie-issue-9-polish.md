### 2026-07-30T13:34:57+02:00: Issue #9 — polish (principalType + Dockerfile ARG)

**Author:** Chewie (IaC Dev)
**Branch:** squad/9-azd-bicep-support
**Issue:** [#9 — Add azd/Bicep deployment support](https://github.com/haflidif/squad-on-aca/issues/9)
**Triggered by:** Cassian validation PASS-WITH-NOTES

---

#### FIX 1 — Bicep deployer principalType (MEDIUM)

**What:** Added `param deployerPrincipalType string = 'User'` (with `@allowed(['User','ServicePrincipal','Group'])`) to `infra/bicep/main.bicep`. Replaced the hardcoded `principalType: 'User'` in the Key Vault Secrets Officer role assignment with `principalType: deployerPrincipalType`. Threaded the parameter through `main.bicepparam` with a default of `'User'` and a comment directing CI/SP deployers to set `'ServicePrincipal'`.

**Why:** A service principal deployer (e.g. azd in CI, a Managed Identity) has `principalType = 'ServicePrincipal'`. Azure RBAC role assignments with `principalType: 'User'` fail when the assignee is not a user object — the assignment is rejected at the ARM layer. This fix makes the Bicep stack work for both interactive and automated deployments without any code change.

---

#### FIX 2 — Dockerfile base-image ARG (remove fragile sed workaround)

**What:** Parameterized `agents/base/Dockerfile` with a global `ARG BASE_ACR_HOST=crsquadacaa6b49feb.azurecr.io/` declared before the first `FROM`. Both `FROM` lines now use `${BASE_ACR_HOST}base/golang:...` and `${BASE_ACR_HOST}base/debian:...`. The old ACR is the default so the file remains functional without specifying the arg.

Updated both postprovision hooks (`infra/hooks/postprovision.sh` and `infra/hooks/postprovision.ps1`):
- Removed the sed / `-replace` patch logic and the `Dockerfile.azd-build` temp-file dance entirely.
- Added `--build-arg BASE_ACR_HOST=${ACR_LOGIN_SERVER}/` to the `az acr build` invocation, building directly from `agents/base/Dockerfile`.
- Kept the base-image `az acr import` step (golang + debian from Docker Hub) unchanged, as the build depends on these images being present in the ACR.
- Updated the section A comment in both hook headers to reflect the new approach.

**Why:** The sed-based workaround was fragile: it matched any `.azurecr.io` substring anywhere in the file, created a side-effect temp file that could be accidentally committed, and required parallel maintenance of both hook files whenever the Dockerfile changed. Docker's `ARG` before `FROM` is the idiomatic, supported mechanism for parameterizing base-image registries. The `--build-arg` approach is a single clean handoff at build time with no file mutation.
