#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_AZURE_AUTH_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_AZURE_AUTH_SH=1

azure_login_managed_identity() {
  log "Logging in with Managed Identity..."
  if [[ -n "${AZURE_CLIENT_ID:-}" ]]; then
    az login --identity --client-id "${AZURE_CLIENT_ID}" --allow-no-subscriptions -o none || die "az login --identity failed."
  else
    az login --identity --allow-no-subscriptions -o none || die "az login --identity failed."
  fi
}
