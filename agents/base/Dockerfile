# =============================================================================
# Stage 1: Build — install tooling in a full image
# =============================================================================
FROM golang:1.23.4-bookworm AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 — required by @github/copilot CLI
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# GitHub Copilot CLI (installed in build stage, copied to runtime)
RUN npm install -g @github/copilot

# =============================================================================
# Stage 2: Runtime — slim image with only what we need
# =============================================================================
FROM debian:bookworm-20240701-slim AS runtime

LABEL maintainer="Haflidi Fridthjofsson"
LABEL org.opencontainers.image.description="Squad agent runtime for Azure Container App Jobs"
LABEL org.opencontainers.image.source="https://github.com/haflidif/squad-on-aca"

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    python3 \
    pip \
    && pip install --break-system-packages --no-cache-dir azure-cli \
    && rm -rf /var/lib/apt/lists/* /root/.cache

# Node.js 22 — required for Copilot CLI at runtime
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy Go toolchain
COPY --from=build /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"

# Copy GitHub CLI
COPY --from=build /usr/bin/gh /usr/bin/gh

# Copy Copilot CLI (global npm package from build stage)
COPY --from=build /usr/lib/node_modules/@github/copilot /usr/lib/node_modules/@github/copilot
RUN ln -sf /usr/lib/node_modules/@github/copilot/bin/copilot /usr/local/bin/copilot

WORKDIR /workspace

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
