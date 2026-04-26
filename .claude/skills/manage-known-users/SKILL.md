---
name: manage-known-users
description: Add, edit, or remove humans and agents from the team directory (shared and per-agent known-users.json). Use when the user says "add user", "add a teammate", "remove user", "edit user", "manage known users", "register a person", or describes someone new on the team.
---

# Manage Known Users

The team directory has two layers, merged at runtime:
- `shared/known-users.json` — visible to all agents (the default)
- `agents/<n>/known-users.json` — visible only to that agent (selective visibility)

Same Slack ID in both → local entry wins for that key only. Otherwise union.

## Schema

```json
{
  "users": {
    "U0XXXXXXXXX": {
      "kind": "human",
      "name": "Full Name",
      "short_name": "First",
      "title": "Founder",
      "role": "founder",
      "email": "person@example.com",
      "responsibilities": "One-line summary of what this person owns",
      "authority": "What instructions from this person count as authoritative",
      "tone": "How agents should address this person"
    }
  }
}
```

For agents, `kind: "agent"` plus `channel: "C0… (#name)"` instead of email.

`role` is freeform but agents key off it. Common values: `founder`, `support-engineer`, `partner`, `customer`, `agent`, `unknown`, `external`, `bot`.

## Step 1 — Decide: add, edit, or remove?

If the user said "add", go to Add. "Remove" / "delete" → Remove. "Edit" / "change" / "update" → Edit. If unclear, ask.

## Step 2 — Resolve the Slack ID

The user almost never knows their teammate's Slack member ID. Help them find it:
1. In Slack, click the person's profile → ⋮ menu → "Copy member ID" (starts with `U`).
2. Paste it here.

If the user can't find the ID and you have any agent's `slack_bot_token` available, you can search:
```bash
curl -s -X POST https://slack.com/api/users.list \
  -H "Authorization: Bearer $TOKEN" | jq -r '.members[] | select(.profile.real_name | test("<name>"; "i")) | "\(.id) \(.profile.real_name) \(.profile.email // "no email")"'
```

Don't proceed without a confirmed Slack ID.

## Step 3 (Add) — Visibility tree

ONE question, with three options:

> Should this person be visible to **(a) all agents**, **(b) specific agents only**, or **(c) no agents** (you're just registering them in shared but they shouldn't appear in any team directory)?

Only follow up if (b): "Which agents?" — list available agent names from the `agents/` directory.

## Step 4 (Add) — Gather fields

For humans: `name`, `short_name`, `title`, `role`, `email`, `responsibilities`, `authority`, `tone`.

For other agents: `name`, `short_name`, `title`, `role: "agent"`, `channel`, `responsibilities`, `authority`.

Don't ask for everything in one big question; offer reasonable defaults based on context. Confirm the assembled record before writing.

## Step 5 (Add) — Write to the right file(s)

- Visibility (a) → write to `shared/known-users.json`
- Visibility (b) → write to each chosen `agents/<n>/known-users.json` (create the file if missing). Do NOT also write to shared.
- Visibility (c) → write to `shared/known-users.json` but tell the user nothing renders this until at least one agent's local file references it.

Use `jq` to merge into existing files without losing other entries. Pretty-print on save.

## Step 6 (Add) — Create per-agent file if needed

When writing to `agents/<n>/known-users.json` for the first time:
```json
{ "users": {} }
```

Then merge in the new entry.

## Step 7 (Edit) — Find the entry

Show all matches across `shared/` and per-agent files. Ask which one to edit. Re-prompt for fields with current values as defaults.

## Step 8 (Remove) — Find and confirm

```bash
grep -l "U0XXXXXXXXX" shared/known-users.json agents/*/known-users.json
```

Confirm with the user before removing — multiple agents may reference this person.

## Step 9 — Restart listener

`shared/known-users.json` is loaded at listener startup; per-agent files are read on demand and cached. To pick up changes immediately:

```bash
pm2 restart ginnie-agents-listener --update-env
```

Tell the user the change is live.

## Notes

- The `kind` field drives whether the entry shows up under "Humans" or "Agents" in the rendered team directory.
- Don't leak personal info (phone, address) into known-users — keep entries professional.
- For agents, the `bot_user_id` (from `agents/<n>/slack.json`) IS the Slack ID to use as the key.
