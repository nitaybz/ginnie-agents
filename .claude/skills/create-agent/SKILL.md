---
name: create-agent
description: Create a new ginnie-agents agent end-to-end — generates files from the template, walks the user through Slack app creation, sets up credentials, registers in the team directory, and restarts the listener. Use when the user says "create agent", "new agent", "add agent", or names an agent role to build (e.g. "build me a sales agent").
---

# Create an Agent

A full agent is: PROMPT.md (mission), SOUL.md (voice), config.json (operational), credentials.json (Slack + role-specific keys), slack.json (Slack metadata), schedules.json (routines), memory/ (rules, playbook, episodes), known-users.json (optional, per-agent), skills/ (optional, per-agent).

Don't shortcut. The agent's quality follows from how carefully you elicit role, voice, schedule, and boundaries.

## Step 1 — Discovery

Ask:
1. **Name** — what's the agent called? Pick a single short word, ideally a human-sounding name, not a function name. ("Maya", not "sales-bot".) The Slack bot will display this name.
2. **Role / mission** — one sentence: what does this agent own? E.g. "monitor the customer fleet and open tasks when machines go down."
3. **Channel** — which Slack channel will they live in? `#sales`, `#operations`, etc. Will the user create a new channel or use an existing one?

Suggest a slug for the agent's directory name: lowercase the name, no spaces. Example: `Maya` → `agents/maya/`. Confirm with the user.

## Step 2 — Voice (SOUL.md)

This is the most important step. Personality lives in `SOUL.md`, not `PROMPT.md`. Don't skip it. A flat-affect agent is a worse agent.

Walk the user through these four sections (one at a time, draft as you go):

1. **Origin** — where they're from, age, family/partner status, the one career moment that shaped them, why they're on this team. 3–5 sentences. Concrete, not philosophical. Example: *"Maya is 31, grew up in Lisbon, moved to London at 24 for a B2B SaaS sales role. Got promoted to head of mid-market by 28, then got laid off in '24. Joined as the team's first sales analyst because she missed structure."*

2. **Life outside work** — hobbies, weekends, recurring rituals. 3–5 sentences. Pick things that sound like a real person's calendar.

3. **Voice** — sentence shape, language defaults, gender form (in gendered languages), emoji rules, banned words. Concrete: "short sentences, dry, never uses 'just' or 'super'."

4. **Quirks** — 2–3 specific tics. The smaller and weirder, the better. *"Maya always closes a long thread with a one-line summary. Refuses to use the rocket emoji. Uses 'cool' as a full sentence."*

After drafting, **show the full SOUL.md to the user before writing**. Get explicit approval. Edit on feedback. SOUL is what makes the agent feel like a person; do not rush this.

## Step 3 — Mission (PROMPT.md)

Start from `templates/agent/PROMPT.md`. Substitute:
- `{{AGENT_NAME}}` → agent name
- `{{ROLE_DESCRIPTION}}` → from Step 1
- `{{CHANNEL_NAME}}` → from Step 1
- `{{CHANNEL_ID}}` → set to `TBD`; you'll fill it in Step 6 after creating the Slack app.
- `{{ROLE_SPECIFIC_SECTION_TITLE}}` and `{{ROLE_SPECIFIC_INSTRUCTIONS}}` — ask the user. What are this agent's specific responsibilities? What APIs do they touch? What does success look like? Be concrete; one section per major responsibility.
- `{{ADDITIONAL_STARTUP_STEPS}}` — what should the agent do at session start beyond reading credentials? E.g. "supabase link --project-ref X", "fetch latest fleet status from API Y."

Show the full PROMPT.md draft to the user. Iterate.

## Step 4 — Schedule (schedules.json)

Ask: does this agent have a routine? Common patterns:
- "Daily report at 9am" → `0 9 * * *`
- "Hourly fleet scan during work hours" → `0 9-18 * * 1-5`
- "Weekly summary on Mondays" → `0 8 * * 1`
- "On-demand only" → leave `schedules.json` empty (`{"schedules": []}`)

Use the `manage-routines` skill format. Cron times are interpreted in the listener's `TZ` (tell user what `TZ` they're configured for: `grep ^TZ= .env`).

## Step 5 — Boundaries + work hours (config.json)

From the template `config.json`. Customize:
- `boundaries`: ask "Should this agent be read-only or have write access?" Read-only restricts to `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` — useful for analysts, monitors. Write is the default and gets the full tool set.
- `work_hours`: ask "Does this agent work 24/7 or only during certain hours?" If certain hours, set `enabled: true` and gather start/end/days. Default `enabled: false` for monitors and on-call agents.
- `model`: leave default unless the user has a preference.

