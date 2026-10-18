#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 ]]; then
  echo "Usage: copilot-launch.sh <copilot-command> [args...]" >&2
  exit 2
fi

if ! IFS= read -r GITHUB_TOKEN <&3; then
  echo "Copilot token file descriptor was not readable." >&2
  exit 126
fi
exec 3<&-
export GITHUB_TOKEN
exec "$@"
