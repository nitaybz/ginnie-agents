# ginnie-agents

> Open-source framework for building autonomous multi-agent Slack teams on Claude Code + Max.

**v0.1.0** — feature-complete pending dogfood validation on a fresh clone. See [CHANGELOG](CHANGELOG.md) for what's in this release.

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

## Quickstart

```bash
git clone https://github.com/nitaybz/ginnie-agents
cd ginnie-agents
```

Open the directory in Claude Code and ask: **"set me up"**. The `setup` skill walks through:
- `claude setup-token` for a 1-year OAuth token
- Timezone and `.env` scaffolding
- Git hook installation (memory cap enforcement)
- Docker image build
- Listener build + PM2 start

When that's done, ask Claude to **"create an agent for &lt;role&gt;"** and the `create-agent` skill takes you through Slack app creation, SOUL writing, schedule, boundaries, and registration end-to-end.

To check health later: **"doctor"**. To pull framework updates: **"update the framework"**.

## What's in v0.1.0

**Runtime:**
- Multi-app Slack Socket Mode listener (one Bolt app per agent, separate identities)
- Scheduler with per-agent `schedules.json` and live file watching
- Docker container isolation per agent
- Three-tier memory model (rules / playbook / episodes) with git-hook enforcement
- `merge=union` git attribute on memory paths to prevent silent merge loss
- Auto-injected team directory + per-message sender identity resolution
- SOUL.md auto-injection between team directory and operational layer
- Known-users shared ∪ local merge with selective agent visibility
- Boundaries (read-only / write) enforced at the SDK layer
- Work hours config with off-hours behaviors (ignore / deferred_response)

**Skills (`.claude/skills/`):**
- `setup` — first-run guided setup
- `create-agent` — full agent scaffolding flow
- `update-framework` — pull updates and rebuild
- `doctor` — health check
- `manage-known-users` — add/edit/remove humans and agents with visibility tree
- `manage-routines` — view/add/edit/disable schedules
- `manage-work-hours` — set work hours and off-hours behavior
- `logs` — tail / search / download
- `create-maintenance-agent` — scaffold a self-monitoring agent

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [CHANGELOG.md](CHANGELOG.md) for the release notes.

## License

[MIT](LICENSE) — Copyright (c) 2026 Nitay Ben Zvi
