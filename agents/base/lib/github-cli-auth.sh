#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_GITHUB_CLI_AUTH_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_GITHUB_CLI_AUTH_SH=1

authenticate_github_cli() {
  log "Authenticating with GitHub..."
  gh auth status 2>/dev/null || die "gh auth failed. Check installation token."

  # Configure gh as the git credential helper so git push uses the token
  gh auth setup-git 2>/dev/null
}
