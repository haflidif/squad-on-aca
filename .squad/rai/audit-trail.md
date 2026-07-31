# RAI Audit Trail

> Append-only, redacted evidence log. Never contains raw secrets, PII, or harmful content — only file paths, line ranges, categories, severity, fingerprints, and remediation status.

_No entries yet._

## 2026-07-30T13:34:57+02:00 — Issue #9 azd/Bicep IaC minimal RAI scan

- infra\bicep\main.bicep:9-11,204-207; infra\bicep\modules\keyvault.bicep:10-13; infra\bicep\modules\container-app-job.bicep:93-144 — credential values in Bicep — 🟢 Green — No hardcoded secret values or Bicep-created Key Vault secret values found; only secret-name references/placeholders. Remediation: none.
- infra\bicep\modules\container-app-job.bicep:79-119; infra\bicep\modules\storage.bicep:31-37; infra\bicep\modules\acr.bicep:25-35; infra\terraform\main.tf:58,236-261 — identity-based storage/KEDA/registry auth — 🟢 Green — Container job uses UAMI for ACR pull and KEDA queue auth; storage shared key disabled. Remediation: none.
- infra\bicep\modules\acr.bicep:31-32; infra\terraform\main.tf:81-88 — registry admin credential surface — 🟡 Yellow — ACR admin credentials are enabled for local dev, although runtime registry access uses UAMI. Remediation: not applied; consider disabling admin credentials or making them explicitly non-production only.
- infra\terraform\terraform.tfvars.example:1-10; infra\terraform\variables.tf:30-33; infra\terraform\providers.tf:48-51 — Terraform token handling — 🟢 Green — GitHub token is marked sensitive and examples use placeholders/environment variable guidance only. Remediation: none.
- infra\terraform\ (git ls-files) and .gitignore:2-7 — tfstate/tfvars hygiene — 🟢 Green — No terraform.tfstate, terraform.tfstate.backup, or terraform.tfvars files are tracked; ignore rules cover state, tfvars, and .terraform. Remediation: none.
- azure.yaml/hooks — azd hook logging — 🟢 Green — No azure.yaml or hooks files found in the current tree at scan time. Remediation: none.
## 2026-07-30T14:06:01+02:00 — Follow-up azd hook credential scan

- azure.yaml:1-66 — hardcoded credentials / secret values — 🟢 Green — No hardcoded credential values found; only secret names and placeholder setup guidance. Status: no remediation.
- infra\hooks\preprovision.sh:37-71; infra\hooks\preprovision.ps1:31-65 — preprovision environment logging — 🟢 Green — Logged values are app IDs, installation IDs, principal IDs, and repo targets; no secret values are handled here. Status: no remediation.
- infra\hooks\postprovision.sh:151-199; infra\hooks\postprovision.ps1:171-207 — Key Vault secret handling — 🟢 Green — Hooks check secret existence by ID and print redacted/file or placeholder guidance only; no discovered secret value is echoed, written to files, or logged. Status: no remediation.
- infra\hooks\postprovision.sh:186-195; infra\hooks\postprovision.ps1:196-204 — secret upload command guidance — 🟡 Yellow — Printed guidance includes command-line value placeholders/variables for manual secret upload; no real value is embedded or executed by the hook, but operators should avoid placing real secret values in process listings. Status: advisory only; no code change in review-only pass.
- infra\hooks\postprovision.sh:229-268; infra\hooks\postprovision.ps1:238-274 — GitHub Actions variable setup — 🟢 Green — gh variable set is used only for non-secret identifiers (Azure client, tenant, subscription, storage account, queue). No plaintext secret is written as an Actions variable. Status: no remediation.
