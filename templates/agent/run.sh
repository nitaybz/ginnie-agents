#!/bin/bash
# Run {{AGENT_NAME}} in an isolated Docker container
# Usage: ./run.sh [message]

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$AGENT_DIR/../.." && pwd)"
MESSAGE="${1:-Run your daily tasks.}"
AGENT_NAME="{{AGENT_NAME_LOWER}}"

# Ensure directories exist
mkdir -p "$AGENT_DIR/memory" "$AGENT_DIR/sessions" "$AGENT_DIR/logs"

echo "[$(date)] Starting $AGENT_NAME in Docker container..."

DOCKER_AUTH_ARGS=()
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  DOCKER_AUTH_ARGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
else
  DOCKER_AUTH_ARGS+=(-v "$HOME/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro")
fi

docker run --rm \
  --name "ginnie-${AGENT_NAME}-$(date +%s)" \
  --memory 1g \
  --cpus 2 \
  -e "TZ=${TZ:-UTC}" \
  -e "AGENT_MESSAGE=$MESSAGE" \
  -e "AGENT_NAME=$AGENT_NAME" \
  -e "MAX_TURNS=50" \
  -e "ALLOWED_TOOLS=Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch" \
  "${DOCKER_AUTH_ARGS[@]}" \
  -v "$AGENT_DIR/sessions:/home/node/.claude" \
  -v "$AGENT_DIR/PROMPT.md:/workspace/PROMPT.md:ro" \
  -v "$AGENT_DIR/SOUL.md:/workspace/SOUL.md:ro" \
  -v "$AGENT_DIR/credentials.json:/workspace/credentials.json:ro" \
  -v "$AGENT_DIR/schedules.json:/workspace/schedules.json" \
  -v "$AGENT_DIR/memory:/workspace/memory" \
  -v "$AGENT_DIR/skills:/workspace/skills:ro" \
  -v "$REPO_DIR/shared:/workspace/.shared:ro" \
  -v "$REPO_DIR/framework/skills:/workspace/.framework/skills:ro" \
  ginnie-agent \
  2>&1 | tee -a "$AGENT_DIR/logs/$(date +%Y-%m-%d).log"

echo "[$(date)] $AGENT_NAME session complete."
