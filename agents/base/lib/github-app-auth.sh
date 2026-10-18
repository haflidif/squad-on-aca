#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_GITHUB_APP_AUTH_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_GITHUB_APP_AUTH_SH=1

generate_github_app_installation_token() {
  log "Generating GitHub App installation token..."

  PEM=$(keyvault_get_secret "${KEY_VAULT_SECRET_NAME}") || die "Failed to retrieve private key from Key Vault."

  [[ -z "${PEM}" ]] && die "Private key from Key Vault is empty."

  # Generate JWT (valid for 10 minutes)
  NOW=$(date +%s)
  EXPIRES=$((NOW + 600))

  HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
  PAYLOAD=$(echo -n "{\"iat\":${NOW},\"exp\":${EXPIRES},\"iss\":\"${GITHUB_APP_ID}\"}" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
  SIGNATURE=$(echo -n "${HEADER}.${PAYLOAD}" | openssl dgst -sha256 -sign <(echo "${PEM}") | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')

  JWT="${HEADER}.${PAYLOAD}.${SIGNATURE}"

  # Exchange JWT for installation access token (1hr expiry)
  TOKEN_RESPONSE=$(curl -sf -X POST \
    -H "Authorization: ******" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens") \
    || die "Failed to exchange JWT for installation token."

  GITHUB_TOKEN=$(echo "${TOKEN_RESPONSE}" | jq -r '.token // empty')
  [[ -z "${GITHUB_TOKEN}" ]] && die "Installation token is empty. Response: ${TOKEN_RESPONSE}"

  export GITHUB_TOKEN
  log "GitHub App installation token generated successfully (expires in 1hr)."

  # Save the App token — git/gh operations always use this
  APP_TOKEN="${GITHUB_TOKEN}"
}
