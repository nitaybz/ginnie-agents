---
name: setup
description: First-run setup for ginnie-agents — verifies prerequisites, asks the user to pick an auth mode (subscription OAuth or Anthropic API key) and configures it, scaffolds .env, installs git hooks, builds the Docker image, builds the listener, and starts PM2. Use when the user clones the repo and says "set up", "set me up", "first run", "install", or invokes this directly.
---

# Setup — First-run

The user has just cloned `ginnie-agents`. This skill takes them from a fresh clone to a running listener with no agents yet. After this, they use `create-agent` to add their first agent.

Do everything from the repo root (`pwd` should be the directory containing this `.claude/`).

## Step 1 — Verify prerequisites

Run these checks in parallel and report any that fail. Do **not** continue if any fail; tell the user what to install.

```bash
node --version          # Need v22 or newer
docker --version        # Need any modern Docker
docker info >/dev/null  # Daemon must be running
git --version
which pm2 || npm i -g pm2
```

If `docker info` fails, the daemon isn't running — tell the user to start Docker Desktop / their Docker daemon.

If Node is older than 22, point them at https://nodejs.org/.

## Step 2 — Authentication

This is the single most important step. Without auth configured, agents can't talk to Claude.

The framework supports two modes. **You must present the choice to the user — do not silently default.** Paste the disclosure below verbatim, then ask which option they want.

