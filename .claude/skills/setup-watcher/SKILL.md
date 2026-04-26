---
name: setup-watcher
description: Set up the Watcher — a long-running daemon (not an AI agent) that monitors framework health (token expiry, framework updates, PM2 listener state, disk, memory caps) and DMs the operator on Slack with interactive buttons (Update now / Restart / Ack). Use when the user says "set up watcher", "set up the watcher", "install watcher", "watchdog", "monitor framework", "alert me if something breaks", "/watcher".
---

# Set up the Watcher

The Watcher is a small Node daemon that runs alongside the listener (managed by PM2). It's *not* an AI agent — no Claude tokens consumed, no Docker container per check. It uses a dedicated Slack app to:

- DM the operator on framework health issues
- Post interactive buttons on actionable alerts
- Respond to `/watcher` slash commands

This skill creates the Slack app, captures tokens, writes `.env`, and wires the Watcher into PM2.

Run from repo root.

## Step 0 — Prerequisites

The framework's `setup` skill must have completed (CLAUDE_CODE_OAUTH_TOKEN in `.env`, listener running). Verify with:

```bash
bash scripts/doctor.sh
```

If the listener isn't running, fix that first; the Watcher's job is partly to watch the listener.

## Step 1 — Verify Slack config tokens

```bash
grep -E '^SLACK_CONFIG_TOKEN=' .env > /dev/null && \
grep -E '^SLACK_CONFIG_REFRESH_TOKEN=' .env > /dev/null && echo "ok" || echo "missing"
```

If `missing`: ask the user to generate config tokens at https://api.slack.com/apps (scroll to bottom → "Your App Configuration Tokens" → Generate Token → pick the workspace), paste both. Add to `.env`. Then continue.

If config tokens are present but stale, the next step will fail with `invalid_refresh_token` — instruct the user to regenerate at the same URL.

## Step 2 — Refresh the config token

```bash
ACCESS=$(grep -E '^SLACK_CONFIG_TOKEN=' .env | cut -d= -f2-)
REFRESH=$(grep -E '^SLACK_CONFIG_REFRESH_TOKEN=' .env | cut -d= -f2-)
ROTATED=$(curl -s -X POST https://slack.com/api/tooling.tokens.rotate -d "refresh_token=$REFRESH")
NEW_ACCESS=$(echo "$ROTATED" | jq -r .token)
NEW_REFRESH=$(echo "$ROTATED" | jq -r .refresh_token)
[ "$NEW_ACCESS" = "null" ] && echo "rotation failed: $ROTATED" && exit 1
# Persist new pair into .env (overwrite both lines)
```

Use a small `python3` rewrite to update `.env` (preserves other lines).

## Step 3 — Pick a name

Default: **`Watcher`**. You can also use a branded name like `Ginnie Watcher`. Don't pick a personal name (Pulse / Sage / etc.) — this is a utility, not an agent. A descriptive name makes it obvious to anyone who sees a DM what the bot is.

Ask the user to confirm or override.

## Step 4 — Create the Watcher's Slack app via manifest

Read `templates/watcher-slack-manifest.json`, substitute `{{WATCHER_NAME}}`, POST to `apps.manifest.create`:

```bash
NAME="<chosen name>"
MANIFEST=$(cat templates/watcher-slack-manifest.json | sed "s/{{WATCHER_NAME}}/$NAME/g")
RESP=$(curl -s -X POST https://slack.com/api/apps.manifest.create \
  -H "Authorization: Bearer $NEW_ACCESS" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "{\"manifest\": $(echo "$MANIFEST" | jq -c .)}")
APP_ID=$(echo "$RESP" | jq -r .app_id)
[ "$APP_ID" = "null" ] && echo "manifest.create failed: $RESP" && exit 1
echo "Created Watcher app: $APP_ID"
```

## Step 5 — User installs (1 click)

