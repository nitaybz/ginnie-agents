---
name: doctor
description: Health check for ginnie-agents — verifies prerequisites, environment, hooks, listener, Docker image, agents, memory caps, and disk. Use when the user says "doctor", "health check", "check setup", "is everything ok", or after running setup/update.
---

# Doctor — Health Check

Run all checks, collect results, then print one consolidated report. Don't bail on the first failure — always report everything.

For each check, output one of:
- `✓ <check>` — passed
- `✗ <check>: <what's wrong> → <how to fix>` — failed

## Prerequisites

```bash
node --version           # need v22+
docker --version
docker info >/dev/null   # daemon running
git --version
which pm2
```

## Environment

Check that `.env` exists at the repo root and contains:
- `CLAUDE_CODE_OAUTH_TOKEN` — non-empty (don't print the value; only confirm presence)
- `TZ` — set, valid (test by running `TZ=$TZ date` and checking it doesn't error)

If `CLAUDE_CODE_OAUTH_TOKEN` is missing, point user at `claude setup-token` (this is the most common failure).

## Git hooks

```bash
git config --get core.hooksPath  # should print "scripts/hooks"
test -x scripts/hooks/commit-msg
```

If `core.hooksPath` is unset, run `bash scripts/hooks/install.sh`.

## Docker image

```bash
docker images --format '{{.Repository}}' | grep -q '^ginnie-agent$'
```

If missing, suggest: `docker build -t ginnie-agent -f docker/Dockerfile .`

## Listener

```bash
pm2 jlist | jq -r '.[] | select(.name=="ginnie-agents-listener") | .pm2_env.status'
# Should print "online"
pm2 logs ginnie-agents-listener --lines 5 --nostream
# Should NOT contain "FATAL" or repeated "Container exited with code"
```

If not online, `pm2 start ecosystem.config.cjs --update-env`.

## Agents

For each `agents/<n>/` directory:
- `PROMPT.md` exists
- `SOUL.md` exists
- `credentials.json` exists with `slack_bot_token` and `slack_app_token` set (don't print values)
- `slack.json` has `bot_user_id`, `bot_id`, and `channel.id` set
- `config.json` parses as JSON
- `memory/rules.md` and `memory/playbook.md` exist (zero-byte is fine)

Report per-agent. Missing optional fields warn rather than fail.

## Memory caps

For each agent, check current line counts:
```bash
wc -l agents/*/memory/rules.md         # each should be ≤200
wc -l agents/*/memory/playbook.md      # each should be ≤300
```

If any are within 10 lines of the cap, warn that consolidation is overdue.

## Token expiry hint

If you can introspect `CLAUDE_CODE_OAUTH_TOKEN` expiry, do it. Otherwise: report token presence only and tell the user the token expires ~1 year from generation. Recommend running `claude setup-token` annually (the maintenance agent, if installed, alerts 30 days before expiry).

## Disk space

```bash
df -h .
```

Warn if <10% free on the filesystem holding the repo.

## Slack reachability (optional)

For each agent with `slack_bot_token`, do an `auth.test`:
```bash
curl -s -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer <token>" | jq -r '.ok, .error'
```

If `ok: false`, the token is revoked or invalid → tell user to regenerate in the Slack app's OAuth & Permissions page and update `agents/<n>/credentials.json`.

## Final report

Print a one-line summary: `<N> checks passed, <M> failed, <K> warnings`. List failures and warnings in priority order (env > hooks > listener > agents > memory > disk > slack).
