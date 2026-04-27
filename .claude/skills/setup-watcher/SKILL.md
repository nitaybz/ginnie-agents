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

## Step 2 — Rotate the config token (atomic)

Use the framework's helper. It rotates the pair and persists the new pair to `.env` atomically (write-temp-and-rename) so a crash mid-rotation cannot leave you with a dead token. Echoes only the new access token to stdout — clean to capture in a shell var:

```bash
ACCESS=$(bash scripts/rotate-slack-config-token.sh) || {
  echo "rotation failed — see stderr above. If error was invalid_refresh_token,"
  echo "regenerate at https://api.slack.com/apps (bottom of page) and update .env."
  exit 1
}
```

**Never call `tooling.tokens.rotate` directly inside this skill** — every direct call is a chance to forget to persist the new pair, and that locks you out of the config-token API entirely. The helper exists to remove that footgun.

## Step 3 — Pick a name

Default: **`Watcher`**. You can also use a branded name like `Ginnie Watcher`. Don't pick a personal name (Pulse / Sage / etc.) — this is a utility, not an agent. A descriptive name makes it obvious to anyone who sees a DM what the bot is.

Ask the user to confirm or override.

## Step 3.5 — Prepare the avatar (optional but recommended)

Slack auto-crops bot icons to a circle. Most input images aren't square. Use ImageMagick to resize + center-crop:

```bash
# Requires: brew install imagemagick   (macOS)   or   apt-get install imagemagick   (Linux)
magick "/path/to/your-input-image.png" -resize 1024x1024^ -gravity center -extent 1024x1024 "/tmp/watcher-avatar.png"
```

`-resize 1024x1024^` scales the image so the smaller dimension is at least 1024. `-gravity center -extent 1024x1024` then center-crops to a square 1024×1024 PNG.

If the user has no image yet, suggest generating one with whatever image AI they prefer. Sample prompt: *"Square portrait, illustrative style, an unseen-but-vigilant watchful presence, eye motif, neutral background, 1024×1024, no text"* — but tool-agnostic, the user picks.

Save to a path the user can drag from Finder/Files later (e.g. `/tmp/watcher-avatar.png` on macOS). The upload itself is manual in Step 6 — Slack has no API for setting bot icons.

## Step 4 — Create the Watcher's Slack app via manifest

Read `templates/watcher-slack-manifest.json`, substitute `{{WATCHER_NAME}}`, **strip the `_comment` field** (Slack's manifest API rejects unknown top-level fields), POST to `apps.manifest.create`:

```bash
NAME="<chosen name>"
MANIFEST=$(sed "s/{{WATCHER_NAME}}/$NAME/g" templates/watcher-slack-manifest.json | jq -c 'del(._comment)')
RESP=$(curl -s -X POST https://slack.com/api/apps.manifest.create \
  -H "Authorization: Bearer $ACCESS" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "{\"manifest\": $MANIFEST}")
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
