---
name: logs
description: Tail, search, or download logs for the listener and individual agents. Use when the user says "show logs", "tail logs", "what did agent X do", "search logs for X", "download logs", or is debugging agent behavior.
---

# Logs

Two log surfaces:
- **Listener logs** — what the framework process did. PM2 manages these.
- **Agent logs** — per-agent run output. Written to `agents/<n>/logs/` when invoking `run.sh`. Live container output is captured by PM2's listener log when the runner spawns a container.

## Step 1 — Decide what the user actually wants

Common asks:
- "Why did the agent not respond to me at 3pm?" → listener logs filtered by agent + timeframe
- "Show me what the agent thought during the morning routine" → agent's recent run log
- "Search for errors" → grep across listener log
- "Download today's logs" → file dump

Ask if unclear. Default to: `pm2 logs ginnie-agents-listener --lines 50 --nostream` if user just says "show logs".

## Step 2 — Listener tail

```bash
pm2 logs ginnie-agents-listener --lines 100 --nostream
```

Filter by agent name:
```bash
pm2 logs ginnie-agents-listener --lines 500 --nostream | grep -E '\[<agent_name>\]'
```

Filter by time (last N minutes):
```bash
pm2 logs ginnie-agents-listener --lines 1000 --nostream | awk -v cutoff="$(date -v-30M '+%Y-%m-%d %H:%M' 2>/dev/null || date -d '30 minutes ago' '+%Y-%m-%d %H:%M')" '$0 >= cutoff'
```

`-v-30M` is macOS BSD `date`; the GNU fallback is `date -d '30 minutes ago'`.

## Step 3 — Agent run logs

Agents that use the manual `run.sh` wrapper produce dated files:
```bash
ls -lt agents/<n>/logs/
cat agents/<n>/logs/$(date +%Y-%m-%d).log
```

For agents triggered through Slack (the typical path), look at PM2 logs filtered by the agent name — the agent's stderr is streamed there.

## Step 4 — Search

```bash
# Across listener
pm2 logs ginnie-agents-listener --lines 5000 --nostream | grep -iE '<pattern>'

# Across agent run logs
grep -rinE '<pattern>' agents/*/logs/ | head -50
```

For multi-line patterns or structured search, dump to a file first:
```bash
pm2 logs ginnie-agents-listener --lines 10000 --nostream > /tmp/listener.log
```

## Step 5 — Download

User wants to share logs (with you, with someone else)?

```bash
# Listener last 24h
pm2 logs ginnie-agents-listener --lines 50000 --nostream > /tmp/listener-$(date +%Y%m%d).log

# Specific agent's run logs
tar -czf /tmp/<agent>-logs-$(date +%Y%m%d).tar.gz agents/<agent>/logs/
```

Tell the user the file path and approximate size. Do not paste sensitive content (Slack tokens, API keys) in the chat — review before sharing.

## Step 6 — Common diagnostics

| Symptom | Where to look |
|---|---|
| Agent didn't respond to a Slack message | Listener log around the message timestamp; look for `[@mention]` or `[DM]` lines for that agent |
| Container exited with non-zero code | Listener log line `Container exited with code <N>` — preceding lines show stderr from the container |
| Routine didn't fire | Listener log at expected fire time — look for `[scheduler] <agent>: firing "<id>"` |
| Off-hours notice fired unexpectedly | Listener log: `off-hours: ignoring inbound message`. Then check `jq .work_hours agents/<n>/config.json` |
| Auth failure | Listener log near startup: `start failed: not_authed` or `invalid_auth` → token in `agents/<n>/credentials.json` is bad; regenerate from Slack app's OAuth & Permissions page |
| Memory hook rejected commit | Output of last commit attempt; usually `rules.md exceeds 200 lines` or `episodes/X.md is shrinking` |

## Step 7 — Cleanup

PM2 logs grow unbounded by default. To rotate:
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 14
```

Per-agent run logs in `agents/<n>/logs/` are gitignored but never auto-truncated. Suggest the user rotate them periodically:
```bash
find agents/*/logs -name '*.log' -mtime +30 -delete
```
