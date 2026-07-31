# Rai — History

## Seed Context (2026-07-30)

- **Project:** squad-on-aca — Infrastructure for running Squad agents on Azure Container App Jobs with event-driven KEDA scaling.
- **Stack:** Terraform (Azure Verified Modules), Docker, Python (Azure Functions), GitHub Actions, Azure Container Apps, KEDA, Storage Queues.
- **Owner:** Haflidi Fridthjofsson.
- **Added by:** Haflidi (via Coordinator) — team predated the default Rai roster addition; added on request after `squad doctor`.
- **Project type:** Infrastructure → minimal mode. Primary focus: hardcoded credentials/secrets in Terraform, Docker, GitHub Actions, and Python. Injection and harmful-content checks apply where user-facing code exists.

## Learnings

_None yet._
- **2026-07-30 — Issue #9 azd/Bicep delivered:** Completed credential and secret handling scans for the new Bicep and azd hook path with Yellow overall verdict and no critical leaks; advisory notes covered ACR admin parity and file-based secret upload guidance.