> *"Click here to install $NAME in your workspace: `https://api.slack.com/apps/$APP_ID/install-on-team` — click **Install to Workspace**, then **Allow**."*

After install, they land on the OAuth & Permissions page.

## Step 6 — Capture the Bot OAuth Token

> *"Copy the **Bot User OAuth Token** (starts with `xoxb-…`) at the top of the OAuth & Permissions page. Paste it here."*

Validate:
```bash
curl -s -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer <xoxb-...>" | jq
```

Confirm `ok: true`.

## Step 7 — Generate the App-Level Token

> *"Go to https://api.slack.com/apps/$APP_ID/general → scroll to **App-Level Tokens** → click **Generate Token and Scopes**. Name: `watcher-socket`. Add **all three** scopes: `connections:write`, `authorizations:read`, `app_configurations:write`. Click Generate. Copy the `xapp-…` token and paste it here."*

## Step 8 — Operator Slack ID

> *"What's your Slack member ID? Click your profile in Slack → ⋮ menu → 'Copy member ID' (starts with `U`). Paste here."*

If the user doesn't know how to find it, look it up via `users.lookupByEmail` with the freshly-installed Watcher token.

## Step 9 — Write env vars

Append (or update) in `.env`:

```
WATCHER_BOT_TOKEN=xoxb-...
WATCHER_APP_TOKEN=xapp-...
OPERATOR_SLACK_ID=U0XXXXXXXXX
```

Use a python3 rewrite to preserve existing keys.

## Step 10 — Token-issued-at marker

The Watcher's token-expiry check needs to know when the user last ran `claude setup-token`. Create the marker with today's date:

```bash
mkdir -p data
date '+%Y-%m-%d' > data/token-issued-at.txt
```

Tell the user: *"After every `claude setup-token` rotation (annual), update this file: `date '+%Y-%m-%d' > data/token-issued-at.txt`. Without this, the Watcher can't tell you when expiry is near."*

## Step 11 — Build + start

```bash
cd listener && npm install --no-audit --no-fund && npm run build && cd ..
pm2 start ecosystem.config.cjs    # or pm2 restart if already running
pm2 save
```

The Watcher process is `ginnie-agents-watcher` in PM2. Verify:

```bash
pm2 list | grep ginnie
pm2 logs ginnie-agents-watcher --lines 5 --nostream
```

Expected log line: `⚡ ginnie-agents Watcher running (Socket Mode)`.

## Step 12 — Smoke test

In Slack, type `/watcher status` (the slash command will show up in Slack's autocomplete after install). Should respond with the current state — paused/active, cooldowns, etc. Then type `/watcher check` — runs all checks now; you should see a DM if anything fires.

If `/watcher` doesn't appear:
- Confirm the app's Slash Commands feature is enabled in the manifest (the template has it)
- Reinstall the app to your workspace (Slack sometimes caches old scopes)
- Check `pm2 logs ginnie-agents-watcher` for errors

## What you get

- **DMs only when something needs attention.** Silence is correct.
- **Buttons on actionable alerts:**
  - Framework update → `[Update now]` `[Remind tomorrow]` `[Skip this version]`
  - Listener errored → `[View logs]` `[Restart listener]`
  - Listener stopped → `[Restart listener]`
  - Memory cap warning → `[Ack 24h]` `[Ack 7d]`
- **Slash commands** for on-demand:
  - `/watcher status` — current state
  - `/watcher check` — force a check pass now
  - `/watcher pause [hours]` — mute alerts (default 1h)
  - `/watcher resume` — clear pause
  - `/watcher doctor` — run scripts/doctor.sh and post results

## Why a daemon, not a cron script

The Watcher needs to handle button clicks (the [Update now] button shells out to `scripts/update-framework.sh` and posts progress) and slash commands. Both require Slack's interactivity, which requires a persistent connection (Socket Mode). A cron-script can't hold a WebSocket open. So the Watcher is a small Node process — but still no AI, no Claude tokens, no Docker per check.
