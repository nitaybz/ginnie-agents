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
UPSTREAM="${FRAMEWORK_UPSTREAM:-origin/main}"
REMOTE="${UPSTREAM%%/*}"
git fetch "$REMOTE" --tags --quiet || { echo "fetch failed"; exit 1; }

AHEAD=$(git rev-list --count "HEAD..${UPSTREAM}" 2>/dev/null || echo 0)
if [ "$AHEAD" -eq 0 ]; then
  echo "Already up to date."
  exit 0
fi

# Supply-chain trust gate. When enabled, refuse to apply an update unless
# the upstream tip is a git tag signed by a key in the operator's gpg
# keyring. Default off for backward compat (anyone tracking `main` keeps
# the prior trust-the-remote model). Set FRAMEWORK_REQUIRE_SIGNED_TAG=true
# to opt in, and point FRAMEWORK_UPSTREAM at a branch where releases are
# always tagged (or at a specific tag ref). See ARCHITECTURE.md threat
# model.
if [ "${FRAMEWORK_REQUIRE_SIGNED_TAG:-false}" = "true" ]; then
  echo "==> verifying signed tag at $UPSTREAM"
  TAG=$(git describe --exact-match --tags "$UPSTREAM" 2>/dev/null || true)
  if [ -z "$TAG" ]; then
    echo "FRAMEWORK_REQUIRE_SIGNED_TAG=true but no tag points at $UPSTREAM — refusing to update."
    echo "  Either point FRAMEWORK_UPSTREAM at a release tag, or wait for a signed release on this branch."
    exit 1
  fi
  if ! git verify-tag "$TAG" 2>&1; then
    echo "FRAMEWORK_REQUIRE_SIGNED_TAG=true but tag $TAG is not signed by a trusted key — refusing to update."
    echo "  Import the upstream signing key into your gpg keyring and re-run."
    exit 1
  fi
  echo "    verified signed tag: $TAG"
fi

PREV_HEAD=$(git rev-parse HEAD)
BRANCH="${UPSTREAM#*/}"
echo "==> git pull --ff-only $REMOTE $BRANCH"
git pull --ff-only "$REMOTE" "$BRANCH" || {
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

echo "==> record deployed framework version"
mkdir -p data
git rev-parse "$UPSTREAM" > data/framework-version.txt 2>/dev/null || \
  git rev-parse HEAD > data/framework-version.txt
echo "    data/framework-version.txt = $(cat data/framework-version.txt)"

echo "==> doctor"
bash scripts/doctor.sh
DOC_RC=$?

if [ "$DOC_RC" -ne 0 ]; then
  echo "Update applied but doctor reported failures (exit $DOC_RC). Review."
  exit "$DOC_RC"
fi

echo "Update complete."
exit 0
