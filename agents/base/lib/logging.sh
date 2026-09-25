#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_LOGGING_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_LOGGING_SH=1

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die() { log "FATAL: $*"; exit 1; }
