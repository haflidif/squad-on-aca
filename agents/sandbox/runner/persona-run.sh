#!/usr/bin/env bash
set -euo pipefail

COPILOT_CREDENTIAL="${SQUAD_COPILOT_TOKEN:-${COPILOT_TOKEN:-}}"
unset SQUAD_COPILOT_TOKEN COPILOT_TOKEN GITHUB_TOKEN
STAGING_DIR=""
WORK_DIR=""
PERSONA_HOME=""
CLEANUP_WORK_DIR=false

clear_copilot_credential() {
  COPILOT_CREDENTIAL=""
  unset COPILOT_CREDENTIAL
}

cleanup_runner_state() {
  local exit_code=$?
  clear_copilot_credential
  if [[ -n "${STAGING_DIR:-}" ]]; then
    rm -rf "${STAGING_DIR}"
  fi
  if [[ -n "${PERSONA_HOME:-}" ]]; then
    rm -rf "${PERSONA_HOME}"
  fi
  if [[ "${CLEANUP_WORK_DIR:-false}" == "true" && -n "${WORK_DIR:-}" ]]; then
    rm -rf "${WORK_DIR}"
  fi
  return "${exit_code}"
}
trap cleanup_runner_state EXIT

SCRIPT_PATH="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
  SCRIPT_PATH="$(readlink -f "${SCRIPT_PATH}")"
fi
RUNNER_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"
RUNTIME_DIR="$(cd "${RUNNER_DIR}/.." && pwd)"
PATH_SCOPE_TOOL="${PATH_SCOPE_TOOL:-/opt/squad/contracts/aca-sandbox/v1/tools/path-scope.js}"

# shellcheck source=/dev/null
source "${RUNTIME_DIR}/lib/logging.sh"

DISPATCH_PATH="${1:-${SQUAD_PERSONA_DISPATCH_PATH:-}}"
OUTPUT_DIR="${SQUAD_OUTPUT_DIR:-/workspace/output}"
SOURCE_REPO_PATH="${SQUAD_SOURCE_REPO_PATH:-}"
COPILOT_BIN="${SQUAD_COPILOT_BIN:-copilot}"

