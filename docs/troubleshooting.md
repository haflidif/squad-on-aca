# Troubleshooting

> Common issues and how to resolve them when running Squad on ACA.

---

## Container Job Won't Start

**Check**: KEDA isn't detecting messages on the queue.

```bash
# List Container App Jobs
az containerapp job list --resource-group rg-squad-dev-XXXX -o table

# Get job details
az containerapp job show --name "job-squad-agent-XXXX" \
  --resource-group rg-squad-dev-XXXX --output json | jq '.properties.configuration.eventTriggerConfig'
```

**Verify**:
- Storage account has `shared_access_key_enabled = false` ✅
- UAMI has Storage Queue Data Reader role ✅
- KEDA scale rule identity field is set to UAMI ID ✅

---

## Container Runs but PR Doesn't Get Created

**Check**: Container logs for errors.

```bash
# Get recent executions
az containerapp job execution list --name "job-squad-agent-XXXX" \
  --resource-group rg-squad-dev-XXXX --output table

# Get logs for a specific execution
az containerapp job execution show --name "job-squad-agent-XXXX" \
  --resource-group rg-squad-dev-XXXX \
  --execution-name "execution-id" --output json | jq '.properties.template.containers[0]'
```

**Common issues**:
- Key Vault secret missing or empty (GitHub App PEM or Copilot PAT)
- UAMI doesn't have Key Vault Secrets User role
- GitHub App installation ID is incorrect
- Target repo not in `target_repos` list

---

## Copilot CLI Fails

The container handles this gracefully by creating a work artifact. Check the PR body for `.squad-work/issue-N.md`, which includes the last 50 lines of Copilot output.

**Typical causes**:
- Copilot-licensed PAT expired or revoked
- Copilot CLI not installed correctly in image
- Network issue (timeout reaching GitHub API)

---

## OIDC Token Exchange Fails in GitHub Actions Workflow

**Error**: `azure/login@v2` fails with OIDC error.

**Check**:
- Federated credential subject matches: `repo:{owner}/{repo}:ref:refs/heads/main`
- OIDC token permissions set in workflow (`id-token: write`)
- Repo not in a private network (OIDC needs public access to token.actions.githubusercontent.com)
