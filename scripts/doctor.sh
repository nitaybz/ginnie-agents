#!/usr/bin/env bash
# scripts/doctor.sh — mechanical health check for ginnie-agents.
#
# Exit code:
#   0 = all checks passed
#   1 = at least one check failed (warnings don't trigger non-zero)
#
# Run from anywhere; the script anchors to its own location.
# Designed to be safe to run repeatedly. Reads only — never modifies state.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

passed=0
failed=0
warned=0

PASS() { printf "  \033[32m✓\033[0m %s\n" "$1"; passed=$((passed+1)); }
FAIL() { printf "  \033[31m✗\033[0m %s\n" "$1"; printf "      → %s\n" "$2"; failed=$((failed+1)); }
WARN() { printf "  \033[33m!\033[0m %s\n" "$1"; printf "      → %s\n" "$2"; warned=$((warned+1)); }
SECTION() { printf "\n\033[1m%s\033[0m\n" "$1"; }

# ─── Prerequisites ─────────────────────────────────────────
SECTION "Prerequisites"

if command -v node >/dev/null 2>&1; then
  v="$(node --version)"
  major="${v#v}"; major="${major%%.*}"
  if [ "$major" -ge 22 ] 2>/dev/null; then
    PASS "node $v"
  else
    FAIL "node $v (need v22+)" "Install Node 22+ from https://nodejs.org/"
  fi
else
  FAIL "node not installed" "Install Node 22+ from https://nodejs.org/"
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    PASS "docker $(docker --version | awk '{print $3}' | tr -d ',') (daemon up)"
  else
    FAIL "docker daemon not running" "Start Docker Desktop or your docker daemon"
  fi
else
  FAIL "docker not installed" "Install Docker from https://docs.docker.com/get-docker/"
fi

if command -v git >/dev/null 2>&1; then
  PASS "git $(git --version | awk '{print $3}')"
else
  FAIL "git not installed" "Install via your package manager"
fi

if command -v pm2 >/dev/null 2>&1; then
  PASS "pm2 $(pm2 --version 2>/dev/null)"
else
  FAIL "pm2 not installed" "npm i -g pm2"
fi

# ─── Environment ───────────────────────────────────────────
SECTION "Environment"

if [ -f .env ]; then
  PASS ".env present"
  if grep -qE '^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-' .env; then
    PASS "CLAUDE_CODE_OAUTH_TOKEN looks valid (starts with sk-ant-)"
  elif grep -qE '^CLAUDE_CODE_OAUTH_TOKEN=' .env; then
    FAIL "CLAUDE_CODE_OAUTH_TOKEN present but format suspect" \
      "Run \`claude setup-token\` and paste the new token into .env"
  else
    FAIL "CLAUDE_CODE_OAUTH_TOKEN missing in .env" \
      "Run \`claude setup-token\` and add CLAUDE_CODE_OAUTH_TOKEN=<token> to .env"
  fi
  if grep -qE '^TZ=' .env; then
    tz="$(grep -E '^TZ=' .env | head -1 | cut -d= -f2-)"
    if TZ="$tz" date >/dev/null 2>&1; then
      PASS "TZ=$tz (valid)"
    else
      FAIL "TZ=$tz (invalid)" "Use a tz database name like UTC, America/New_York"
    fi
  else
    WARN "TZ not set in .env" "Defaults to UTC. Add TZ=<zone> to .env to override."
  fi
else
  FAIL ".env missing" "cp .env.example .env, then fill in values"
fi

# ─── Shared config ─────────────────────────────────────────
SECTION "Shared config"

if [ -f shared/known-users.json ]; then
  if python3 -c "import json,sys; json.load(open('shared/known-users.json'))" 2>/dev/null; then
    PASS "shared/known-users.json present and valid JSON"
  else
    FAIL "shared/known-users.json invalid JSON" "Fix or reset to: {\"users\":{}}"
  fi
else
  FAIL "shared/known-users.json missing" "Create with: echo '{\"users\":{}}' > shared/known-users.json"
fi

# ─── Git hooks ─────────────────────────────────────────────
SECTION "Git hooks"

hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [ "$hooks_path" = "scripts/hooks" ]; then
  PASS "core.hooksPath = scripts/hooks"
else
  FAIL "core.hooksPath = ${hooks_path:-<unset>}" "Run: bash scripts/hooks/install.sh"
fi

if [ -x scripts/hooks/commit-msg ]; then
  PASS "commit-msg hook executable"
else
  FAIL "commit-msg hook missing or not executable" \
    "Run: bash scripts/hooks/install.sh"
fi

# ─── Docker image ──────────────────────────────────────────
SECTION "Docker image"

