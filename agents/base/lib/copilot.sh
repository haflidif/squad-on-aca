#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_COPILOT_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_COPILOT_SH=1

run_copilot_yolo() {
  local prompt="$1"

  set +e
  export GITHUB_TOKEN="${COPILOT_TOKEN}"
  echo "${prompt}" | copilot --yolo --agent squad 2>&1 | tee /workspace/copilot-output.log
  COPILOT_EXIT=${PIPESTATUS[1]}
  export GITHUB_TOKEN="${APP_TOKEN}"
  set -e
}
