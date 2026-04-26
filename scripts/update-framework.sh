#!/usr/bin/env bash
# scripts/update-framework.sh — apply pending framework updates.
#
# Used by:
#  - The Watcher's [Update now] button
#  - The update-framework skill (manual flow)
#  - cron, if you want to auto-update without buttons
#
# Steps:
#   1. git pull (--ff-only — refuse to merge divergent histories)
#   2. detect what changed; if docker/ or framework/ touched, rebuild image
#   3. if listener/ touched, npm install + npm run build
#   4. pm2 restart ginnie-agents-listener
#   5. run scripts/doctor.sh; exit non-zero if any check fails
#
# Stdout/stderr are streamed back. Watcher captures the tail and posts it.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "==> git fetch"
git fetch origin --quiet || { echo "fetch failed"; exit 1; }

AHEAD=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
if [ "$AHEAD" -eq 0 ]; then
  echo "Already up to date."
  exit 0
fi

PREV_HEAD=$(git rev-parse HEAD)
echo "==> git pull --ff-only origin main"
git pull --ff-only origin main || {
  echo "pull failed (likely divergent history) — see git status"
  exit 1
}

CHANGED=$(git diff --name-only "$PREV_HEAD" HEAD)

if echo "$CHANGED" | grep -qE '^(docker/|framework/)'; then
  echo "==> docker build (Dockerfile or framework changed)"
  docker build -t ginnie-agent -f docker/Dockerfile . || { echo "docker build failed"; exit 1; }
fi

if echo "$CHANGED" | grep -qE '^listener/'; then
  echo "==> listener npm install + build"
  ( cd listener && npm install --no-audit --no-fund && npm run build ) || {
    echo "listener build failed"; exit 1;
  }
fi

echo "==> pm2 restart"
pm2 restart ginnie-agents-listener --update-env || {
  echo "pm2 restart failed"; exit 1;
}

# Restart Watcher too so the daemon picks up its own potential updates
if pm2 jlist 2>/dev/null | grep -q '"name":"ginnie-agents-watcher"'; then
  echo "==> pm2 restart watcher"
  pm2 restart ginnie-agents-watcher --update-env || true
fi

echo "==> doctor"
bash scripts/doctor.sh
DOC_RC=$?

if [ "$DOC_RC" -ne 0 ]; then
  echo "Update applied but doctor reported failures (exit $DOC_RC). Review."
  exit "$DOC_RC"
fi

echo "Update complete."
exit 0
