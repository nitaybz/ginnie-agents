---
name: setup-maintenance-bot
description: Set up the optional maintenance bot — a script (not an AI agent) that runs hourly via cron, checks framework health (token expiry, framework updates, container health, error patterns, disk, memory caps), and DMs the operator on Slack only when something needs attention. Use when the user says "set up maintenance bot", "watchdog", "monitor framework", "alert me if something breaks", "/maintenance".
---

# Set up the Maintenance Bot

The maintenance bot is **not an AI agent.** It's `scripts/maintenance.sh` — a deterministic shell script invoked by cron, posting to Slack via a dedicated write-only Slack app. No Claude tokens consumed, no Docker container per check, no rate-limit pressure. The script alerts only when something actually needs the operator's attention; silence is correct.

This skill walks the user through giving the script what it needs: a Slack app to post from, the operator's Slack ID, a token-issued-at marker, and a cron entry.

Run from repo root.

## Step 1 — Pick a name

Ask the user what to call the maintenance bot. Suggestions: `Watch`, `Sentinel`, `Argus`, `Sage`, `Pulse`. Don't suggest "monitor" or "ops" — generic. Let them pick. The name shows up in Slack DMs.

## Step 2 — Verify Slack config tokens are present

```bash
grep -E '^SLACK_CONFIG_TOKEN=' .env > /dev/null && \
grep -E '^SLACK_CONFIG_REFRESH_TOKEN=' .env > /dev/null && echo "ok" || echo "missing"
```

If `missing`, the user needs to run the `setup` skill's Step 7b first to get config tokens. Stop here and tell them.

## Step 3 — Create the maintenance Slack app

Refresh the config token, then create a write-only app via manifest. The maintenance bot only POSTS — no Socket Mode, no event subscriptions, far fewer scopes than a regular agent.

```bash
ACCESS=$(grep -E '^SLACK_CONFIG_TOKEN=' .env | cut -d= -f2-)
REFRESH=$(grep -E '^SLACK_CONFIG_REFRESH_TOKEN=' .env | cut -d= -f2-)
ROTATED=$(curl -s -X POST https://slack.com/api/tooling.tokens.rotate -d "refresh_token=$REFRESH")
NEW_ACCESS=$(echo "$ROTATED" | jq -r .token)
NEW_REFRESH=$(echo "$ROTATED" | jq -r .refresh_token)
# Persist new pair to .env (write back; rotation invalidated the old)
```

Build the manifest. Write-only — minimal scopes, no Socket Mode, no events:

```json
{
  "display_information": {
    "name": "<NAME>",
    "description": "ginnie-agents maintenance bot — posts framework health alerts",
    "background_color": "#3a3a3a"
  },
  "features": {
    "bot_user": {
      "display_name": "<NAME>",
      "always_online": false
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": ["chat:write", "im:write", "users:read"]
    },
    "pkce_enabled": false
  },
  "settings": {
    "interactivity": { "is_enabled": false },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

Create:

```bash
curl -s -X POST https://slack.com/api/apps.manifest.create \
  -H "Authorization: Bearer $NEW_ACCESS" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "{\"manifest\": $(cat manifest.json | jq -c .)}"
```

Capture `app_id` from the response.

## Step 4 — User installs

> *"Click here to install <NAME> in your workspace: https://api.slack.com/apps/<APP_ID>/install-on-team — click **Install to Workspace**, then **Allow**. Then go to https://api.slack.com/apps/<APP_ID>/oauth and copy the `xoxb-…` Bot User OAuth Token. Paste it here."*

Validate:

```bash
curl -s -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer <xoxb-...>" | jq
```

Should return `ok: true` with `team_id`. If `ok: false`, regenerate or troubleshoot.

## Step 5 — Operator Slack ID

The "operator" is the human the bot DMs when issues arise. Ask:

> *"What's your Slack member ID? (Click your profile in Slack → ⋮ menu → 'Copy member ID' — starts with `U`.)"*

If the user doesn't know how to find it, do a lookup with the freshly-installed bot token:

```bash
# Replace <email> with the user's Slack email
curl -s -X POST https://slack.com/api/users.lookupByEmail \
  -H "Authorization: Bearer <xoxb-...>" -d "email=<email>" | jq -r .user.id
