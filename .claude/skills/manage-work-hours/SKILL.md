---
name: manage-work-hours
description: Configure when an agent responds to inbound user messages — set work hours, days, and off-hours behavior in the agent's config.json. Use when the user says "set work hours", "make agent only respond during business hours", "configure availability", "off hours", or asks how to limit when an agent runs.
---

# Manage Work Hours

`work_hours` in `agents/<n>/config.json` gates inbound user messages. Scheduled routines always fire regardless — work hours only apply to @mentions, DMs, and thread replies from users.

## Schema

```json
{
  "work_hours": {
    "enabled": true,
    "start": "09:00",
    "end": "18:00",
    "days": ["mon", "tue", "wed", "thu", "fri"],
    "off_hours_behavior": "deferred_response"
  }
}
```

- `enabled` — `false` disables enforcement entirely (default for new agents).
- `start` / `end` — `HH:MM` 24h, in the listener's `TZ`. If `end < start`, the window wraps midnight (e.g. `start: "22:00"`, `end: "06:00"` means a night shift).
- `days` — array of day abbreviations: `sun mon tue wed thu fri sat`.
- `off_hours_behavior`:
  - `"ignore"` — silently drop the message; agent does not respond.
  - `"deferred_response"` — post a one-line off-hours notice in the thread; do not run the agent.
  - `"queue"` — same as `deferred_response` in v0.1.0; persistent queue for later replay is a v0.2 concern.

## Step 1 — Pick the agent

If named, use it. Otherwise list `agents/*/` and ask.

## Step 2 — Show current state

```bash
jq .work_hours "agents/<n>/config.json"
```

If null/missing, treat as `enabled: false` (the runner defaults all fields if absent).

## Step 3 — Gather changes

Ask, with current values as defaults:
1. **Enabled?** yes/no
2. If yes:
   - **Start time** — HH:MM in the listener's TZ (`echo $TZ` to remind the user)
   - **End time** — HH:MM
   - **Days** — comma-separated abbreviations, or "weekdays" / "all" / "weekends" as shortcuts
   - **Off-hours behavior** — `ignore` or `deferred_response`

## Step 4 — Validate

- Times parse as HH:MM with valid hours/minutes
- Days are subset of `[sun, mon, tue, wed, thu, fri, sat]`
- `off_hours_behavior` is one of the allowed values

## Step 5 — Write

```bash
jq '.work_hours = {...}' "agents/<n>/config.json" > /tmp/c.json && mv /tmp/c.json "agents/<n>/config.json"
```

Pretty-print on save (use `jq` without `-c`).

## Step 6 — Restart

Work hours are read at agent message time, but the listener caches `config.json` per agent at startup. To pick up changes:

```bash
pm2 restart ginnie-agents-listener --update-env
```

## Step 7 — Verify

Send a test message in the agent's channel during off-hours and confirm the off-hours notice posts (or that the agent stays silent for `ignore`).

If you want to manually verify the time check without waiting:
```bash
TZ=$(grep -E '^TZ=' .env | cut -d= -f2) date '+%a %H:%M'
```
That tells you what day/time the listener thinks it is.

## Common gotchas

- **Wrong TZ:** the framework's `TZ` env (in `.env`) is the source of truth. If the agent's day boundary feels off, check that.
- **"My agent is silent during work hours":** maybe `enabled: false` got flipped, or `days` doesn't include today's abbreviation. Run `jq .work_hours` and read carefully.
- **Wrap-around windows:** if `end < start`, the window is `[start..midnight) ∪ [00:00..end)`. The runner handles this correctly. If you want a single-day window, make sure `start < end`.
- **Schedules vs. work hours:** a routine fires no matter what `work_hours` says. To pause a routine during off-hours, gate it inside the routine's cron expression instead.
