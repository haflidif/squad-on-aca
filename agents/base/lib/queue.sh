#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_QUEUE_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_QUEUE_SH=1

dequeue_queue_message() {
  log "Dequeuing message from queue '${QUEUE_NAME}' (account: ${AZURE_STORAGE_ACCOUNT})..."

  RAW_MSG=$(az storage message get --queue-name "${QUEUE_NAME}" --account-name "${AZURE_STORAGE_ACCOUNT}" --auth-mode login --num-messages 1 -o json 2>/dev/null) || die "az storage message get failed."

  # KEDA may trigger the job after the queue drains - exit cleanly if empty.
  if [[ -z "${RAW_MSG}" || "${RAW_MSG}" == "[]" || "${RAW_MSG}" == "null" ]]; then
    log "No messages in queue. Exiting cleanly."
    exit 0
  fi

  # Extract fields needed to delete the message and the content (base64-encoded).
  MSG_ID=$(echo "${RAW_MSG}" | jq -r '.[0].id // empty')
  POP_RECEIPT=$(echo "${RAW_MSG}" | jq -r '.[0].popReceipt // empty')
  MSG_BODY_B64=$(echo "${RAW_MSG}" | jq -r '.[0].content // empty')

  [[ -z "${MSG_ID}" || -z "${POP_RECEIPT}" ]] && die "Dequeued message is missing id or popReceipt."
  [[ -z "${MSG_BODY_B64}" ]] && die "Dequeued message has no content."
}

resolve_provider_from_message() {
  RUNTIME_PROVIDER=$(echo "${QUEUE_MESSAGE}" | jq -r '
    if ((.provider? | type) == "object") then
      (.provider.kind // .provider.id // empty)
    else
      (.provider // .provider_kind // .provider_id // empty)
    end
  ')

  if [[ -z "${RUNTIME_PROVIDER}" || "${RUNTIME_PROVIDER}" == "null" ]]; then
    RUNTIME_PROVIDER="aca-job"
  fi
}

parse_queue_message() {
  QUEUE_MESSAGE=$(echo "${MSG_BODY_B64}" | base64 -d 2>&1) || die "Failed to base64-decode message content: ${QUEUE_MESSAGE}"

  MSG_TYPE=$(echo "${QUEUE_MESSAGE}" | jq -r '.type // "new"')
  ISSUE_NUMBER=$(echo "${QUEUE_MESSAGE}" | jq -r '.issue_number // empty')
  AGENT_TYPE=$(echo "${QUEUE_MESSAGE}" | jq -r '.agent_type // empty')
  GITHUB_REPO=$(echo "${QUEUE_MESSAGE}" | jq -r '.repo // empty')

  resolve_provider_from_message

  if [[ "${RUNTIME_PROVIDER}" == "aca-job" ]]; then
    [[ -z "${ISSUE_NUMBER}" ]] && die "issue_number is missing in message."
    [[ -z "${AGENT_TYPE}" ]] && die "agent_type is missing in message."
    [[ -z "${GITHUB_REPO}" ]] && die "repo is missing in message."
  fi

  # Revision-specific fields (only present when MSG_TYPE == "revise")
  PR_NUMBER=$(echo "${QUEUE_MESSAGE}" | jq -r '.pr_number // empty')
  REVISION_BRANCH=$(echo "${QUEUE_MESSAGE}" | jq -r '.branch // empty')
  HEAD_SHA=$(echo "${QUEUE_MESSAGE}" | jq -r '.head_sha // empty')
  FEEDBACK=$(echo "${QUEUE_MESSAGE}" | jq -r '.feedback // empty')
}

delete_queue_message() {
  log "Deleting message ${MSG_ID} from queue..."
  az storage message delete --queue-name "${QUEUE_NAME}" --account-name "${AZURE_STORAGE_ACCOUNT}" --auth-mode login --id "${MSG_ID}" --pop-receipt "${POP_RECEIPT}" -o none || die "Failed to delete message ${MSG_ID} from queue."
}
