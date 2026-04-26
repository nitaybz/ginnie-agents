---
name: update-framework
description: Pull the latest framework version from upstream, rebuild Docker if needed, rebuild the listener, and restart PM2. Use when the user says "update framework", "update", "pull updates", "upgrade", or asks if there's a new version.
---

# Update Framework

User content (`agents/`, `shared/`, `config/`, `.env`) is never touched by `git pull` because it lives in directories the framework doesn't write to. This skill performs the predictable update sequence safely.

Run from repo root.

## Step 1 — Show what's available

```bash
git fetch
git log HEAD..origin/main --oneline
```

If no new commits, tell the user "Already up to date" and stop.

If commits exist, summarize them (subjects only, max 10 lines) and ask the user to confirm before proceeding. Look for words like `BREAKING:` or `MIGRATION:` in commit messages — flag those prominently.

## Step 2 — Verify clean working tree on framework dirs

```bash
git status --porcelain -- listener/ docker/ framework/ scripts/ templates/ .claude/skills/
```

If output is non-empty, the user has local changes to framework code. Ask: do they want to (a) stash, (b) commit first, or (c) abort? Don't pull on top of dirty framework state — merge conflicts in framework code are confusing.

User content (`agents/`, `shared/`, `config/`, `.env`) appearing in `git status` is fine — the pull won't touch those.

## Step 3 — Pull

```bash
git pull --ff-only origin main
```

If `--ff-only` fails (their main has diverged from origin), surface it. Don't auto-merge; let the user decide.

## Step 4 — Detect what needs rebuilding

```bash
# Compare what changed against the previous HEAD (saved by git pull's reflog)
git diff --name-only HEAD@{1} HEAD
```

Decide:
- `docker/` or `framework/skills/` changed → rebuild image
- `listener/` changed → rebuild listener
- Anything else → skip rebuilds

## Step 5 — Rebuild image (if needed)

```bash
docker build -t ginnie-agent -f docker/Dockerfile .
```

## Step 6 — Rebuild listener (if needed)

```bash
cd listener && npm install && npm run build && cd ..
```

If the changes touched `listener/package.json`, `npm install` is required (not just `ci`).

## Step 7 — Restart PM2

```bash
pm2 restart ecosystem.config.cjs --update-env
```

`--update-env` re-reads the launching shell's env (so a refreshed `CLAUDE_CODE_OAUTH_TOKEN` or `TZ` change takes effect).

## Step 8 — Verify

Invoke the `doctor` skill. Report any new failures. If listener fails to start, surface the last 30 lines of `pm2 logs ginnie-agents-listener --nostream`.

## Step 9 — CHANGELOG hint

Print the relevant `CHANGELOG.md` section for the new version range so the user knows what changed in their framework.
