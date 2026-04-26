---
name: manage-routines
description: View, add, edit, or disable scheduled routines in an agent's schedules.json. Use when the user says "add routine", "schedule something", "manage routines", "list schedules", "disable routine", "change cron", "change schedule" — anything about an agent's recurring jobs.
---

# Manage Routines

Each agent's recurring routines live in `agents/<n>/schedules.json`. The listener watches that file and reloads schedules automatically — no PM2 restart needed.

Schedules use standard cron syntax: `minute hour day-of-month month day-of-week`. Times are interpreted in the listener-wide `TZ` env var (default UTC).

## Schema

```json
{
  "schedules": [
    {
      "id": "daily-report",
      "cron": "0 9 * * *",
      "message": "Run your daily routine.",
      "description": "Daily 09:00 report",
      "enabled": true
    }
  ]
}
```

`id` is required and must be unique within the agent. `enabled: false` disables without deletion.

## Step 1 — Pick the agent

If the user named the agent, use it. Otherwise list `agents/*/` and ask. Confirm before continuing.

## Step 2 — Decide: list, add, edit, disable, enable, remove?

Default to listing first if intent is unclear. Show the current `schedules.json` contents in a table:

| id | cron | description | enabled |
|---|---|---|---|

Then ask what they want to do.

## Step 3 — Add

Ask:
1. **Cron expression** — accept friendly forms like "every weekday at 9am" and convert. Validate with a quick sanity check (5 fields, ranges valid).
2. **Message** — what the agent should do when the routine fires. This becomes the agent's input prompt at fire time. Be specific.
3. **Description** — one short line for human readers (shows in `pm2 logs`).
4. **id** — suggest a slug derived from the description. Confirm.

Cron tips for the user:
- `0 9 * * *` — every day at 09:00
- `0 9 * * 1-5` — weekdays at 09:00
- `*/15 * * * *` — every 15 minutes
- `0 8 * * 1` — Monday at 08:00

Append to the agent's `schedules.json` using `jq`:
```bash
jq '.schedules += [{...}]' "agents/<n>/schedules.json" > /tmp/s.json && mv /tmp/s.json "agents/<n>/schedules.json"
```

## Step 4 — Edit

Show the existing entry. Ask which field to change. Use `jq` to update in place. Don't change the `id` — if the user wants a different id, treat it as remove + add (otherwise you might orphan running schedule references).

## Step 5 — Disable / enable

Toggle the `enabled` field:
```bash
jq '(.schedules[] | select(.id == "ID").enabled) = false' "agents/<n>/schedules.json" > /tmp/s.json && mv /tmp/s.json "agents/<n>/schedules.json"
```

Disabled schedules stay in the file (safer than removing — preserves the cron expression in case it's wanted again).

## Step 6 — Remove

Confirm first. Then:
```bash
jq 'del(.schedules[] | select(.id == "ID"))' "agents/<n>/schedules.json" > /tmp/s.json && mv /tmp/s.json "agents/<n>/schedules.json"
```

## Step 7 — Verify

The listener auto-reloads. Watch the log to confirm:
```bash
pm2 logs ginnie-agents-listener --lines 10 --nostream | grep "<agent_name>"
```

You should see lines like `[scheduler] <agent>: loaded "<id>" @ <cron> <TZ>` for active entries. If a line is missing, check the user's cron syntax or the watched-file change detection (try touching the file: `touch agents/<n>/schedules.json`).

## Common gotchas

- **Cron in the wrong TZ:** the cron is interpreted in the listener's `TZ` env (default UTC). If the user says "9am their time", make sure the `.env`'s `TZ` matches their local zone.
- **Routines firing during off-hours:** scheduled routines fire regardless of `work_hours` config — that's intentional. If the user wants a routine that only runs during work hours, they need to encode it in the cron expression directly.
- **Duplicate ids:** the listener silently ignores invalid entries; if a routine doesn't fire, look for `[scheduler] <agent>: skipping invalid entry` in the log.
