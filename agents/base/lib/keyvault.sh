#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_KEYVAULT_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_KEYVAULT_SH=1

keyvault_get_secret() {
  local secret_name="$1"
  az keyvault secret show \
    --vault-name "${KEY_VAULT_NAME}" \
    --name "${secret_name}" \
    --query value -o tsv 2>/dev/null
}

retrieve_copilot_token() {
  log "Retrieving Copilot token from Key Vault..."
  COPILOT_TOKEN=$(keyvault_get_secret "${COPILOT_TOKEN_SECRET_NAME}") || die "Failed to retrieve Copilot token from Key Vault."

  [[ -z "${COPILOT_TOKEN}" ]] && die "Copilot token from Key Vault is empty."
  log "Copilot token retrieved successfully."
}
