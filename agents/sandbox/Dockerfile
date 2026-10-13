# =============================================================================
# Stage 1: Build - install Copilot CLI in a full image
# =============================================================================
ARG BASE_ACR_HOST=crsquadacaa6b49feb.azurecr.io/
ARG BUILD_BASE_IMAGE=${BASE_ACR_HOST}base/debian:bookworm-20240701-slim
ARG RUNTIME_BASE_IMAGE=${BASE_ACR_HOST}base/debian:bookworm-20240701-slim

FROM ${BUILD_BASE_IMAGE} AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    tar \
    coreutils \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    build_dir=/usr/local/lib/squad-build; \
    mkdir -p "$build_dir" /usr/local/bin; \
    curl -fsSL https://github.com/github/copilot-cli/releases/download/v1.0.96/copilot-linux-x64.tar.gz \
      -o "$build_dir/copilot-linux-x64.tar.gz"; \
    printf '%s  %s\n' '66b60b58b14d72390f30d6d7f8480d18a0f05c111d132e4ff8f92ae637d413f8' "$build_dir/copilot-linux-x64.tar.gz" | sha256sum -c -; \
    tar -xzf "$build_dir/copilot-linux-x64.tar.gz" -C /usr/local/bin; \
    chmod +x /usr/local/bin/copilot; \
    copilot_version="$(/usr/local/bin/copilot --version)"; \
    case "$copilot_version" in *1.0.96*) ;; *) echo 'Unexpected Copilot CLI version' >&2; exit 1 ;; esac; \
    /usr/local/bin/copilot --help | grep -F -- '--max-ai-credits' >/dev/null; \
    rm -rf "$build_dir"

# =============================================================================
# Stage 2: Runtime - persona sandbox worker only
# =============================================================================
FROM ${RUNTIME_BASE_IMAGE} AS runtime

LABEL maintainer="Haflidi Fridthjofsson"
LABEL org.opencontainers.image.description="Squad persona worker for Azure Container Apps Sandboxes"
LABEL org.opencontainers.image.source="https://github.com/haflidif/squad-on-aca"

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    jq \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* /root/.cache

COPY --from=build /usr/local/bin/copilot /usr/local/bin/copilot

RUN useradd --create-home --shell /usr/sbin/nologin --uid 10000 squad-runner \
    && useradd --create-home --shell /bin/bash --uid 10001 copilot-agent \
    && mkdir -p /workspace /opt/squad-sandbox \
    && chown -R squad-runner:squad-runner /workspace /opt/squad-sandbox

WORKDIR /workspace

COPY --chown=squad-runner:squad-runner agents/sandbox/lib /opt/squad-sandbox/lib
COPY agents/sandbox/runner /opt/squad-sandbox/runner
COPY contracts/aca-sandbox/v1/tools /opt/squad/contracts/aca-sandbox/v1/tools
COPY contracts/aca-sandbox/v1/schemas /opt/squad/contracts/aca-sandbox/v1/schemas
RUN chmod -R a+rX,go-w /opt/squad-sandbox \
    && chmod -R a+rX,go-w /opt/squad/contracts \
    && chmod +x /opt/squad-sandbox/runner/persona-run.sh \
    && chmod +x /opt/squad-sandbox/runner/copilot-launch.sh \
    && chmod +x /opt/squad-sandbox/runner/exec-with-env.js \
    && chmod +x /opt/squad-sandbox/runner/integrate-run.sh \
    && ln -sf /opt/squad-sandbox/runner/persona-run.sh /persona-run.sh

ENTRYPOINT ["/persona-run.sh"]
