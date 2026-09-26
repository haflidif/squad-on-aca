# =============================================================================
# Stage 1: Build - install Copilot CLI in a full image
# =============================================================================
ARG BASE_ACR_HOST=crsquadacaa6b49feb.azurecr.io/
ARG BUILD_BASE_IMAGE=${BASE_ACR_HOST}base/golang:1.23.4-bookworm
ARG RUNTIME_BASE_IMAGE=${BASE_ACR_HOST}base/debian:bookworm-20240701-slim

FROM ${BUILD_BASE_IMAGE} AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 is required by @github/copilot.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @github/copilot

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

COPY --from=build /usr/lib/node_modules/@github/copilot /usr/lib/node_modules/@github/copilot
RUN ln -sf /usr/lib/node_modules/@github/copilot/npm-loader.js /usr/local/bin/copilot \
    && chmod +x /usr/local/bin/copilot

RUN useradd --create-home --shell /usr/sbin/nologin --uid 10000 squad-runner \
    && useradd --create-home --shell /bin/bash --uid 10001 copilot-agent \
    && mkdir -p /workspace /opt/squad-sandbox \
    && chown -R squad-runner:squad-runner /workspace /opt/squad-sandbox

WORKDIR /workspace

COPY --chown=squad-runner:squad-runner agents/sandbox/lib /opt/squad-sandbox/lib
COPY agents/sandbox/runner /opt/squad-sandbox/runner
COPY contracts/aca-sandbox/v1/tools /opt/squad/contracts/aca-sandbox/v1/tools
COPY contracts/aca-sandbox/v1/schemas /opt/squad/contracts/aca-sandbox/v1/schemas
RUN chmod -R a+rX /opt/squad-sandbox \
    && chmod -R a+rX /opt/squad/contracts \
    && chmod +x /opt/squad-sandbox/runner/persona-run.sh \
    && chmod +x /opt/squad-sandbox/runner/copilot-launch.sh \
    && chmod +x /opt/squad-sandbox/runner/exec-with-env.js \
    && chmod +x /opt/squad-sandbox/runner/integrate-run.sh \
    && ln -sf /opt/squad-sandbox/runner/persona-run.sh /persona-run.sh

ENTRYPOINT ["/persona-run.sh"]
