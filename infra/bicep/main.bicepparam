/*
  Squad on ACA — Bicep Parameter File
  Usage: az deployment sub create --location swedencentral --template-file main.bicep --parameters main.bicepparam

  Fill in the REQUIRED values before deploying:
    - githubAppId
    - githubAppInstallationId
    - deployerPrincipalId  (run: az ad signed-in-user show --query id -o tsv)

  After deployment, upload secrets manually:
    KV=$(az deployment sub show -n squad-aca-dev --query properties.outputs.key_vault_name.value -o tsv)
    az keyvault secret set --vault-name "$KV" --name "github-app-private-key" --file ./path/to/key.pem
    az keyvault secret set --vault-name "$KV" --name "copilot-pat" --value "YOUR_COPILOT_PAT"
*/

using './main.bicep'

// ---------------------------------------------------------------------------
// Required — fill in before deploying
// ---------------------------------------------------------------------------

param githubAppId             = 'YOUR_GITHUB_APP_ID'
param githubAppInstallationId = 'YOUR_GITHUB_APP_INSTALLATION_ID'
param deployerPrincipalId     = 'YOUR_DEPLOYER_OBJECT_ID'   // az ad signed-in-user show --query id -o tsv

// ---------------------------------------------------------------------------
// Optional — defaults match Terraform parity
// ---------------------------------------------------------------------------

param location       = 'swedencentral'
param projectName    = 'squad-aca'
param environment    = 'dev'
param githubRepo     = 'haflidif/squad-on-aca'
param queueName      = 'squad-work-queue'
param targetRepos    = []   // e.g. ['your-org/your-repo']

// Agent job defaults
param agentCpu            = '1.0'
param agentMemory         = '2Gi'
param agentMaxExecutions  = 10
param agentTimeoutSeconds = 1800

// nameSuffix is auto-derived from subscription + project + environment by default.
// Override here to keep resource names stable across redeployments in the same env:
//   param nameSuffix = 'a1b2c3d4'
