# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-04-26

The Watcher.

### Added

- **Watcher** — long-running framework watchdog daemon (`listener/src/watcher.ts`). Bolt + Socket Mode, no AI, no Claude tokens. Runs alongside the listener as a second PM2 process (`ginnie-agents-watcher`).
  - Periodic checks (default hourly): token age, framework update available on `origin/main`, PM2 listener health, disk usage, per-agent memory caps.
  - DMs the operator only when something fires. 24h cooldown per alert key. Acks/skips persist in `data/watcher-state.json`.
  - **Interactive buttons** on actionable alerts:
    - Framework update → `[Update now]` `[Remind tomorrow]` `[Skip this version]`. `[Update now]` shells out to `scripts/update-framework.sh`, streams progress as message edits.
    - Listener errored → `[View logs]` `[Restart listener]`
    - Memory cap → `[Ack 24h]` `[Ack 7d]`
  - **`/watcher` slash command** with subcommands: `help`, `status`, `check`, `pause [hours]`, `resume`, `doctor`.
- `scripts/update-framework.sh` — deterministic update flow (git pull → conditional docker rebuild → conditional listener rebuild → pm2 restart → doctor). Used by the Watcher's `[Update now]` button and runnable manually.
- `templates/watcher-slack-manifest.json` — canonical manifest for the Watcher's Slack app (Socket Mode, interactivity, `/watcher` slash command, `chat:write` + `im:write` + `users:read` + `commands` scopes).
- `setup-watcher` skill — replaces `setup-maintenance-bot`. Walks user through manifest-based Slack app creation, captures bot+app tokens, writes `WATCHER_BOT_TOKEN` / `WATCHER_APP_TOKEN` / `OPERATOR_SLACK_ID` to `.env`.

### Changed

- `ecosystem.config.cjs` — second PM2 app entry `ginnie-agents-watcher` (script `dist/watcher.js`).
- README + ARCHITECTURE — Watcher replaces the maintenance bot as the canonical bot example. Pattern: bots are deterministic + non-AI, but they can be small Bolt daemons when interactivity matters.

### Removed

- `scripts/maintenance.sh` — the v0.1.0 cron-based maintenance bot. Never publicly used; removed clean rather than deprecated.
- `.claude/skills/setup-maintenance-bot/` — replaced by `setup-watcher/`.

[0.2.0]: https://github.com/nitaybz/ginnie-agents/releases/tag/v0.2.0

## [0.1.0] — 2026-04-26

Initial public release. Validated end-to-end via fresh-clone dogfood: setup → create-agent → live Slack DM round-trip with SOUL voice intact + memory written to episodes.

### Added

- Framework extracted from internal deployment.
- Three-tier memory model with `commit-msg` hook enforcement (rules ≤200 lines, playbook ≤300 lines, episodes append-only).
- `merge=union` git attribute on memory paths to prevent silent merge loss.
- Per-agent Slack apps via multi-app `@slack/bolt` Socket Mode.
- Auto-injected team directory rendered from `shared/known-users.json`.
- `SOUL.md` auto-injection between team directory and operational layer.
- Docker isolation per agent with read-only framework/shared mounts.
- `framework/skills/` directory for framework-internal skills auto-mounted into every agent.
- `templates/agent/` scaffold with `PROMPT.md`, `SOUL.md`, memory tiers, schedules, Slack config.
- Known-users **shared ∪ local merge** with per-entry override (selective agent visibility). Per-agent `agents/<n>/known-users.json` is mounted into the container, merged with `shared/known-users.json` by the entrypoint, and used by the listener for sender identity resolution.
- **Boundaries** as a first-class `config.json` field. `"boundaries": "read-only"` restricts the agent's `allowed_tools` to a read-only allowlist (`Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`) at SDK level — `Bash`, `Write`, and `Edit` are blocked regardless of what the prompt says.
- **Work hours** as a first-class `config.json` field. `enabled`/`start`/`end`/`days`/`off_hours_behavior`. Inbound user messages outside work hours are either silently dropped (`ignore`) or get an off-hours notice (`deferred_response` / `queue`). Scheduled routines fire regardless.
- `ARCHITECTURE.md` documenting the 8-layer agent model, system prompt composition, mount layout, memory enforcement, and update flow.
- Nine framework skills under `.claude/skills/`:
  - `setup` — first-run guided setup
  - `create-agent` — full agent scaffolding flow
  - `update-framework` — pull updates, rebuild, restart
  - `doctor` — health check across prerequisites, env, hooks, listener, agents, memory caps, disk
  - `manage-known-users` — add/edit/remove humans and agents with visibility tree question
  - `manage-routines` — view/add/edit/disable schedules
  - `manage-work-hours` — set work hours and off-hours behavior
  - `logs` — tail/search/download listener and per-agent logs
  - `setup-maintenance-bot` — wire up the optional script-based maintenance bot. Replaces the original `create-maintenance-agent` skill, which wrapped purely-mechanical checks (`df`, `git fetch`, `wc -l`) in a full Claude Agent SDK container per scan. The bot is now `scripts/maintenance.sh` — runs via cron or PM2 cron-restart, deterministic, free, and fast. Same checks (token expiry, framework updates, listener health, disk, memory caps) as before, plus a 24h-per-key cooldown system to keep Slack quiet. ARCHITECTURE.md formalizes the agent-vs-bot distinction.

### Changed

- `prompt.md` → `PROMPT.md` (uppercase, matches `SOUL.md` as identity files).
- `memory-curation` skill moved from `shared/skills/` to `framework/skills/` (framework-managed, not user-editable).
- Default timezone changed from a hardcoded zone to `UTC`. Override via `TZ` env var.
- Auth flow: `CLAUDE_CODE_OAUTH_TOKEN` (1-year token from `claude setup-token`) is now the recommended path over mounting host `~/.claude/.credentials.json` (8h OAuth, non-refreshable in container).
- `getSenderInfo()` now takes an optional agent context to resolve sender identity from the merged shared ∪ local known-users.

### Removed

- All agents from the internal deployment.
- Internal business context (`shared/foundation.md`, `shared/known-users.json` contents, internal task-board skill, internal CRM-reference skill).
- Hardcoded host paths and private network IPs.

[Unreleased]: https://github.com/nitaybz/ginnie-agents/compare/HEAD...HEAD
[0.1.0]: https://github.com/nitaybz/ginnie-agents/releases/tag/v0.1.0
