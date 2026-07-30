### 2026-07-30T13:34:57+02:00: Issue #9 — documentation

**What:** Documented the Bicep and azd deployment path alongside the canonical Terraform path, including prerequisites, commands, post-provision secret handling, GitHub Actions variables, teardown, and a side-by-side deployment comparison.

**Why:** Issue #9 adds Azure-native Bicep support without replacing Terraform. The documentation needs to make both paths discoverable, explain when to choose each one, and preserve the security boundary that keeps Key Vault secret values out of IaC state.
