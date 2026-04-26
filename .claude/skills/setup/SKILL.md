---
name: setup
description: First-run setup for ginnie-agents — verifies prerequisites, generates a long-lived Claude Code OAuth token, scaffolds .env, installs git hooks, builds the Docker image, builds the listener, and starts PM2. Use when the user clones the repo and says "set up", "set me up", "first run", "install", or invokes this directly.
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

## Step 2 — Long-lived Claude Code token

This is the single most important step. Without it, agents stop running after ~8 hours.

The token lives in **`.env` only.** No shell rc edits, no exports needed — the listener loads `.env` directly via dotenv (with override) at startup, so PM2 picks it up automatically every restart.

First check whether the user already has a token from a previous `claude setup-token`:

```bash
echo "${CLAUDE_CODE_OAUTH_TOKEN:0:14}"   # prints first 14 chars or empty
```

If non-empty AND starts with `sk-ant-`, ask the user if they'd like to reuse it. Otherwise:

Ask the user to run `claude setup-token` themselves in another terminal (it's interactive — you cannot run it for them). Direct them to copy the printed token, which starts with `sk-ant-oat01-...`.

Then write it to `.env`:

```bash
[ -f .env ] || cp .env.example .env
# Update or add CLAUDE_CODE_OAUTH_TOKEN line in .env
python3 - <<'PY'
import re, pathlib
p = pathlib.Path(".env")
text = p.read_text()
token = "<paste-token>"
if "CLAUDE_CODE_OAUTH_TOKEN=" in text:
    text = re.sub(r"^CLAUDE_CODE_OAUTH_TOKEN=.*$", f"CLAUDE_CODE_OAUTH_TOKEN={token}", text, flags=re.M)
else:
    text += f"\nCLAUDE_CODE_OAUTH_TOKEN={token}\n"
p.write_text(text)
PY
```

Validate format (`sk-ant-oat01-...` or similar long string starting with `sk-ant-`). Confirm it landed:

```bash
grep '^CLAUDE_CODE_OAUTH_TOKEN=' .env | sed 's/=.*/=<set>/'   # don't print value
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

## Step 7 — Slack workspace setup (deferred)

Tell the user: "Slack apps are created per-agent, not framework-wide. We'll set up your first Slack app when you run `create-agent`. Right now we just need somewhere for agents to live."

Ask for their Slack workspace URL so we can include it in the agent setup hint later (saved nowhere yet — it's a UX hint).

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
