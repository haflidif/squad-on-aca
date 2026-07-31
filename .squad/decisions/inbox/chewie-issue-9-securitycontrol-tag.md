# Decision: Add SecurityControl=ignore tag to all IaC resources

**Date:** 2026-07-31T08:22:39.479+02:00
**Author:** Chewie (IaC Dev)
**Issue:** #9 (azd/Bicep support)
**Branch:** squad/9-azd-bicep-support

## What

Added the tag `SecurityControl: 'ignore'` (Bicep) / `SecurityControl = "ignore"` (Terraform) to
the shared tags object in both IaC paths:

- **Bicep**: `var tags` in `infra/bicep/main.bicep` — propagated automatically to all modules and
  the resource group (identity, monitoring, storage, ACR, Key Vault, ACA environment, Container
  App Job).
- **Terraform**: `variable "tags"` default in `infra/terraform/variables.tf` — propagated to all
  resources via `tags = var.tags`.

## Why

A live e2e deploy of the Bicep/azd path into the user's subscription failed smoke-test assertions
because an Azure Policy on that subscription forces `publicNetworkAccess: Disabled` on all Key
Vaults, overriding the Bicep's `publicNetworkAccess: 'Enabled'`. This blocked the public-plane
`az keyvault secret set` call required to upload the GitHub App private key and Copilot PAT
post-provision. The user confirmed that resources tagged `SecurityControl = ignore` are exempt from
these subscription policies.

## Security Note

This tag intentionally bypasses a subscription security control (Key Vault public network access
enforcement). It is user-authorized for this environment. As implemented, the tag is applied to
**all** resources in **all deployments** from this IaC by default — including production.

**Recommendation for production hardening**: Parameterize the exemption (e.g., a
`var.enable_security_control_exemption` boolean that defaults to `false`), so that production
deployments do not carry the exemption tag by default. The current always-applied approach is
correct for the user's dev/test environment per their direct request, but production deployments in
security-constrained subscriptions should evaluate whether the exemption is appropriate.

## Alternatives Considered

1. **Parameterize the tag (opt-in)** — more secure for production, but adds friction for the
   primary use case (dev/test in the user's constrained subscription). Deferred to a follow-up
   issue.
2. **Per-resource tag on Key Vault only** — narrower blast radius but inconsistent; other resources
   may be affected by similar subscription policies in the future. Rejected in favour of the shared
   tags object.

## Files Changed

- `infra/bicep/main.bicep` — added `SecurityControl: 'ignore'` to `var tags`
- `infra/terraform/variables.tf` — added `SecurityControl = "ignore"` to `variable "tags"` default
- `docs/infrastructure.md` — documented the network access / tag policy in the Key Vault section
- `docs/e2e-testing.md` — added policy-constrained subscription note to KV secret upload guidance
