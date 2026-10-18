#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_ENV_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_ENV_SH=1

validate_required_env() {
  [[ -z "${AZURE_STORAGE_ACCOUNT:-}" ]] && die "AZURE_STORAGE_ACCOUNT is not set."
  [[ -z "${QUEUE_NAME:-}" ]] && die "QUEUE_NAME is not set."
  [[ -z "${GITHUB_APP_ID:-}" ]] && die "GITHUB_APP_ID is not set."
  [[ -z "${GITHUB_APP_INSTALLATION_ID:-}" ]] && die "GITHUB_APP_INSTALLATION_ID is not set."
  [[ -z "${KEY_VAULT_NAME:-}" ]] && die "KEY_VAULT_NAME is not set."
  [[ -z "${KEY_VAULT_SECRET_NAME:-}" ]] && die "KEY_VAULT_SECRET_NAME is not set."
  [[ -z "${COPILOT_TOKEN_SECRET_NAME:-}" ]] && die "COPILOT_TOKEN_SECRET_NAME is not set."
}
