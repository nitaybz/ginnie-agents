# Memory Consolidation Routine (nightly cron only)

This file is **not** auto-injected into the session. It is loaded on-demand by the nightly `memory-consolidate` cron via `cat /workspace/.framework/skills/memory-curation/consolidation-routine.md`.

Live sessions do not need it — they follow the runtime discipline in `SKILL.md`. Consolidation happens once a day, single-threaded, and is the only legitimate path for memory to shrink or for `playbook.md` to grow.

## When this runs

The user's `memory-consolidate` schedule fires it (typically overnight in the container's timezone). If you were invoked by that schedule, proceed. If not — stop and read `SKILL.md` instead.

## The commit message rule

Every commit this routine makes **must** start with `memory-consolidate:` — that's the bypass token the git commit-msg hook looks for to allow the intentional shrinks (episode promotion, playbook distillation, rules dedup).

If a commit does not start with that prefix, the hook rejects it, and the shrink fails. This is working as designed.

## Phases (run in order)

### Phase 1 — Promote pattern candidates

1. Grep the current-quarter episode file for lines tagged `#pattern-candidate`:
   ```bash
   Q="$(date '+%Y')-Q$(( ( $(date '+%-m') - 1 ) / 3 + 1 ))"
   grep -n -B2 -A6 '#pattern-candidate' ./memory/episodes/$Q.md
   ```
2. For each candidate, count distinct episodes in which it (or a near-equivalent) was observed.
3. If a candidate appears in **≥3 distinct episodes**, write a one-line entry to `playbook.md` under the most relevant section header.
4. After promotion, the candidate tags stay in episodes (episodes are append-only history). Do not edit past entries to remove the tag.

### Phase 2 — Dedupe and distill playbook

If `playbook.md` is **over 250 lines** (approaching the 300 cap):

1. Read the full file.
2. Merge near-duplicate lines under the most specific section header.
3. Collapse related bullets (e.g. "CPU oscillates" + "Memory oscillates" → one bullet "CPU/Memory alerts oscillate; close only after ≥1 healthy cycle").
4. Write the replacement. Never drop information — merge it.

### Phase 3 — Dedupe rules

If `rules.md` is **over 150 lines** (approaching the 200 cap):

1. Merge compatible rules ("always X unless Y" + "in case Z do X" → one combined rule).
2. Drop rules that were explicitly superseded by newer rules.
3. Keep the *why* fragments — they're how future-you judges edge cases.

### Phase 4 — Quarterly rotation

If **today is the first day of a new quarter** (Jan 1 / Apr 1 / Jul 1 / Oct 1):

1. Create `./memory/episodes/<new-YYYY-Qn>.md` with a single header line.
2. The previous quarter's file stays in place — still searchable via grep, just no longer the active append target.

### Phase 5 — Commit

```bash
git add ./memory/rules.md ./memory/playbook.md ./memory/episodes/
git -c user.email="<agent>@ginnie-agents.local" -c user.name="<agent>" commit -m "memory-consolidate: <agent> <date> — <N promoted, X merged, Y rules distilled>"
```

Stage only what you changed. If nothing changed (no promotions, no over-cap, no new quarter), commit NOTHING — exit silently. The hook doesn't care about empty runs; a skipped commit is a healthy signal that there was nothing to distill.

## Invariants to preserve

- **Episodes are append-only.** Past entries are immutable history. Corrections are new entries, never rewrites.
- **Playbook lines are short and general.** A playbook line describes a pattern that applies to many situations. Specific one-off observations belong in episodes.
- **Rules are user-stated.** Do not invent rules from observations — rules come from the user. Observations that hold across sessions become playbook entries, not rules.
- **No information loss.** Merging and distilling compresses noise, not signal. Before shrinking a section, re-read it carefully — if you cannot summarize a line into the merged version, keep it.
- **Silent.** Consolidation never posts to Slack. The only output is the commit.
