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

Ask the user to run `claude setup-token` themselves (it's interactive — you can't run it for them). Direct them to copy the printed token.

Then ask them to paste it. Validate format (`sk-ant-oat01-...` or similar long string starting with `sk-ant-`). Write it to `.env`:

```bash
# If .env doesn't exist yet, copy from example
[ -f .env ] || cp .env.example .env
# Update CLAUDE_CODE_OAUTH_TOKEN in .env (use sed or read+rewrite)
```

For the user's shell to inherit it on next PM2 start, append:
```bash
echo 'export CLAUDE_CODE_OAUTH_TOKEN=<paste>' >> ~/.zshrc   # or ~/.bashrc
```

Tell the user to `source ~/.zshrc` before PM2 picks it up.

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
pm2 start ecosystem.config.cjs --update-env
pm2 save
```

`--update-env` forces PM2 to pick up `CLAUDE_CODE_OAUTH_TOKEN` and `TZ` from the current shell.

Verify:
```bash
pm2 logs ginnie-agents-listener --lines 10 --nostream
```

Expected output: `⚡ ginnie-agents listener running (Socket Mode, multi-app)` followed by `Started: none` (no agents yet) and `Skipped: none`.

If you see `Skipped: <agent> (start failed: …)`, that's expected if there are agents but their tokens aren't set yet.

## Step 9 — Run doctor

Invoke the `doctor` skill. It should report green across the board (except "no agents configured yet" — that's fine for first run).

## Step 10 — Done

Tell the user:
1. Setup complete. Listener is running on PM2.
2. To create your first agent: ask Claude to `create an agent for <role>`.
3. To check health later: ask Claude to `run doctor`.
4. To update the framework when new versions land: ask Claude to `update the framework`.
5. Add `pm2 startup` to launch on host reboot (optional but recommended).