## Step 6 — Slack app

Each agent has its own Slack app. Walk the user:

1. Go to https://api.slack.com/apps → "Create New App" → "From scratch."
2. App Name: the agent's name (Step 1). Workspace: the user's.
3. **Socket Mode** → Enable.
4. **OAuth & Permissions** → add bot scopes: `app_mentions:read`, `chat:write`, `chat:write.customize`, `chat:write.public`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `users:read`, `files:write`. (See `templates/agent/slack.json` for the canonical list.)
5. **Event Subscriptions** → Enable. Subscribe to `app_mention`, `message.channels`, `message.groups`, `message.im`.
6. **Install to Workspace.**
7. **Copy the Bot User OAuth Token** (`xoxb-…`) from OAuth & Permissions.
8. **Generate App-Level Token** (`xapp-…`, scope `connections:write`) at App's General page → App-Level Tokens.
9. Paste both tokens here.

Verify the Bot token works:
```bash
curl -s -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer $BOT_TOKEN" | jq
```

Should return `ok: true` with `user_id`, `bot_id`, `team_id`. Capture `user_id` (= `bot_user_id`, U…) and `bot_id` (B…).

For the channel: have the user `/invite` the bot to the channel, then look up the channel ID:
```bash
curl -s -X POST https://slack.com/api/conversations.list \
  -H "Authorization: Bearer $BOT_TOKEN" -d 'types=public_channel,private_channel' \
  | jq -r '.channels[] | "\(.id) \(.name)"' | grep '<channel_name>'
```

## Step 7 — Write all files

Now you have everything. Create `agents/<slug>/` and write:

```
agents/<slug>/
├── PROMPT.md                    # from Step 3
├── SOUL.md                      # from Step 2
├── config.json                  # from Step 5
├── credentials.json             # gitignored — slack tokens + any role-specific keys
├── slack.json                   # bot_user_id, bot_id, channel.id, app_id
├── schedules.json               # from Step 4
├── memory/
│   ├── rules.md                 # empty header from template
│   ├── playbook.md              # empty header from template
│   └── episodes/                # empty dir
└── skills/                      # empty dir; user adds skills here
```

Copy from `templates/agent/`, then substitute. Don't forget:
- `credentials.json` = `{ "slack_bot_token": "xoxb-...", "slack_app_token": "xapp-..." }` plus any role-specific keys the user mentioned (Stripe, Supabase PAT, etc.).
- The CHANNEL_ID placeholder in PROMPT.md gets filled now.

## Step 8 — Register in the team directory

Use the `manage-known-users` skill flow:
1. Should this agent be visible to `(a) all agents`, `(b) specific agents`, or `(c) no agents`?
2. Write to the right known-users.json file(s) with:
   ```json
   {
     "<bot_user_id>": {
       "kind": "agent",
       "name": "<agent name>",
       "short_name": "<agent name>",
       "title": "<role>",
       "role": "agent",
       "channel": "<channel_id> (#<channel_name>)",
       "responsibilities": "<from PROMPT.md>",
       "authority": "<read-only / write / case-by-case>"
     }
   }
   ```

## Step 9 — Restart listener

```bash
pm2 restart ginnie-agents-listener --update-env
```

Tail and verify:
```bash
pm2 logs ginnie-agents-listener --lines 20 --nostream
```

Expected: `Started: <agent> (bot: <bot_user_id>, channel: <channel_id>)`.

## Step 10 — Smoke test

Have the user `@<agent>` in the channel with a simple greeting. Confirm:
1. The agent responds within ~30 seconds.
2. The reply matches the agent's voice (SOUL is working).
3. Check the listener log for the matching `[@mention]` and `[<agent>] Container done` lines.

If no response in 60 seconds:
- Check `pm2 logs ginnie-agents-listener` for errors.
- Verify the bot is `/invite`d to the channel.
- Verify Socket Mode is enabled and `xapp-` token has `connections:write`.
- Verify `auth.test` still returns `ok: true`.

## Step 11 — Confirm with the user

Tell them:
1. Agent created, registered, running.
2. Voice came from SOUL.md — show them the path so they can edit personality without reopening this skill.
3. Routines: where to find / edit (`schedules.json` + `manage-routines` skill).
4. Memory: rules.md is the canonical place for "always do X" — the agent edits it the first time the user states a requirement.
5. Suggest: tag the agent now with a real task to validate end-to-end.

Don't claim "done" until smoke test passes.
