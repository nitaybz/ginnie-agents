---
name: doctor
description: Health check for ginnie-agents — verifies prerequisites, environment, hooks, listener, Docker image, agents, memory caps, and disk. Use when the user says "doctor", "health check", "check setup", "is everything ok", or after running setup/update.
---

# Doctor — Health Check

The mechanical checks live in `scripts/doctor.sh` so they run identically every time, with or without Claude. This skill runs the script and adds the contextual checks (Slack reachability, token-age awareness, `claude setup-token` rotation hint) that benefit from a per-installation read.

Run from repo root.

## Step 1 — Run the script

```bash
bash scripts/doctor.sh
```

Exit code: `0` = all green, `1` = at least one failure.

The script's output is already human-readable (✓/✗/!) with fix suggestions. Show it to the user as-is. Don't paraphrase.

If exit code is non-zero, do NOT continue to the contextual checks below until the script's failures are addressed — they're foundational. Tell the user exactly what to fix.

## Step 2 — Contextual: Slack reachability

The script doesn't hit Slack (it's a mechanical, network-free check). If the user wants a deeper verification, do this for each agent that has `credentials.json`:

```bash
for d in agents/*/; do
  [ -d "$d" ] || continue
  agent="$(basename "$d")"
  token="$(jq -r .slack_bot_token "$d/credentials.json" 2>/dev/null)"
  [ -n "$token" ] && [ "$token" != "null" ] || continue
  result=$(curl -s -X POST https://slack.com/api/auth.test \
    -H "Authorization: Bearer $token" | jq -r '"\(.ok) \(.error // "—") \(.team // "—")"')
  echo "  $agent: $result"
done
```

Interpret:
- `true — <Workspace Name>` → token good
- `false invalid_auth` → token revoked or wrong; regenerate at the agent's Slack app OAuth & Permissions page, update `agents/<n>/credentials.json`, `pm2 restart ginnie-agents-listener`
- `false token_revoked` → same fix
- `false account_inactive` → user removed from workspace
- `false ratelimited` → wait, retry

## Step 3 — Contextual: token age awareness

`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` lasts ~1 year. There's no API to introspect issuance date from outside the token itself. If a `memory/token-issued-at.txt` file exists in any maintenance agent's memory dir, surface its age:

```bash
for f in agents/*/memory/token-issued-at.txt; do
  [ -f "$f" ] || continue
  d=$(cat "$f")
  age=$(( ( $(date +%s) - $(date -j -f '%Y-%m-%d' "$d" +%s 2>/dev/null || date -d "$d" +%s) ) / 86400 ))
  echo "  $(dirname "$(dirname "$f")") tracker: token aged $age days (cap ~365)"
done
```

If any are >330 days old, recommend `claude setup-token` and refreshing `.env` + the tracker file.

## Step 4 — Final summary

If the script exited 0 and Slack is reachable, summarize: **"Healthy — N agents online, all Slack tokens valid, no memory caps near limit."**

If anything failed, list the failures + their suggested fixes in priority order:

1. `.env` / token issues (foundation)
2. Hooks (data integrity)
3. Listener / PM2 (runtime)
4. Per-agent issues (specific to one agent)
5. Memory caps (background concern)
6. Disk (background concern)
