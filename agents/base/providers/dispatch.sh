#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_PROVIDERS_DISPATCH_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_PROVIDERS_DISPATCH_SH=1

validate_provider_before_ack() {
  case "${RUNTIME_PROVIDER}" in
    aca-job)
      ;;
    *)
      die "Unsupported runtime provider: ${RUNTIME_PROVIDER}. Message left on queue."
      ;;
  esac
}

dispatch_provider() {
  case "${RUNTIME_PROVIDER}" in
    aca-job)
      run_aca_job_provider
      ;;
    aca-sandbox)
      run_aca_sandbox_provider
      ;;
    *)
      die "Unsupported runtime provider: ${RUNTIME_PROVIDER}"
      ;;
  esac
}
