# FAQ

> Frequently asked questions about Squad on ACA.

---

**Q: Why not use AWS Lambda instead of ACA?**
A: No strong reason! Squad on ACA uses Azure Container Apps for:
- Native KEDA integration (event-driven scaling)
- Direct Secret Manager (Key Vault) access
- Managed environment (no cluster setup)
- Cost is comparable to Lambda

Feel free to port this to Lambda, Cloud Run, etc. The pattern is portable.

---

**Q: Can I run multiple agents in parallel on one issue?**
A: From the infrastructure level, each queue message = one container. But **Squad handles multi-agent orchestration inside the container**. If you want agents to work independently and open separate PRs, enqueue two messages (one per agent).

---

**Q: How do I monitor agent runs?**
A: Use Application Insights logs (via Log Analytics). Azure Portal → Container Apps Job → Logs. KEDA metrics are also logged.

```kusto
ContainerAppConsoleLogs
| where ContainerGroupName =~ "job-squad-agent-*"
| where TimeGenerated > ago(24h)
| summarize Count = count() by TimeGenerated
```

---

**Q: What if an agent gets stuck in an infinite loop?**
A: The container timeout (default 30 minutes) stops it. The PR is created with whatever progress was made. Fallback artifact captures logs.

---

**Q: Can I customize the PR title/body format?**
A: Yes, edit `entrypoint.sh` lines 370–424 (PR body construction). The PR title is set at line 437.

---

**Q: Do I need to maintain this if I stop using it?**
A: No special maintenance. KEDA stops triggering if no messages are enqueued. Container App Jobs scale to 0. Only recurring costs are:
- Key Vault: ~$0.6/month
- Container Registry: ~$5/month (Basic SKU)
- Log Analytics (if enabled): depends on usage

All are per-subscription, so even inactive deployments have minimal cost.