> **Auth modes — pick one:**
>
> **Option A — OAuth token from a Claude subscription** (Free / Pro / Max / Team / Enterprise)
> - Long-lived (~1 year), flat subscription cost, no per-call billing.
> - **IMPORTANT — per [Anthropic's usage policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use), OAuth is intended for ordinary individual use of Claude Code by the subscriber.** Anthropic does NOT permit routing requests through subscription credentials on behalf of other users.
> - Appropriate when: you are the subscriber, agents are your personal/internal automation, volume stays in a sane range for one human's usage.
> - **Not appropriate** (risks token revocation / account suspension) when: agents serve external customers, your team beyond yourself, or anything resembling a hosted product.
>
> **Option B — Anthropic API key from Console**
> - Per-token billing. Fully supported by Anthropic's terms for automation, products, and multi-user scenarios.
> - Higher cost than Option A, but no authentication risk.
> - Appropriate when: agents serve other users (teammates, customers), or volume is high, or you're operating ginnie-agents as a service.
>
> **Which one fits your use case — A or B?**

Wait for the user's answer before proceeding.

### If the user picks Option A — OAuth token

First check whether the user already has a token from a previous `claude setup-token`:

```bash
echo "${CLAUDE_CODE_OAUTH_TOKEN:0:14}"   # prints first 14 chars or empty
```

If non-empty AND starts with `sk-ant-`, ask the user if they'd like to reuse it. Otherwise:

Ask the user to run `claude setup-token` themselves in another terminal (it's interactive — you cannot run it for them). Direct them to copy the printed token, which starts with `sk-ant-oat01-...`.

Then write it to `.env`:

```bash
[ -f .env ] || cp .env.example .env
# Update or add CLAUDE_CODE_OAUTH_TOKEN line in .env, and ensure ANTHROPIC_API_KEY is blank
python3 - <<'PY'
import re, pathlib
p = pathlib.Path(".env")
text = p.read_text()
token = "<paste-token>"
if "CLAUDE_CODE_OAUTH_TOKEN=" in text:
    text = re.sub(r"^CLAUDE_CODE_OAUTH_TOKEN=.*$", f"CLAUDE_CODE_OAUTH_TOKEN={token}", text, flags=re.M)
else:
    text += f"\nCLAUDE_CODE_OAUTH_TOKEN={token}\n"
# Make sure API key is not also set — Option A means Option A.
text = re.sub(r"^ANTHROPIC_API_KEY=.*$", "ANTHROPIC_API_KEY=", text, flags=re.M)
p.write_text(text)
PY
```

Validate format (`sk-ant-oat01-...` or similar long string starting with `sk-ant-`). Confirm it landed:

```bash
grep '^CLAUDE_CODE_OAUTH_TOKEN=' .env | sed 's/=.*/=<set>/'   # don't print value
```

### If the user picks Option B — Anthropic API key

Direct the user to https://console.anthropic.com/ → **API Keys** → **Create Key**. Ask them to paste the key (it starts with `sk-ant-api03-...` or similar `sk-ant-` prefix).

Then write it to `.env`:

```bash
[ -f .env ] || cp .env.example .env
# Update or add ANTHROPIC_API_KEY line in .env, and clear CLAUDE_CODE_OAUTH_TOKEN
python3 - <<'PY'
import re, pathlib
p = pathlib.Path(".env")
text = p.read_text()
key = "<paste-key>"
if "ANTHROPIC_API_KEY=" in text:
    text = re.sub(r"^ANTHROPIC_API_KEY=.*$", f"ANTHROPIC_API_KEY={key}", text, flags=re.M)
else:
    text += f"\nANTHROPIC_API_KEY={key}\n"
# Clear OAuth token if previously set — keeping the env clean to one mode.
text = re.sub(r"^CLAUDE_CODE_OAUTH_TOKEN=.*$", "CLAUDE_CODE_OAUTH_TOKEN=", text, flags=re.M)
p.write_text(text)
PY
```

Validate format (starts with `sk-ant-`). Confirm it landed:

```bash
grep '^ANTHROPIC_API_KEY=' .env | sed 's/=.*/=<set>/'   # don't print value
```

That's it — no further shell setup needed. When PM2 restarts the listener, it re-reads `.env`.

## Step 3 — Pick a timezone

Ask the user what timezone they want their agents to operate in. This affects:
- The scheduler (cron expressions in `schedules.json` are interpreted in this TZ)
- The container's `date` command output
- Work-hours enforcement
- Off-hours notice text

Show common options: `UTC`, `America/New_York`, `Europe/London`, `Asia/Tokyo`, `Asia/Jerusalem`, `Australia/Sydney`. Default `UTC` if they have no preference.

Update `TZ=` in `.env`.

## Step 4 — Install git hooks

```bash
bash scripts/hooks/install.sh
```

This wires `core.hooksPath` to `scripts/hooks/` so the memory cap + append-only enforcement runs on every commit.

## Step 5 — Build Docker image

```bash
docker build -t ginnie-agent -f docker/Dockerfile .
```

Takes 1–3 minutes on first build (downloads Node 22 base + installs Claude Agent SDK).

## Step 6 — Build the listener

```bash
cd listener
npm install
npm run build
cd ..
```

If `npm run build` fails, paste the error and stop — usually a TypeScript version mismatch worth investigating.

## Step 7 — Slack workspace + per-agent app strategy

Two pieces of Slack setup land here, once per installation. Per-agent apps still get created during `create-agent` — but the workspace identity and the strategy choice live framework-wide.

### 7a — Workspace URL

Ask: *"What's your Slack workspace URL?"* (e.g., `acme.slack.com`). Store in `.env` as `SLACK_WORKSPACE_URL=acme.slack.com`.

### 7b — App creation strategy

Ask:

> "When you create new agents later, do you want me to:
>
> **(a) Programmatic** — generate the Slack app definition (scopes, events, Socket Mode) automatically via Slack's manifest API. You'll still do ~3 manual clicks per agent (install the app, copy bot token, generate App-Level Token, upload icon). But you skip the ~20 clicks of clicking through scopes and event subscriptions one by one. Requires a one-time admin/owner-level token.
>
> **(b) Manual** — you click through every step at api.slack.com yourself. ~20 clicks per agent, no admin token required."

If user picks **(a)**:
- Direct them to https://api.slack.com/apps → scroll to the **bottom of the page** → look for **"Your App Configuration Tokens"** section → click **Generate Token** → pick the workspace.
- Two tokens are returned: an **Access Token** (`xoxe.xoxp-…`) and a **Refresh Token** (`xoxe-…`). Both must be admin/owner of the workspace.
- Ask the user to paste both. Store as `SLACK_CONFIG_TOKEN=xoxe.xoxp-...` and `SLACK_CONFIG_REFRESH_TOKEN=xoxe-...` in `.env`.
- **Note:** Access tokens expire every 12 hours. The framework auto-refreshes using the refresh token, so the user does this once.
- Validate by calling:
  ```bash
  curl -s -X POST https://slack.com/api/tooling.tokens.rotate \
    -d "refresh_token=$SLACK_CONFIG_REFRESH_TOKEN" | jq .ok
  ```
  If `true`, write the new token + refresh token from the response back into `.env` (rotation invalidates the old ones).

If user picks **(b)**: nothing to store. The `create-agent` skill will fall back to the manual click-through walkthrough.

Either way, this is one-time. After this, `create-agent` reads `.env` and picks the right path automatically.

## Step 8 — Start PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

The listener reads `.env` directly via dotenv on every restart — `--update-env` is not needed for `CLAUDE_CODE_OAUTH_TOKEN` or `TZ`.

Verify:
```bash
pm2 logs ginnie-agents-listener --lines 10 --nostream
```

Expected output: `⚡ ginnie-agents listener running (Socket Mode, multi-app)` followed by `Started: none` and `No agents configured yet. Listener idle — ...`. The listener stays online indefinitely with no agents (a built-in heartbeat keeps the event loop alive); PM2 should show it as `online`, NOT `errored` or rapidly restarting.

If `pm2 status` shows the listener restart-looping or `errored`, something is wrong — check the log for the actual error.

## Step 9 — Run doctor

Run `bash scripts/doctor.sh` and report any failures. The script handles all the mechanical checks (prerequisites, env, hooks, Docker image, PM2 state, agent configs, memory caps, disk). Use the `doctor` skill if you want to interpret failures or do extra context-aware checks (Slack reachability, etc.).

Expected on a fresh install: every check green except per-agent ones (no agents yet — that's fine).

## Step 10 — Done

Tell the user:
1. Setup complete. Listener is running on PM2.
2. To create your first agent: ask Claude to `create an agent for <role>`.
3. To check health later: ask Claude to `run doctor` or just run `bash scripts/doctor.sh`.
4. To update the framework when new versions land: ask Claude to `update the framework`.
5. **Optional but recommended:** make PM2 launch on host reboot. Tell the user to run these themselves (the first command requires sudo and the user's password):

   ```bash
   pm2 startup    # then run the printed sudo command
   pm2 save
   ```

   Don't try to run `pm2 startup` from the skill — it requires interactive sudo.