```

## Step 6 — Write env vars

Add to `.env` (use a simple `python3` or `sed` rewrite that preserves other lines):

```
MAINTENANCE_BOT_TOKEN=xoxb-...
OPERATOR_SLACK_ID=U0XXXXXXXXX
```

## Step 7 — Token-issued-at marker

The script's token-expiry check needs to know when the user last ran `claude setup-token`. Create the marker file with today's date:

```bash
mkdir -p data
date '+%Y-%m-%d' > data/token-issued-at.txt
```

Tell the user: *"Every time you run `claude setup-token` (annual rotation), update this file: `date '+%Y-%m-%d' > data/token-issued-at.txt`. The bot uses it to alert you 30 days before the 1-year token expiry."*

## Step 8 — Smoke test (force one alert)

Before installing the cron entry, prove the script can DM you. Temporarily delete the cooldown for one alert kind, then run:

```bash
rm -f data/maintenance-cooldowns/* 2>/dev/null
# Force a "framework update" alert by creating a fake-ahead state, OR just
# call dm directly. Simplest: run the script with disk threshold lowered.
DISK_THRESHOLD=0 bash scripts/maintenance.sh
```

(If you want a guaranteed alert without conditions, add a temporary `dm "smoke-test" "🧪 maintenance bot smoke test"` line at the top of the script, run it, then remove the line.)

Confirm the user got the DM. If not, debug:
- `MAINTENANCE_BOT_TOKEN` correct?
- `OPERATOR_SLACK_ID` correct?
- Does `chat.postMessage` to the operator's user ID work? (The Slack API treats user IDs as DM channels automatically.)

## Step 9 — Install cron

Show the user the exact crontab entry. Run as the user who owns the repo (NOT root):

```bash
echo "0 * * * * $(pwd)/scripts/maintenance.sh >>/tmp/ginnie-agents-maintenance.log 2>&1"
```

Tell them to add it via `crontab -e`. Don't run `crontab` from this skill — modifying user crontabs without explicit interactive consent is the wrong default.

Hourly is the recommended cadence — frequent enough to catch issues fast, infrequent enough that the cooldown system (24h per alert kind) keeps Slack quiet.

Alternative: PM2 cron. Add to `ecosystem.config.cjs`:

```js
{
  name: "ginnie-agents-maintenance",
  script: "./scripts/maintenance.sh",
  cron_restart: "0 * * * *",
  autorestart: false,
  watch: false,
}
```

Then `pm2 restart ecosystem.config.cjs`. Use this if the user already has PM2 ownership of the framework and prefers to keep everything PM2-managed.

## Step 10 — Document

Tell the user:
1. The bot will be silent unless something needs attention. **Silence is correct.**
2. To see what the script checked even when it's silent, tail `/tmp/ginnie-agents-maintenance.log`.
3. Cooldowns are in `data/maintenance-cooldowns/`. Delete a file to allow that alert kind to fire again before the 24h cooldown expires.
4. To DM-test that the bot is wired up at any time: `bash scripts/maintenance.sh` after `rm -f data/maintenance-cooldowns/*`.
5. If you want to add a new check, edit `scripts/maintenance.sh` directly. Each check is a self-contained block ending in a `dm <key> "<msg>"` call.

## Why a bot, not an agent

The maintenance work is mechanical — `df`, `wc -l`, `git fetch`, `pm2 jlist`. Wrapping that in a Claude Agent SDK container per scan would burn rate limits, cost money, and add minutes of latency for no judgment value. The script does the same checks in milliseconds, deterministically, for free. Reserve agents (full AI, SOUL, memory) for work that genuinely benefits from reasoning.
