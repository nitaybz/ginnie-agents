#!/usr/bin/env bash
# scripts/rotate-slack-config-token.sh
#
# Rotates SLACK_CONFIG_TOKEN+REFRESH using the current refresh token in .env,
# **persists the new pair to .env atomically**, and prints the new access
# token to stdout. Exit 0 on success, non-zero on failure (with reason on
# stderr).
#
# Why this script exists: every successful rotation invalidates the previous
# pair. If a caller rotates and then crashes / forgets to write back, the
# install loses access to the config-token API entirely (refresh token is
# dead, can't get a new one without going to api.slack.com). This helper
# binds rotation and persistence into one operation, so any caller who
# successfully receives a new access token from this script is guaranteed
# the new pair is already on disk.
#
# Usage:
#   ACCESS=$(bash scripts/rotate-slack-config-token.sh) || exit 1
#   curl -H "Authorization: Bearer $ACCESS" https://slack.com/api/...
#
# Stdout: only the new access token (clean to capture in a shell var).
# Stderr: progress + errors.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

if [ ! -f .env ]; then
  echo "rotate-slack-config-token: no .env at $REPO" >&2
  exit 1
fi

REFRESH=$(grep -E '^SLACK_CONFIG_REFRESH_TOKEN=' .env | cut -d= -f2- | head -1)
if [ -z "$REFRESH" ]; then
  echo "rotate-slack-config-token: SLACK_CONFIG_REFRESH_TOKEN not set in .env" >&2
  exit 1
fi

RESP=$(curl -sS -X POST https://slack.com/api/tooling.tokens.rotate \
  -d "refresh_token=$REFRESH")
OK=$(echo "$RESP" | jq -r .ok 2>/dev/null)
if [ "$OK" != "true" ]; then
  ERR=$(echo "$RESP" | jq -r '.error // "unknown"' 2>/dev/null)
  echo "rotate-slack-config-token: rotation failed (error=$ERR)" >&2
  echo "  full response: $RESP" >&2
  if [ "$ERR" = "invalid_refresh_token" ]; then
    echo "  → regenerate at https://api.slack.com/apps (bottom of page)" >&2
  fi
  exit 1
fi

NEW_ACCESS=$(echo "$RESP" | jq -r .token)
NEW_REFRESH=$(echo "$RESP" | jq -r .refresh_token)

if [ -z "$NEW_ACCESS" ] || [ "$NEW_ACCESS" = "null" ]; then
  echo "rotate-slack-config-token: rotation returned ok=true but no token in response" >&2
  echo "  $RESP" >&2
  exit 1
fi

# Atomic persist: write to .env.new, then rename. Even if interrupted between
# write and rename, .env stays whole. The rename is atomic on POSIX.
NEW_ACCESS="$NEW_ACCESS" NEW_REFRESH="$NEW_REFRESH" python3 - <<'PY'
import os, re, pathlib
new_access = os.environ['NEW_ACCESS']
new_refresh = os.environ['NEW_REFRESH']
p = pathlib.Path('.env')
text = p.read_text()
if re.search(r'^SLACK_CONFIG_TOKEN=', text, re.M):
    text = re.sub(r'^SLACK_CONFIG_TOKEN=.*$',
                  f'SLACK_CONFIG_TOKEN={new_access}', text, flags=re.M)
else:
    text += f'\nSLACK_CONFIG_TOKEN={new_access}\n'
if re.search(r'^SLACK_CONFIG_REFRESH_TOKEN=', text, re.M):
    text = re.sub(r'^SLACK_CONFIG_REFRESH_TOKEN=.*$',
                  f'SLACK_CONFIG_REFRESH_TOKEN={new_refresh}', text, flags=re.M)
else:
    text += f'\nSLACK_CONFIG_REFRESH_TOKEN={new_refresh}\n'
tmp = pathlib.Path('.env.new')
tmp.write_text(text)
os.chmod(tmp, 0o600)
os.replace(str(tmp), str(p))
PY

echo "rotate-slack-config-token: persisted new pair to .env" >&2
echo "$NEW_ACCESS"
exit 0
