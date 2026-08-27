---
name: manage-work-hours
description: Record an agent's intended availability window in config.json for documentation purposes, and steer users toward the real control (each routine's cron in schedules.json) for actually limiting when an agent speaks. Use when the user says "set work hours", "make agent only respond during business hours", "configure availability", "off hours", or asks how to limit when an agent runs.
---

# Manage Work Hours

**`work_hours` does not gate inbound messages.** Anyone can @mention, DM, or reply to an agent at any hour, on any day, and it will answer. This was a deliberate framework decision, not a bug: work hours only ever existed to stop an agent from *proactively* starting a conversation outside its expected hours, and that is already handled by each routine's own cron schedule in `agents/<n>/schedules.json` — not by this config block.

In practice, `work_hours` and `off_hours_behavior` are informational only. Nothing in the listener reads them to decide whether to respond. Set them if you want a documented record of the agent's intended hours, but do not expect them to change runtime behavior.

If what the user actually wants is "stop this agent from doing anything outside business hours," the real lever is the `manage-routines` skill: constrain or disable the routine's cron expression so it only fires in the desired window. Inbound @mentions/DMs will still be answered 24/7 regardless — there is currently no way to suppress those.

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

- `enabled`, `start`, `end`, `days` — record the agent's intended availability window. `HH:MM` 24h, in the listener's `TZ`. Purely documentation; not enforced.
- `off_hours_behavior` — legacy field, kept only so existing agents' `config.json` keeps loading. Setting it to `"ignore"`, `"deferred_response"`, or `"queue"` has no effect on inbound message handling.

## Step 1 — Pick the agent

If named, use it. Otherwise list `agents/*/` and ask.

## Step 2 — Show current state

```bash
jq .work_hours "agents/<n>/config.json"
```

If null/missing, treat as unset.

## Step 3 — Gather changes

Before writing anything, tell the user plainly: this only records intended hours for reference; it will not stop the agent from responding outside them. If they want actual off-hours silence for a routine, point them at `manage-routines` instead.

If they still want to set/update the record, ask, with current values as defaults:
1. **Enabled?** yes/no
2. If yes:
   - **Start time** — HH:MM in the listener's TZ (`echo $TZ` to remind the user)
   - **End time** — HH:MM
   - **Days** — comma-separated abbreviations, or "weekdays" / "all" / "weekends" as shortcuts

## Step 4 — Validate

- Times parse as HH:MM with valid hours/minutes
- Days are subset of `[sun, mon, tue, wed, thu, fri, sat]`

## Step 5 — Write

```bash
jq '.work_hours = {...}' "agents/<n>/config.json" > /tmp/c.json && mv /tmp/c.json "agents/<n>/config.json"
```

Pretty-print on save (use `jq` without `-c`).

## Step 6 — Restart

The listener caches `config.json` per agent at startup. To pick up the change:

```bash
pm2 restart ginnie-agents-listener --update-env
```

There is nothing to functionally verify afterward — the change is a documentation record, not a behavior switch. Don't send a test message expecting off-hours silence; the agent will respond regardless.

If you want to check what time the listener thinks it is (e.g. to sanity-check the `TZ` used in the record):
```bash
TZ=$(grep -E '^TZ=' .env | cut -d= -f2) date '+%a %H:%M'
```

## Common gotchas

- **"I set `off_hours_behavior: ignore` but the agent still answers at 2am":** expected. `work_hours` and `off_hours_behavior` are not enforced on inbound messages. There is no config that silences an agent's replies outside certain hours.
- **Wrong TZ:** the framework's `TZ` env (in `.env`) is the source of truth for the recorded window.
- **Schedules vs. work hours:** a routine fires exactly when its own cron in `schedules.json` says, regardless of `work_hours`. To limit when a routine runs, edit its cron expression via `manage-routines` — that is the only real lever for time-based behavior.
