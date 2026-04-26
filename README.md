# ginnie-agents

> Open-source framework for building autonomous multi-agent Slack teams on Claude Code + Max.

⚠️ **Pre-release (v0.1.0 in progress).** Core framework code is functional and identical to the internal deployment it was extracted from, but the user-facing setup skills are not yet written. See [Status](#status) below.

## What it is

A framework for running a team of autonomous AI agents that:

- Live in **Slack** (one Slack app per agent — separate identity, channel, role)
- Run in **isolated Docker containers** via the Claude Agent SDK
- Authenticate with your **Claude Code Max subscription** (no API key billing)
- Maintain **persistent three-tier memory** (rules, playbook, episodes) with hard caps and append-only enforcement
- Have a **soul** — every agent has a `SOUL.md` defining backstory, voice, and quirks separate from job description
- Know about each other — the runner auto-injects a **team directory** so agents can tag and collaborate
- Self-manage **schedules** — each agent owns its own `schedules.json` for cron-style routines

## Architecture (8-layer agent model)

| Layer | What | Sharing |
|---|---|---|
| Identity | name, Slack app, bot/app tokens | per-agent |
| Voice | `SOUL.md` | per-agent |
| Mission | `PROMPT.md` | per-agent |
| Memory | `rules.md` / `playbook.md` / `episodes/*.md` | per-agent |
| Skills | personal + shared + framework | union |
| Network: humans | `known-users.json` | shared ∪ local |
| Network: agents | team directory | runner-injected |
| Schedule | `schedules.json` | per-agent |

## Repo layout

```
.
├── listener/              # Node.js process: one @slack/bolt app per agent, scheduler, runner
├── docker/                # Dockerfile + entrypoint for agent containers
├── framework/skills/      # Framework-internal skills auto-mounted (memory-curation, etc.)
├── scripts/hooks/         # Git hooks (memory cap + append-only enforcement)
├── templates/agent/       # Scaffold for new agents
├── .claude/skills/        # Claude Code interface skills (setup, create-agent, etc.) — coming
├── agents/                # YOUR agents go here (gitignored except .gitkeep)
├── shared/skills/         # YOUR cross-agent skills
├── shared/known-users.json # YOUR team directory
├── config/                # YOUR config files (gitignored)
└── .env                   # YOUR secrets (gitignored)
```

## Requirements

- Node.js 22+
- Docker
- A Claude Code subscription (Max recommended for daemon use — get a 1-year token via `claude setup-token`)
- A Slack workspace where you can create apps

## Status

What works today:
- ✅ Listener with multi-app Slack Socket Mode
- ✅ Scheduler reading per-agent `schedules.json`
- ✅ Three-tier memory model with git-hook enforcement
- ✅ Docker isolation per agent
- ✅ Auto-injected team directory + sender identity resolution
- ✅ SOUL.md auto-injection

What's not done yet (tracked toward v0.1.0):
- ⏳ `setup` skill — guided first-run setup
- ⏳ `create-agent` skill — scaffold a new agent end-to-end
- ⏳ `update-framework` / `doctor` / `manage-known-users` / `manage-routines` / `manage-work-hours` / `logs` skills
- ⏳ `create-maintenance-agent` template
- ⏳ Selective agent visibility (shared∪local known-users merge)
- ⏳ Boundaries enforcement (read-only / write declarations in `config.json`)
- ⏳ ARCHITECTURE.md
- ⏳ Worked examples in README

Until the setup skill ships, see the internal Ginnie deployment for a reference setup.

## License

[MIT](LICENSE) — Copyright (c) 2026 Nitay Ben Zvi