if docker info >/dev/null 2>&1; then
  if docker images --format '{{.Repository}}' | grep -qx 'ginnie-agent'; then
    PASS "ginnie-agent image built"
  else
    FAIL "ginnie-agent image not found" \
      "docker build -t ginnie-agent -f docker/Dockerfile ."
  fi
fi

# ─── Listener build ────────────────────────────────────────
SECTION "Listener"

if [ -f listener/dist/index.js ]; then
  PASS "listener built (dist/index.js exists)"
else
  FAIL "listener not built" "cd listener && npm install && npm run build"
fi

# PM2 process state
if command -v pm2 >/dev/null 2>&1; then
  status="$(pm2 jlist 2>/dev/null | python3 -c '
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
' 2>/dev/null || echo "not-loaded")"
  case "$status" in
    online\|*)
      restarts="${status#*|}"
      PASS "PM2 listener online (restarts: $restarts)"
      if [ "$restarts" -gt 5 ] 2>/dev/null; then
        WARN "high restart count: $restarts" \
          "Check \`pm2 logs ginnie-agents-listener\` for the cause"
      fi
      ;;
    errored\|*)
      FAIL "PM2 listener errored" \
        "pm2 logs ginnie-agents-listener; fix and \`pm2 restart ginnie-agents-listener\`"
      ;;
    stopped\|*)
      WARN "PM2 listener stopped" "pm2 start ecosystem.config.cjs"
      ;;
    not-loaded)
      WARN "PM2 listener not loaded" "pm2 start ecosystem.config.cjs"
      ;;
    *)
      WARN "PM2 listener status: $status" "Check \`pm2 status\`"
      ;;
  esac
fi

# ─── Agents ────────────────────────────────────────────────
SECTION "Agents"

agent_count=0
for d in agents/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  [ "$name" = ".gitkeep" ] && continue
  agent_count=$((agent_count+1))

  [ -f "$d/PROMPT.md" ] && PASS "$name: PROMPT.md" || FAIL "$name: PROMPT.md missing" "Required for agent discovery"
  [ -f "$d/SOUL.md" ] && PASS "$name: SOUL.md" || WARN "$name: SOUL.md missing" "Optional but strongly recommended (agent personality)"
  [ -f "$d/credentials.json" ] && PASS "$name: credentials.json" || FAIL "$name: credentials.json missing" "Add slack_bot_token, slack_app_token"
  [ -f "$d/config.json" ] || WARN "$name: config.json missing" "Defaults will be used"
  [ -f "$d/memory/rules.md" ] || WARN "$name: memory/rules.md missing" "Will be created on first run"
  [ -f "$d/memory/playbook.md" ] || WARN "$name: memory/playbook.md missing" "Will be created on first run"
done
if [ "$agent_count" -eq 0 ]; then
  printf "  (no agents yet — use the create-agent skill to add your first)\n"
fi

# ─── Memory caps ───────────────────────────────────────────
if [ "$agent_count" -gt 0 ]; then
  SECTION "Memory caps"
  for d in agents/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    [ "$name" = ".gitkeep" ] && continue
    if [ -f "$d/memory/rules.md" ]; then
      n=$(wc -l < "$d/memory/rules.md" | tr -d ' ')
      if [ "$n" -gt 200 ]; then
        FAIL "$name: rules.md is $n lines (cap 200)" "Run consolidation"
      elif [ "$n" -ge 190 ]; then
        WARN "$name: rules.md is $n lines (cap 200)" "Consolidation overdue"
      else
        PASS "$name: rules.md ($n/200)"
      fi
    fi
    if [ -f "$d/memory/playbook.md" ]; then
      n=$(wc -l < "$d/memory/playbook.md" | tr -d ' ')
      if [ "$n" -gt 300 ]; then
        FAIL "$name: playbook.md is $n lines (cap 300)" "Run consolidation"
      elif [ "$n" -ge 290 ]; then
        WARN "$name: playbook.md is $n lines (cap 300)" "Consolidation overdue"
      else
        PASS "$name: playbook.md ($n/300)"
      fi
    fi
  done
fi

# ─── Disk ──────────────────────────────────────────────────
SECTION "Disk"

if command -v df >/dev/null 2>&1; then
  if df_out="$(df -P "$REPO" 2>/dev/null | awk 'NR==2 {print $5}')"; then
    used="${df_out%\%}"
    if [ "$used" -ge 95 ] 2>/dev/null; then
      FAIL "disk ${used}% full" "Free space on $REPO's filesystem"
    elif [ "$used" -ge 90 ] 2>/dev/null; then
      WARN "disk ${used}% full" "Rotate logs, prune Docker images"
    else
      PASS "disk ${used}% used"
    fi
  fi
fi

# ─── Summary ───────────────────────────────────────────────
printf "\n\033[1mResult:\033[0m %d passed · %d failed · %d warnings\n" "$passed" "$failed" "$warned"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
exit 0