mkdir -p "${OUTPUT_DIR}"
chmod 700 "${OUTPUT_DIR}" 2>/dev/null || true
STAGING_PARENT="${SQUAD_STAGING_PARENT:-$(dirname "${OUTPUT_DIR}")}"
if [[ -n "$(find "${OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  find "${OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  SQUAD_RESULT_MODE=minimal node "${RUNNER_DIR}/write-result.js" "${DISPATCH_PATH}" "${OUTPUT_DIR}" \
    "failed" \
    "Sandbox output directory was not empty before persona execution." \
    "output_tampered" \
    "SQUAD_OUTPUT_DIR must be empty before the sandbox runner starts. Existing contents were discarded."
  exit 1
fi
STAGING_DIR="$(mktemp -d "${STAGING_PARENT}/.persona-artifacts.XXXXXX")"
chmod 700 "${STAGING_DIR}"
PERSONA_HOME="$(mktemp -d "${STAGING_PARENT}/.persona-home.XXXXXX")"
chmod 700 "${PERSONA_HOME}"
if [[ -n "${SQUAD_WORK_DIR:-}" ]]; then
  WORK_DIR="${SQUAD_WORK_DIR}"
  CLEANUP_WORK_DIR=false
else
  WORK_DIR="$(mktemp -d "${STAGING_PARENT}/.persona-worktree.XXXXXX")"
  CLEANUP_WORK_DIR=true
fi

mkdir -p "${STAGING_DIR}/patches" "${STAGING_DIR}/logs"
COPILOT_LOG="${STAGING_DIR}/logs/copilot-output.log"
: > "${COPILOT_LOG}"

TOKEN_PATTERN='(github_pat_[A-Za-z0-9_]+|gh[ops]_[A-Za-z0-9_]+)'
CREDENTIAL_LEAK_DETECTED=false

clear_output_dir() {
  mkdir -p "${OUTPUT_DIR}"
  find "${OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

scan_artifact_tree_for_credentials() {
  local scan_dir="$1"
  COPILOT_CREDENTIAL="${COPILOT_CREDENTIAL:-}" node - "${scan_dir}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
const credential = process.env.COPILOT_CREDENTIAL || '';
delete process.env.COPILOT_CREDENTIAL;
const githubTokenPattern = /(github_pat_[A-Za-z0-9_]+|gh[ops]_[A-Za-z0-9_]+)/;

function scanText(value) {
  return (credential && value.includes(credential)) || githubTokenPattern.test(value);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
    if (scanText(relativePath)) process.exit(1);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    const content = fs.readFileSync(fullPath).toString('utf8');
    if (scanText(content)) process.exit(1);
  }
}

walk(root);
NODE
}

write_minimal_credential_leak_result() {
  clear_output_dir
  SQUAD_RESULT_MODE=minimal node "${RUNNER_DIR}/write-result.js" "${DISPATCH_PATH}" "${OUTPUT_DIR}" \
    "failed" \
    "Credential leak detected in sandbox output." \
    "credential_leak" \
    "Credential material appeared in sandbox output and all persona-derived artifacts were withheld."
  scan_artifact_tree_for_credentials "${OUTPUT_DIR}" || die "Minimal credential leak result still contains credential material."
}

write_minimal_output_tampered_result() {
  clear_output_dir
  SQUAD_RESULT_MODE=minimal node "${RUNNER_DIR}/write-result.js" "${DISPATCH_PATH}" "${OUTPUT_DIR}" \
    "failed" \
    "Sandbox output directory was modified during persona execution." \
    "output_tampered" \
    "Unexpected files appeared in SQUAD_OUTPUT_DIR before artifact publish. They were discarded and persona-derived artifacts were withheld."
}

publish_staged_artifacts() {
  if ! scan_artifact_tree_for_credentials "${STAGING_DIR}"; then
    rm -rf "${STAGING_DIR}"
    write_minimal_credential_leak_result
    clear_copilot_credential
    exit 1
  fi

  if [[ -n "$(find "${OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    rm -rf "${STAGING_DIR}"
    write_minimal_output_tampered_result
    clear_copilot_credential
    exit 1
  fi

  shopt -s dotglob nullglob
  for artifact in "${STAGING_DIR}"/*; do
    mv "${artifact}" "${OUTPUT_DIR}/"
  done
  shopt -u dotglob nullglob
}

write_result_and_exit() {
  local status="$1"
  local summary="$2"
  local code="${3:-}"
  local message="${4:-${summary}}"
  local exit_code="${5:-0}"

  node "${RUNNER_DIR}/write-result.js" "${DISPATCH_PATH}" "${STAGING_DIR}" "${status}" "${summary}" "${code}" "${message}"
  publish_staged_artifacts
  exit "${exit_code}"
}

require_file() {
  local file="$1"
  [[ -f "${file}" ]] || die "Required file not found: ${file}"
}

json_get() {
  local query="$1"
  jq -er "${query}" "${DISPATCH_PATH}"
}

normalize_path() {
  local value="$1"
  value="${value//\\//}"
  value="${value#./}"
  value="${value#/}"
  printf '%s' "${value}"
}

redact_credentials() {
  local value="$1"
  if [[ -n "${COPILOT_CREDENTIAL:-}" ]]; then
    value="${value//${COPILOT_CREDENTIAL}/[REDACTED_GITHUB_TOKEN]}"
  fi
  printf '%s' "${value}" | sed -E "s/${TOKEN_PATTERN}/[REDACTED_GITHUB_TOKEN]/g"
}

contains_credential() {
  local value="$1"
  if [[ -n "${COPILOT_CREDENTIAL:-}" && "${value}" == *"${COPILOT_CREDENTIAL}"* ]]; then
    return 0
  fi
  [[ "${value}" =~ ${TOKEN_PATTERN} ]]
}

write_credential_env_status() {
  if env | grep -Eq '^(GITHUB_TOKEN|COPILOT_TOKEN|SQUAD_COPILOT_TOKEN)='; then
    printf 'credential_env_cleared=false\n' > "${STAGING_DIR}/logs/credential-env-cleared.txt"
  else
    printf 'credential_env_cleared=true\n' > "${STAGING_DIR}/logs/credential-env-cleared.txt"
  fi
}

fail_for_credential_leak() {
  CREDENTIAL_LEAK_DETECTED=true
  cd "${STAGING_PARENT}"
  rm -rf "${WORK_DIR}"
  rm -rf "${STAGING_DIR}"
  write_minimal_credential_leak_result
  clear_copilot_credential
  exit 1
}

validate_paths_result() {
  local result_json="$1"
  local violations_count protected_count
  violations_count="$(jq '.violations | length' <<<"${result_json}")"
  protected_count="$(jq '.protected | length' <<<"${result_json}")"
  if [[ "${violations_count}" -gt 0 ]]; then
    local violation_list protected_list
    violation_list="$(jq -c '.violations' <<<"${result_json}")"
    protected_list="$(jq -c '.protected' <<<"${result_json}")"
    write_result_and_exit "failed" "Path ownership enforcement failed." "PATH_OWNERSHIP_VIOLATION" "Violating paths: ${violation_list}; protected paths: ${protected_list}." 1
  fi
}

validate_symlink_scan() {
  local result_json violations_count
  result_json="$(node "${PATH_SCOPE_TOOL}" scan-symlinks "$(pwd)")"
  violations_count="$(jq '.violations | length' <<<"${result_json}")"
  if [[ "${violations_count}" -gt 0 ]]; then
    write_result_and_exit "failed" "Symlink boundary enforcement failed." "SYMLINK_BOUNDARY_VIOLATION" "Violating symlinks: $(jq -c '.violations' <<<"${result_json}")." 1
  fi
}

validate_changed_symlinks_result() {
  local result_json="$1"
  local violations_count
  violations_count="$(jq '.violations | length' <<<"${result_json}")"
  if [[ "${violations_count}" -gt 0 ]]; then
    write_result_and_exit "failed" "Changed symlink enforcement failed." "SYMLINK_OWNERSHIP_VIOLATION" "Violating symlinks: $(jq -c '.violations' <<<"${result_json}")." 1
  fi
}

require_file "${DISPATCH_PATH}"
SCHEMA_VERSION="$(json_get '.schema_version')"
MESSAGE_TYPE="$(json_get '.message_type')"
RUN_ID="$(json_get '.run_id')"
TASK_ID="$(json_get '.task_id')"
BASELINE_SHA="$(json_get '.baseline_sha')"
OBJECTIVE="$(json_get '.objective')"
LOGICAL_MEMBER_ID="$(json_get '.owner.logical_member_id')"
PERSISTENT_NAME="$(json_get '.owner.resolved_persistent_name')"
CHARTER_REF="$(json_get '.owner.charter_ref')"

[[ "${SCHEMA_VERSION}" == "aca-sandbox/v1" ]] || die "Unsupported schema_version: ${SCHEMA_VERSION}"
[[ "${MESSAGE_TYPE}" == "persona.dispatch" ]] || die "Unsupported message_type: ${MESSAGE_TYPE}"
jq -e '. as $root | .roster.members[] | select(.logical_member_id == $root.owner.logical_member_id and . == $root.owner)' "${DISPATCH_PATH}" >/dev/null \
  || write_result_and_exit "failed" "Dispatch owner does not match roster snapshot." "OWNER_ROSTER_MISMATCH" "The owner identity in the dispatch envelope was not found in the roster snapshot." 1
jq -e '.owned_paths and (.owned_paths | length > 0)' "${DISPATCH_PATH}" >/dev/null \
  || write_result_and_exit "failed" "Dispatch envelope must include non-empty owned_paths." "OWNED_PATHS_REQUIRED" "The sandbox runner requires dispatcher-supplied owned_paths for patch enforcement." 1
if ! OWNED_PATH_VALIDATION="$(node "${PATH_SCOPE_TOOL}" validate-owned "${DISPATCH_PATH}")"; then
  write_result_and_exit "failed" "Dispatch envelope contains invalid owned_paths." "OWNED_PATHS_INVALID" "$(jq -c '.errors' <<<"${OWNED_PATH_VALIDATION}")" 1
fi

[[ -n "${SOURCE_REPO_PATH}" ]] \
  || write_result_and_exit "failed" "No pre-staged repository path was supplied." "SOURCE_REPO_REQUIRED" "SQUAD_SOURCE_REPO_PATH is required. Dispatcher must pre-stage a baseline repository." 1
[[ -d "${SOURCE_REPO_PATH}" ]] \
  || write_result_and_exit "failed" "Pre-staged repository path was not found." "SOURCE_REPO_NOT_FOUND" "SQUAD_SOURCE_REPO_PATH is not a directory: ${SOURCE_REPO_PATH}" 1

rm -rf "${WORK_DIR}"
git clone --no-hardlinks "${SOURCE_REPO_PATH}" "${WORK_DIR}" >/dev/null 2>&1 \
  || write_result_and_exit "failed" "Failed to clone pre-staged repository." "SOURCE_REPO_CLONE_FAILED" "The sandbox runner could not clone the dispatcher-pre-staged repository." 1
cd "${WORK_DIR}"
git remote remove origin >/dev/null 2>&1 || true
validate_symlink_scan

CURRENT_HEAD="$(git rev-parse HEAD)"
if [[ "${CURRENT_HEAD}" != "${BASELINE_SHA}" ]]; then
  PATCH_PATH="${STAGING_DIR}/patches/${TASK_ID}.patch"
  : > "${PATCH_PATH}"
  write_credential_env_status
  write_result_and_exit "failed" "Baseline SHA mismatch before persona execution." "BASELINE_SHA_MISMATCH" "Checked-out HEAD ${CURRENT_HEAD} does not equal dispatch baseline ${BASELINE_SHA}." 1
fi

PROMPT=$(cat <<EOF
You are ${PERSISTENT_NAME}, roster member ${LOGICAL_MEMBER_ID}.
Charter reference: ${CHARTER_REF}
Run ID: ${RUN_ID}
Task ID: ${TASK_ID}
Baseline SHA: ${BASELINE_SHA}

Task objective:
${OBJECTIVE}

Stay within your owned paths. Do not modify .squad/** or .github/workflows/**. Do not push, create remotes, or call GitHub publishing commands.
EOF
)

COPILOT_EXIT=0
COPILOT_OUTPUT=""
set +e
if [[ -z "${COPILOT_CREDENTIAL:-}" ]]; then
  echo "SQUAD_COPILOT_TOKEN or COPILOT_TOKEN is required." | tee -a "${COPILOT_LOG}"
  COPILOT_EXIT=127
fi

if [[ "${COPILOT_EXIT}" -eq 0 ]]; then
  COPILOT_ENV=(
    -i
    "PATH=${PATH:-/usr/local/bin:/usr/bin:/bin}"
    "HOME=${PERSONA_HOME}"
    "LANG=${LANG:-C.UTF-8}"
    "TERM=${TERM:-dumb}"
    "GITHUB_TOKEN=${COPILOT_CREDENTIAL}"
  )
  if [[ -n "${SQUAD_FAKE_COPILOT_ENV_ALLOWLIST:-}" ]]; then
    IFS=',' read -r -a FAKE_ENV_NAMES <<<"${SQUAD_FAKE_COPILOT_ENV_ALLOWLIST}"
    for env_name in "${FAKE_ENV_NAMES[@]}"; do
      if [[ "${env_name}" =~ ^FAKE_[A-Z0-9_]+$ && -n "${!env_name+x}" ]]; then
        COPILOT_ENV+=("${env_name}=${!env_name}")
      fi
    done
  fi
  COPILOT_OUTPUT="$(printf '%s\n' "${PROMPT}" | env "${COPILOT_ENV[@]}" "${COPILOT_BIN}" --yolo --agent squad 2>&1)"
  COPILOT_EXIT=$?
fi
set -e

if [[ -n "${COPILOT_OUTPUT}" ]]; then
  if contains_credential "${COPILOT_OUTPUT}"; then
    CREDENTIAL_LEAK_DETECTED=true
  fi
  redact_credentials "${COPILOT_OUTPUT}" > "${COPILOT_LOG}"
fi
write_credential_env_status

git add -N -- . >/dev/null 2>&1 || true
PATCH_PATH="${STAGING_DIR}/patches/${TASK_ID}.patch"
PATCH_CONTENT="$(git diff --binary "${BASELINE_SHA}" -- .)"
if contains_credential "${PATCH_CONTENT}" || [[ "${CREDENTIAL_LEAK_DETECTED}" == "true" ]]; then
  fail_for_credential_leak
fi
printf '%s' "${PATCH_CONTENT}" > "${PATCH_PATH}"

mapfile -d '' -t CHANGED_PATHS < <(git diff --no-renames -z --name-only "${BASELINE_SHA}" -- .)
mapfile -d '' -t UNTRACKED_PATHS < <(git ls-files --others --exclude-standard -z)
mapfile -d '' -t IGNORED_UNTRACKED_PATHS < <(git ls-files --others --ignored --exclude-standard -z)

PATH_VALIDATION="$(printf '%s\0' "${CHANGED_PATHS[@]}" "${UNTRACKED_PATHS[@]}" "${IGNORED_UNTRACKED_PATHS[@]}" | node "${PATH_SCOPE_TOOL}" check-paths-nul "${DISPATCH_PATH}")"
validate_paths_result "${PATH_VALIDATION}"
SYMLINK_VALIDATION="$(printf '%s\0' "${CHANGED_PATHS[@]}" | node "${PATH_SCOPE_TOOL}" check-changed-symlinks-nul "${DISPATCH_PATH}" "$(pwd)")"
validate_changed_symlinks_result "${SYMLINK_VALIDATION}"
validate_symlink_scan

if [[ "${#IGNORED_UNTRACKED_PATHS[@]}" -gt 0 ]]; then
  printf '%s\n' "${IGNORED_UNTRACKED_PATHS[@]}" > "${STAGING_DIR}/logs/ignored-untracked.txt"
fi

if [[ "${COPILOT_EXIT}" -ne 0 ]]; then
  write_result_and_exit "failed" "Copilot CLI failed inside the persona sandbox." "COPILOT_FAILED" "Copilot exited with status ${COPILOT_EXIT}. Patch was written for audit." "${COPILOT_EXIT}"
fi

write_result_and_exit "succeeded" "Persona task completed and patch passed sandbox path enforcement." "" "" 0
