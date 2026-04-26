# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Framework extracted from internal Ginnie deployment.
- Three-tier memory model with `commit-msg` hook enforcement (rules ≤200 lines, playbook ≤300 lines, episodes append-only).
- `merge=union` git attribute on memory paths to prevent silent merge loss.
- Per-agent Slack apps via multi-app `@slack/bolt` Socket Mode.
- Auto-injected team directory rendered from `shared/known-users.json`.
- `SOUL.md` auto-injection between team directory and operational layer.
- Docker isolation per agent with read-only framework/shared mounts.
- `framework/skills/` directory for framework-internal skills auto-mounted into every agent.
- `templates/agent/` scaffold with `PROMPT.md`, `SOUL.md`, memory tiers, schedules, slack config.

### Changed

- `prompt.md` → `PROMPT.md` (uppercase, matches `SOUL.md` as identity files).
- `memory-curation` skill moved from `shared/skills/` to `framework/skills/` (framework-managed, not user-editable).
- Default timezone changed from `Asia/Jerusalem` to `UTC`. Override via `TZ` env var.
- Auth flow: `CLAUDE_CODE_OAUTH_TOKEN` (1-year token from `claude setup-token`) is now the recommended path over mounting host `~/.claude/.credentials.json` (8h OAuth, non-refreshable in container).

### Removed

- All agents from the internal deployment.
- Internal business context (`shared/foundation.md`, `shared/known-users.json` contents, internal task-board skill, internal CRM-reference skill).
- Hardcoded host paths and private network IPs.
- `create-agent` skill — pending rewrite as part of v0.1.0 framework skills suite.

[Unreleased]: https://github.com/nitaybz/ginnie-agents/compare/HEAD...HEAD
