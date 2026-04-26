#!/usr/bin/env bash
# scripts/maintenance.sh — fire-and-forget framework health watcher.
#
# Runs the same mechanical checks `doctor.sh` runs, but designed for cron:
# silent unless something needs the operator's attention. When it does,
# DMs the operator on Slack via a dedicated maintenance bot. No AI, no
# Docker container, no Claude tokens — just shell + curl.
#
# Setup: see .claude/skills/setup-maintenance-bot/SKILL.md
#
# Required env (in repo .env):
#   MAINTENANCE_BOT_TOKEN — xoxb-... from the dedicated maintenance Slack app
#   OPERATOR_SLACK_ID     — U0XXXXXXXXX (the human to alert)
#
# Cron suggestion: hourly
#   0 * * * * /full/path/to/repo/scripts/maintenance.sh >>/tmp/maintenance.log 2>&1
#
# Cooldowns: each alert kind is throttled to once per 24h via timestamp
# files in data/maintenance-cooldowns/. Delete the file to re-trigger.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Load .env (POSIX-safe: quote values, ignore comments)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ -z "${MAINTENANCE_BOT_TOKEN:-}" ] || [ -z "${OPERATOR_SLACK_ID:-}" ]; then
  echo "[$(date '+%F %T %Z')] missing MAINTENANCE_BOT_TOKEN or OPERATOR_SLACK_ID in .env — skipping" >&2
  exit 0
fi

COOLDOWN_DIR="$REPO/data/maintenance-cooldowns"
mkdir -p "$COOLDOWN_DIR"
COOLDOWN_SECONDS=86400  # 24h

dm() {
  local key="$1"
  local msg="$2"
  local f="$COOLDOWN_DIR/$key"

  if [ -f "$f" ]; then
    local last age
    last=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
    age=$(( $(date +%s) - last ))
    if [ "$age" -lt "$COOLDOWN_SECONDS" ]; then
      return 0
    fi
  fi

  local payload
  payload=$(jq -nc --arg ch "$OPERATOR_SLACK_ID" --arg t "$msg" \
    '{channel: $ch, text: $t}')
  curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $MAINTENANCE_BOT_TOKEN" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "$payload" >/dev/null

  date +%s > "$f"
}

# ── Token expiry awareness ────────────────────────────────
TOKEN_TS_FILE="data/token-issued-at.txt"
if [ -f "$TOKEN_TS_FILE" ]; then
  ISSUED=$(cat "$TOKEN_TS_FILE")
  EPOCH_NOW=$(date +%s)
  EPOCH_THEN=$(date -j -f '%Y-%m-%d' "$ISSUED" +%s 2>/dev/null || date -d "$ISSUED" +%s 2>/dev/null || echo 0)
  if [ "$EPOCH_THEN" -gt 0 ]; then
    DAYS=$(( (EPOCH_NOW - EPOCH_THEN) / 86400 ))
    if [ "$DAYS" -ge 335 ]; then
      dm "token-expiry" "🔑 *ginnie-agents:* CLAUDE_CODE_OAUTH_TOKEN is *${DAYS} days old* (cap ~365). Run \`claude setup-token\`, update \`CLAUDE_CODE_OAUTH_TOKEN\` in \`.env\`, then \`pm2 restart ginnie-agents-listener --update-env\`. After that, run: \`date '+%Y-%m-%d' > $TOKEN_TS_FILE\`"
    fi
  fi
fi

# ── Framework updates available ───────────────────────────
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git remote get-url origin >/dev/null 2>&1; then
    git fetch origin --quiet 2>/dev/null || true
    AHEAD=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
    if [ "$AHEAD" -gt 0 ] 2>/dev/null; then
      TITLES=$(git log HEAD..origin/main --oneline 2>/dev/null | head -10)
      dm "framework-update" "🔄 *ginnie-agents:* ${AHEAD} framework update(s) available on origin/main:\n\`\`\`\n${TITLES}\n\`\`\`\nRun the *update-framework* skill to apply."
    fi
  fi
fi

# ── PM2 listener state ────────────────────────────────────
if command -v pm2 >/dev/null 2>&1; then
  STATUS=$(pm2 jlist 2>/dev/null | python3 -c '
import sys, json
try:
  data = json.load(sys.stdin)
except Exception:
  print("not-loaded"); sys.exit(0)
for p in data:
  if p.get("name") == "ginnie-agents-listener":
    s = (p.get("pm2_env") or {}).get("status", "unknown")
    r = (p.get("pm2_env") or {}).get("restart_time", 0)
    print(f"{s}|{r}")
    sys.exit(0)
print("not-loaded")
' 2>/dev/null || echo "not-loaded")

  case "$STATUS" in
    online\|*)
      r="${STATUS#*|}"
      if [ "$r" -gt 50 ] 2>/dev/null; then
        dm "listener-flapping" "🌀 *ginnie-agents:* PM2 listener has restarted *${r} times*. Likely a crash loop — check \`pm2 logs ginnie-agents-listener\`."
      fi
      ;;
    errored\|*)
      dm "listener-errored" "🚨 *ginnie-agents:* PM2 listener is *errored*. Check \`pm2 logs ginnie-agents-listener\`, fix, and \`pm2 restart ginnie-agents-listener\`."
      ;;
    stopped\|*)
      dm "listener-stopped" "⏸️ *ginnie-agents:* PM2 listener is *stopped*. Run \`pm2 start ecosystem.config.cjs\`."
      ;;
    not-loaded)
      dm "listener-missing" "❓ *ginnie-agents:* PM2 listener is not loaded. Run \`pm2 start ecosystem.config.cjs\`."
      ;;
  esac
fi

# ── Disk space ────────────────────────────────────────────
if command -v df >/dev/null 2>&1; then
  USED=$(df -P "$REPO" 2>/dev/null | awk 'NR==2 {print $5}' | tr -d %)
  if [ "${USED:-0}" -ge 95 ] 2>/dev/null; then
    dm "disk-95" "🔥 *ginnie-agents:* disk *${USED}%* full on filesystem holding $REPO. Free space — rotate PM2 logs (\`pm2 flush\`), prune Docker (\`docker system prune\`), check \`agents/*/logs/\`."
  elif [ "${USED:-0}" -ge 90 ] 2>/dev/null; then
    dm "disk-90" "💾 *ginnie-agents:* disk *${USED}%* full. Watch closely or free space soon."
  fi
fi

# ── Memory caps per agent ─────────────────────────────────
if [ -d agents ]; then
  for d in agents/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    [ "$name" = ".gitkeep" ] && continue
    for pair in "rules:200:190" "playbook:300:290"; do
      tier="${pair%%:*}"; rest="${pair#*:}"
      cap="${rest%%:*}"; threshold="${rest##*:}"
      f="$d/memory/$tier.md"
      [ -f "$f" ] || continue
      n=$(wc -l < "$f" | tr -d ' ')
      if [ "$n" -gt "$cap" ] 2>/dev/null; then
        dm "memcap-$name-$tier-over" "🚫 *ginnie-agents:* \`${name}/memory/${tier}.md\` is *${n} lines* (cap ${cap}, *over*). Commits are now blocked by the hook. Run nightly consolidation."
      elif [ "$n" -ge "$threshold" ] 2>/dev/null; then
        dm "memcap-$name-$tier-near" "⚠️ *ginnie-agents:* \`${name}/memory/${tier}.md\` is *${n} lines* (cap ${cap}). Consolidation overdue."
      fi
    done
  done
fi

# Quiet success — only print on alert (caller can tail logs to see what fired).
exit 0
