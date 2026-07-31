# Decision: dummy secrets and MCR placeholder image for infra e2e testing

**Date:** 2026-07-31
**Author:** Cassian (Tester)
**Issue:** #9 — azd/Bicep support — live e2e run
**Status:** Accepted

---

## Context

Live e2e run against subscription 1d2c04aa (swedencentral) surfaced two decisions:
1. How to handle KV secret assertions when the subscription forces KV private networking.
2. How to handle the Container App Job image chicken-and-egg on first deploy.

---

## Decisions made

### 1. Dummy secrets for infra e2e (accepted with caveats)

**Decision:** Upload placeholder values (`dummy-e2e-placeholder`) for both KV secrets after provisioning so the smoke test can assert name presence.

**Rationale:** The smoke test is an infrastructure validator — it checks that the secret NAME exists (confirming RBAC and KV provisioning are correct), never the value. Dummy values satisfy the name-presence assertion without exposing real credentials.

**Constraint found:** Subscription 1d2c04aa enforces `publicNetworkAccess: Disabled` on all Key Vaults via Azure Policy, overriding the Bicep `publicNetworkAccess: 'Enabled'` setting. Neither `az keyvault secret set` nor `az keyvault update` can override this policy. The dummy secret approach could not be completed on this subscription. KV secret assertions FAIL on policy-locked subscriptions — this is expected and documented.

**Future:** If the subscription allows private endpoint access or trusted service bypass, the secret assertions will work. For subscriptions with full public access, dummy secrets work fine for e2e infra validation.

---

### 2. MCR placeholder image + postprovision job update (chosen over deployment script)

**Decision:** `container-app-job.bicep` defaults `containerImage` to `mcr.microsoft.com/hello-world:latest`. The postprovision hook runs `az containerapp job update --image` after `az acr build` to set the real image.

**Alternatives considered:**
- **ARM deployment script** to import a seed image mid-deployment: rejected — requires a temporary container instance and storage account, adds cost and timing complexity (RBAC propagation for AcrPush may not be complete when the script runs).
- **Import seed image before deploy**: rejected — ACR doesn't exist yet when the deployer starts; the ACR is created as part of the same deployment.

**Rationale:** The placeholder approach keeps the Bicep simple and self-contained. The postprovision hook already runs `az acr build`; adding `az containerapp job update` is one additional line. The MCR placeholder (`hello-world:latest`) is always publicly reachable, has no authentication requirement, and makes every first provision succeed regardless of ACR state.

**Trade-off:** Re-deploying via `az deployment sub create` resets the job's image to the placeholder. Users must re-run the postprovision hook (or `azd up` which runs it automatically) to restore the real image. This is documented in `docs/e2e-testing.md`.

---

### 3. ARM management plane for queue existence check (not data plane)

**Decision:** `az storage queue exists --auth-mode login` requires Storage Queue Data Reader RBAC for the calling principal. The deployer only has Key Vault Secrets Officer; they do not have queue data plane access. Changed to `az rest` against the ARM management plane which only requires Contributor/Owner on the resource group.

**Rationale:** The deployer who runs smoke tests is not expected to have storage data plane access (that's the UAMI's job). Using the ARM API gives equivalent assurance (the queue resource exists as an ARM object) without requiring additional RBAC grants on the deployer.
