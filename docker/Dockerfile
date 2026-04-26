# ginnie-agents — Isolated container for running agents via the Claude Agent SDK
# Auth: Claude Code Max subscription (CLAUDE_CODE_OAUTH_TOKEN, no API key needed)

FROM node:22-slim

# Install system tools agents commonly need
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    git \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Supabase CLI — agents use this for read-only DB queries via their own PAT.
# The npm package refuses global install, so pull the Linux binary directly.
ARG SUPABASE_CLI_VERSION=2.90.0
RUN ARCH=$(dpkg --print-architecture) \
 && case "$ARCH" in \
      amd64) SUPA_ARCH=amd64 ;; \
      arm64) SUPA_ARCH=arm64 ;; \
      *) echo "Unsupported arch $ARCH" && exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_linux_${SUPA_ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin supabase \
 && supabase --version

# Create app directory for the SDK runner
RUN mkdir -p /app && chown node:node /app
WORKDIR /app

# Install Claude Agent SDK as a local dependency
COPY docker/package.json /app/package.json
RUN npm install --production

# Copy entrypoint
COPY docker/entrypoint.mjs /app/entrypoint.mjs

# Create workspace and Claude config dirs
RUN mkdir -p /workspace /home/node/.claude && chown -R node:node /workspace /home/node/.claude

USER node
WORKDIR /workspace

ENTRYPOINT ["node", "/app/entrypoint.mjs"]
