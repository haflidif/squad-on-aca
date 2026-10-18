#!/usr/bin/env bash
set -euo pipefail
INTEGRATION_WORKTREE_DIR=""
INTEGRATION_ARTIFACTS_DIR=""
INTEGRATION_HOME_DIR=""
cleanup_integration_runner() {
  local exit_code=$?
  unset SQUAD_COPILOT_TOKEN COPILOT_TOKEN GITHUB_TOKEN GH_TOKEN GITHUB_PAT COPILOT_GITHUB_TOKEN
  if [[ -n "${INTEGRATION_WORKTREE_DIR:-}" ]]; then
    rm -rf "${INTEGRATION_WORKTREE_DIR}" 2>/dev/null || true
  fi
  if [[ -n "${INTEGRATION_ARTIFACTS_DIR:-}" ]]; then
    rm -rf "${INTEGRATION_ARTIFACTS_DIR}" 2>/dev/null || true
  fi
  if [[ -n "${INTEGRATION_HOME_DIR:-}" ]]; then
    rm -rf "${INTEGRATION_HOME_DIR}" 2>/dev/null || true
  fi
  return "${exit_code}"
}
trap cleanup_integration_runner EXIT
unset SQUAD_COPILOT_TOKEN COPILOT_TOKEN GITHUB_TOKEN GH_TOKEN GITHUB_PAT COPILOT_GITHUB_TOKEN
SCRIPT_PATH="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
  SCRIPT_PATH="$(readlink -f "${SCRIPT_PATH}")"
fi
RUNNER_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"
DISPATCH_PATH="${1:-${SQUAD_INTEGRATION_DISPATCH_PATH:-}}"
BUNDLE_PATH="${2:-${SQUAD_BASELINE_BUNDLE_PATH:-}}"
OUTPUT_DIR="${3:-${SQUAD_OUTPUT_DIR:-/workspace/output}}"
[[ -n "${DISPATCH_PATH}" ]] || { echo 'integration dispatch path is required' >&2; exit 2; }
[[ -n "${BUNDLE_PATH}" ]] || { echo 'baseline bundle path is required' >&2; exit 2; }
mkdir -p "${OUTPUT_DIR}"
STAGING_PARENT="$(dirname "${OUTPUT_DIR}")"
INTEGRATION_WORKTREE_DIR="$(mktemp -d "${STAGING_PARENT}/.integration-worktree.XXXXXX")"
INTEGRATION_ARTIFACTS_DIR="$(mktemp -d "${STAGING_PARENT}/.integration-artifacts.XXXXXX")"
INTEGRATION_HOME_DIR="$(mktemp -d "${STAGING_PARENT}/.integration-home.XXXXXX")"
rmdir "${INTEGRATION_WORKTREE_DIR}" "${INTEGRATION_ARTIFACTS_DIR}" "${INTEGRATION_HOME_DIR}"
SQUAD_INTEGRATION_WORKTREE_DIR="${INTEGRATION_WORKTREE_DIR}" \
SQUAD_INTEGRATION_ARTIFACTS_DIR="${INTEGRATION_ARTIFACTS_DIR}" \
SQUAD_INTEGRATION_HOME_DIR="${INTEGRATION_HOME_DIR}" \
  node "${RUNNER_DIR}/integrate-runner.js" "${DISPATCH_PATH}" "${BUNDLE_PATH}" "${OUTPUT_DIR}"
