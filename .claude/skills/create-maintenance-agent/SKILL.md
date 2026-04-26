---
name: create-maintenance-agent
description: Scaffold a self-monitoring agent that watches token expiry, framework updates, container health, and error patterns — alerts the operator via Slack DM. Use when the user says "create maintenance agent", "set up monitor", "self-monitor", "watchdog", or asks how to be notified when something breaks.
---

# Create Maintenance Agent

A maintenance agent is a regular agent with prebuilt routines focused on watching the framework itself. It watches:

- **Token expiry** — `claude setup-token` is ~1 year; alerts 30 days before
- **Framework updates** — runs `git fetch` periodically and reports if `origin/main` is ahead
- **Container health** — restart loops, repeated container exits with non-zero code
- **Error patterns** — scans listener log for FATAL / repeated errors / auth failures
- **Disk** — alerts when free space drops below threshold
- **Memory caps** — alerts when an agent's `rules.md` or `playbook.md` is within 10 lines of cap

It's just an agent — uses the same template, same SOUL, same memory model. The user picks the name. Don't suggest "monitor" or "ops"; let them choose. Examples a user might pick: "Watch", "Sentinel", "Argus", "Nina", "Eli." Or anything else.

## Step 1 — Run create-agent first

Use the `create-agent` skill end-to-end. Treat this skill as a wrapper that, after `create-agent` finishes, layers maintenance-specific PROMPT additions, schedules, and known-users entry on top.

When `create-agent` asks about role/mission, suggest:
> "Self-monitoring agent for the framework. Watches token expiry, available framework updates, container health, error patterns, disk, and memory caps. DMs the operator when something needs attention."

When `create-agent` asks about boundaries, suggest **read-only**.

When it asks about work hours, suggest **enabled: false** (24/7 monitoring; alerts queue naturally because alerts are messages it sends, not messages it receives).

When it asks about Slack channel: a private channel like `#ops` or DM the operator. The maintenance agent rarely posts in shared channels — most output is DMs to a designated operator (specified by Slack ID).

## Step 2 — PROMPT.md additions

After `create-agent` writes the base PROMPT.md, append (or replace `{{ROLE_SPECIFIC_INSTRUCTIONS}}`):

```markdown
## Watches

You run periodic health scans and alert ONLY when something needs attention. Silence is correct — never post "all green" routinely. The operator's DM should only get pinged when there's something actionable.

### Token expiry

```bash
# CLAUDE_CODE_OAUTH_TOKEN expiry can't be introspected from inside the agent
# (no SDK call exposes it). Track approximate expiry via a state file:
TOKEN_FILE=./memory/token-issued-at.txt
[ -f "$TOKEN_FILE" ] || date '+%Y-%m-%d' > "$TOKEN_FILE"
ISSUED=$(cat "$TOKEN_FILE")
DAYS=$(( ( $(date +%s) - $(date -j -f '%Y-%m-%d' "$ISSUED" +%s 2>/dev/null || date -d "$ISSUED" +%s) ) / 86400 ))
# Alert at 335 days (30 days before 1y expiry)
[ "$DAYS" -ge 335 ] && DM "Operator — Claude Code OAuth token is $DAYS days old. Run \`claude setup-token\` and update CLAUDE_CODE_OAUTH_TOKEN in .env (and ~/.zshrc), then \`pm2 restart ginnie-agents-listener --update-env\`."
```

When the user runs `claude setup-token` and updates the token, they should also update `./memory/token-issued-at.txt` to today. Document this in the alert.

### Framework updates

```bash
git fetch
AHEAD=$(git rev-list --count HEAD..origin/main)
if [ "$AHEAD" -gt 0 ]; then
  TITLES=$(git log HEAD..origin/main --oneline | head -10)
  DM "Operator — $AHEAD new framework commit(s) on origin/main:\n$TITLES\n\nRun the update-framework skill to apply."
fi
```

### Container health

Tail the listener log for the last hour. Alert if you see any of:
- Repeated `Container exited with code` (≥3 same agent within an hour) — likely crash loop
- `start failed:` (Slack auth issues at boot)
- `FATAL` lines

Group by agent and DM ONE summary per scan, not per occurrence.

### Disk

```bash
USAGE=$(df -h "$REPO" | awk 'NR==2 {print $5}' | tr -d %)
[ "$USAGE" -ge 90 ] && DM "Operator — disk at ${USAGE}% on the host. Check $REPO and rotate logs if needed."
```

### Memory caps

For each agent in `agents/*/memory/`:
```bash
RULES=$(wc -l < agents/<a>/memory/rules.md)
PLAYBOOK=$(wc -l < agents/<a>/memory/playbook.md)
[ "$RULES" -ge 190 ] && DM "<a>'s rules.md is $RULES lines (cap 200). Consolidation overdue."
[ "$PLAYBOOK" -ge 290 ] && DM "<a>'s playbook.md is $PLAYBOOK lines (cap 300). Consolidation overdue."
```

## Operator

The "operator" is the human you alert. Their Slack ID is in `./config.json` as `operator_slack_id`. DM them via:

```bash
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\":\"$OPERATOR_SLACK_ID\",\"text\":\"...\"}"
```

(Slack accepts a user ID as the `channel` field; it auto-opens an IM.)

## Cooldown

Don't spam. After an alert, write to `./memory/episodes/$Q.md` what you alerted about and when. On next scan, skip alerts that fired within the last 24 hours unless severity escalated.
```

## Step 3 — Schedules

In `schedules.json`, add:

```json
{
  "schedules": [
    {
      "id": "hourly-health",
      "cron": "0 * * * *",
      "message": "Run hourly health scan: framework updates, container health, error patterns. DM operator only if anything needs attention.",
      "description": "Hourly health scan",
      "enabled": true
    },
    {
      "id": "daily-token-check",
      "cron": "0 9 * * *",
      "message": "Check token age and memory caps. DM operator only if anything is over threshold.",
      "description": "Daily token + memory cap check",
      "enabled": true
    }
  ]
}
```

## Step 4 — Operator config

Add to the agent's `config.json`:

```json
{
  "operator_slack_id": "U0XXXXXXXXX"
}
```

Ask the user for their Slack member ID (same lookup as `manage-known-users`).

## Step 5 — Memory state seed

Create `./memory/token-issued-at.txt` with today's date so the token-age math works out of the box:

```bash
date '+%Y-%m-%d' > agents/<n>/memory/token-issued-at.txt
```

Tell the user: "After every `claude setup-token`, overwrite this file with the current date so the maintenance agent's expiry math stays accurate."

## Step 6 — Visibility

When `create-agent` asks visibility, suggest `(c) no agents` or `(b) only itself` — the maintenance agent is for the operator, not for other agents to coordinate with.

## Step 7 — Smoke test

Manually trigger a routine to verify it runs:
```bash
curl -s -X POST <your slack workspace> ... # send a test @mention
```

Or wait for the next scheduled fire (hourly is fast enough). The first scan should be silent unless something is genuinely wrong.

## Notes

- This agent shouldn't have its own credentials beyond Slack. No Supabase, no cloud APIs. Everything it watches is on the local filesystem or git remote.
- If the user wants the maintenance agent to also restart things or apply updates: that's a different agent (a "deploy" agent), out of scope for this skill. Let the maintenance agent alert; let the operator decide.
- Don't name this agent generically ("monitor", "ops") — it works better as a person. Push the user to pick a real-sounding name.
