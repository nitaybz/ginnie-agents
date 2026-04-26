---
name: memory-curation
description: Runtime memory-writing discipline for ginnie-agents. Three tiers — rules (always loaded), playbook (always loaded), episodes (lazy-loaded via grep). The nightly consolidation procedure lives in a separate file and is only loaded by the consolidation cron, not by every session.
---

# Memory Curation — Runtime Discipline

Your rules and playbook are **already in your system prompt** (injected by the entrypoint). You do not cat them. Episodes live on disk; grep them on demand.

## The three tiers

| File | Loaded | Contents | Writer |
|------|--------|----------|--------|
| `./memory/rules.md` (≤200 lines, hard cap) | **Always** | User-stated rules | Agent edits in place, immediately, on first hearing |
| `./memory/playbook.md` (≤300 lines, hard cap) | **Always** | Settled patterns | Nightly consolidation cron only |
| `./memory/episodes/YYYY-Qn.md` | **Lazy** — grep on demand | Raw journal | Agent appends during sessions |

## Writing discipline

**When the user states a requirement, correction, or preference:**
Edit `./memory/rules.md` immediately. One line. Edit-in-place — if a similar rule exists, amend it; do not append a duplicate. Include a compact *why* so future-you can judge edge cases. No dates. No narrative.

Good: `- All reports in English only. (operator, permanent.)`
Bad: `- 2026-04-19 11:00: operator said English today ...`

**When something happens during a session** (scan result, action, observation, follow-up):
Append to the current quarter's episode file.

```bash
Q="$(date '+%Y')-Q$(( ( $(date '+%-m') - 1 ) / 3 + 1 ))"
NOW=$(date '+%Y-%m-%d %H:%M %Z')
cat >> ./memory/episodes/$Q.md << EP

---
## $NOW — <short topic>
<what happened in 3–10 lines>
EP
```

Tag observations you think might be patterns with `#pattern-candidate` — the nightly consolidation routine promotes them.

**Never** write to `playbook.md` during a live session — that's the cron's job.
**Never** edit past episode entries — episodes are append-only. Add a correction as a new entry.
**Never** recreate `memory.md`, `decisions.md`, or `lessons_learned.md`.

## Reading discipline

- Rules and playbook are in your system context. Don't cat them.
- For history, `grep` the current quarter's episode file:

```bash
grep -n -B1 -A4 'daniel-goldberg' ./memory/episodes/2026-Q2.md | head -60
```

## Hard limits

- `rules.md` > 200 lines → git commit-msg hook rejects.
- `playbook.md` > 300 lines → rejected.
- `episodes/*.md` shrinking → rejected unless commit message starts with `memory-consolidate:`.

## Consolidation (nightly cron only)

If you ARE the nightly `memory-consolidate` cron session, the full consolidation procedure lives at `/workspace/.shared/skills/memory-curation/consolidation-routine.md`. `cat` that file and follow it. Live sessions do not need it.
