#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_PROVIDERS_ACA_SANDBOX_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_PROVIDERS_ACA_SANDBOX_SH=1

run_aca_sandbox_provider() {
  # PR 4 adds the isolated persona worker image under agents/sandbox/.
  # The legacy ACA Job entrypoint remains a loud stub until a trusted
  # dispatcher can create ACA Sandboxes, pre-stage a baseline repository,
  # inject dispatch envelopes, and collect persona artifacts.
  die "aca-sandbox provider is not implemented in this runtime. This entrypoint only supports the aca-job provider."
}
