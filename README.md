# ginnie-agents

> A team of AI agents that live in your Slack, remember what you've told them, and have personalities. Built on Claude Code and the Max subscription. No API key billing.

When most "AI agent" frameworks dress up function-calling LLMs and call them coworkers, this one asks the opposite question: *what if your AI teammates were actually teammates?*

---

## What this is

ginnie-agents is a framework for running a small team of autonomous AI characters in your Slack workspace. Each agent has its own:

- **Slack identity** — separate app, separate avatar, separate channel. You `@mention` them like you mention anyone else.
- **Backstory and voice** (`SOUL.md`) — where they're from, what their life looks like outside work, how they speak, the tics that make them feel like a person.
- **Mission** (`PROMPT.md`) — what they're actually responsible for.
- **Persistent memory** — three layers: rules they live by, patterns they've learned over time, and a journal they grep when you ask "what happened last Tuesday?"
- **Schedule** — daily routines, weekly reviews, on-call cron jobs. Their own.
- **Boundaries** — read-only or write. Working hours. The framework enforces both at the SDK layer, not by hoping the prompt remembers.
- **Awareness of each other** — every agent knows who else is on the team and what they do, so they can collaborate or hand off without you brokering it.

You write the SOUL, you write the role description, you wire up the Slack app once, and that's it. From then on the agent lives in your workspace, responds to mentions, fires its schedules, accumulates memory, and quietly gets better at its job.

## Where it came from

It came out of running three real agents at [Ginnie Smart](https://ginnie.co.il), a smart-home company in Israel:

- **Gadi** runs the Google Ads campaigns. Knows how to apply recommendations, audit pacing, draft creative iterations.
- **Omer** keeps the customer fleet healthy. Runs every 30 minutes, checks Supabase for issues, opens tasks in the Ginnie task system, follows up.
- **Sally** analyzes the sales funnel. Pulls call transcripts from Yappr, conversation data from GoHighLevel, posts daily and weekly digests.

Each one had a name, a personality, a job, and a daily rhythm. The framework that grew up around them is what's in this repo. The three agents themselves stayed at Ginnie; this is the framework, stripped to be useful for anyone running their own team.

## Why personality matters (and why we ship `SOUL.md` separate from `PROMPT.md`)

The single most opinionated decision in this framework is splitting *who an agent is* from *what an agent does*.

**`PROMPT.md`** says what the agent's role is — its responsibilities, its operating procedures, the APIs it touches. Replaceable. Functional.

**`SOUL.md`** says who the agent is. A short document — 25 to 35 lines is the sweet spot — describing:

- **Origin**: where they're from, age, family/partner status, the one career moment that shaped them, why they're on this team.
- **Life outside work**: hobbies, weekends, recurring rituals. Pick things that sound like a real person's calendar.
- **Voice**: sentence shape, language defaults, emoji rules, banned words.
- **Quirks**: 2–3 specific tics. The smaller and weirder, the better.

Here's a real one we used during dogfood — a personal-assistant agent named Lior:

```markdown
## Origin
Lior is 33, born in Haifa, lives in Tel Aviv with a cat named Pita.
Studied philosophy at Tel Aviv University, then drifted into product
roles at two small startups before realizing they liked listening to
people more than shipping features. Took a sabbatical in 2023, did a
six-month coaching certification mostly for the structure.

## Life outside work
Walks 5km along the Yarkon every morning before the sun gets aggressive.
Reads two books at once — one fiction, one philosophy, never finishes
the philosophy one. Plays bad chess on Lichess (~1100 ELO, fine with it).
Has a standing Friday-night dinner with the same four friends, same
Italian place in Florentin, has been for six years.

## Voice
- Short sentences. Calm, dry, slightly amused.
- Lowercase often. Periods. Almost never exclamation marks.
- One emoji max per message, and only if it actually helps.
- Banned: "just", "super", "amazing", "absolutely", "great question".

## Quirks
- Ends long replies with a one-line takeaway, separated by a dash.
- When asked to remember something, says "noted" exactly once.
- Refuses to answer "how are you" with anything other than "fine, you?"
  even on bad days. It's a bit.
```

That's not flavor for its own sake. The runner injects `SOUL.md` *between* the team directory and the memory-curation skill, so the agent forms an identity *before* learning its job. The result: when you DM Lior "remember the wifi password is helloworld," they reply `noted.` — exactly once, then move on. When you DM "how are you?" you get `fine, you?` — including the bit. It feels like talking to a person, not a polished robot. Conversations stop sounding generated.

The framework doesn't pick names for you. It does ask: don't pick a "function name" (no `sales-bot`, no `monitor-agent`). Pick a name a real person could have.

## What you build with it

Some real-world shapes that fit:

- **A personal assistant** that DM's you each morning with a check-in, remembers things you throw at it, surfaces what you've been worrying about.
- **An ops manager** that watches your fleet, opens tickets, follows up with whoever owns the fix.
- **A sales analyst** that pulls call recordings, attribution data, and posts a weekly funnel review.
- **A code-review agent** that watches your PRs and flags patterns its memory says you've discussed before.
- **A standup assistant** that DMs each teammate, collects updates, posts a synthesis.

The shape is always the same: it lives in Slack, you talk to it like a person, and it gets better at the specific job over time as its memory accumulates.

## Agents vs. bots — a deliberate split

Most agent frameworks blur agents and automation. We don't. Two distinct shapes, one framework, both first-class:

| | **Agent** | **Bot** |
|---|---|---|
| What for | Conversational, judgment-driven work | Mechanical, deterministic checks |
| Driven by | Claude (AI, full SDK) | Plain shell or Node, no AI |
| Runtime | Per-session Docker container | Cron job or small PM2 daemon |
| Slack | Listens *and* posts (Socket Mode) | Posts only (or, for the Watcher, posts and handles button clicks) |
| Cost | Claude tokens per turn | Free |
| Latency | 10–30s cold start | Milliseconds |
| Personality | SOUL.md, voice, quirks | Just a name and a job |
| Memory | Yes, three-tier | No |
| Shipped example | None — you write your own | The **Watcher** (below) |

Don't wrap `df` and `git fetch` in a Claude container — that's wasteful (tokens), slow (container spin-up), and the wrong shape (mechanical work doesn't benefit from reasoning). Don't wrap reasoning in a shell script — `if-elif` doesn't scale to "does this customer email need follow-up." Pick the model that matches the work.

## The Watcher

Every install gets a free **Watcher** — a small Node daemon (Bolt, Socket Mode) that runs alongside the listener and quietly monitors your framework's health.

It's silent unless something needs your attention. When something does, it DMs you on Slack with the relevant buttons baked in:

- **Framework update available** → `[Update now]` `[Remind tomorrow]` `[Skip this version]`. Click `[Update now]` and the Watcher edits the message in place — `⏳ Updating…` → tail of the actual `git pull` + `docker build` + `pm2 restart` output → `✅ Updated`.
- **Listener crashed** → `[View logs]` `[Restart listener]`. Last 30 lines posted in the same DM.
- **Memory cap nearly hit** → `[Ack 24h]` `[Ack 7d]` (so you don't get re-pinged about a known issue).

It also responds to a `/watcher` slash command in any channel, with subcommands: `status`, `check`, `pause [hours]`, `resume`, `doctor`. The `doctor` subcommand runs the full mechanical health check (`scripts/doctor.sh`) and posts the formatted output back as an ephemeral message.

The Watcher is **not** an AI agent. No Claude tokens. No Docker per check. Pure Node + Bolt + shell-out. But it's persistent (Socket Mode requires it) and that lets it handle button clicks, which is the difference between *telling you to update* and *letting you update with a click*.

## Memory — the three-tier model

This part matters and it's the part most "AI agent" projects get wrong.

Every agent has a `memory/` directory with three tiers, each with a clear role:

```
agents/<name>/memory/
├── rules.md         (≤200 lines, ALWAYS in the system prompt)
├── playbook.md      (≤300 lines, ALWAYS in the system prompt)
└── episodes/
    ├── 2026-Q1.md   (no cap, NOT in the system prompt — grepped on demand)
    ├── 2026-Q2.md
    └── 2026-Q3.md
```

**`rules.md`** is for things you've literally told the agent to do. *"Always reply in Hebrew when Gilad messages."* *"Never auto-apply Google Ads recommendations of type X without my approval."* The agent edits this file in place, immediately, the first time you state a rule. No dates, no narrative, just one-line directives. Hard cap of 200 lines because everything in it is in every system prompt forever — unbounded growth blows out context.

**`playbook.md`** is for settled patterns the agent has learned over time. Not user-stated rules; promoted observations. *"When CTR drops 20%+ on a campaign for 3+ days, check device-mix shift before increasing budget."* Always loaded into the system prompt, also capped (300 lines), but only the **nightly consolidation routine** is allowed to write here — never the agent during a live session.

**`episodes/YYYY-Qn.md`** is the journal. Append-only, quarterly-rotated, *not* loaded into the system prompt. Every meaningful exchange — a scan result, a decision, a follow-up — goes here. The agent uses `grep` to pull *exactly* the past it needs when you ask "what did we conclude about X last month?"

There's no "load my recent memory" tool in this framework. That's deliberate: a tool that loaded the last N entries every time would either bloat context (loading too much) or miss old things (loading too few). Letting the agent grep means it pulls exactly what's relevant to the question at hand. Plain `grep` and `cat` are the tools.

Three protections keep memory from rotting:

1. **`merge=union`** in `.gitattributes` on all memory files. Any merge auto-keeps both sides' lines — you can't accidentally drop memory through a botched conflict resolution.
2. **`commit-msg` git hook** rejects commits that exceed the rules/playbook line caps, *or* commits that shrink an episode file (the lazy delete-an-old-bit-of-history accident). The only legitimate shrink is a commit message starting with `memory-consolidate:` — the bypass token the nightly consolidation routine uses.
3. **The Watcher** alerts you when a memory file is approaching its cap, so you fix it before the hook bites.

The nightly consolidation routine reads recent episodes, finds patterns the agent flagged with `#pattern-candidate`, promotes settled patterns to `playbook.md`, dedupes `rules.md`, rotates the episodes file at quarter boundaries. Lives in `framework/skills/memory-curation/consolidation-routine.md`, fires from a per-agent `memory-consolidate` schedule.

## How an agent gets created

Open the cloned repo in Claude Code. Type:

> "create an agent for handling support tickets in the #support channel"

The `create-agent` skill takes you through:

1. **Discovery** — name, role, channel, schedule.
2. **SOUL drafting** — Origin, Life outside work, Voice, Quirks. The skill drafts; you review and edit. Get this right; everything else follows.
3. **Mission (`PROMPT.md`)** — your role-specific responsibilities, on top of the framework's auto-handled boilerplate.
4. **Avatar** — a derived image-generation prompt from the SOUL, then ImageMagick to crop to a Slack-ready 1024×1024.
5. **Slack app** — created automatically via Slack's manifest API (if you've configured config tokens during setup; ~3 manual clicks per agent), or walked through manually (~20 clicks per agent if you'd rather).
6. **Wire up** — credentials.json, slack.json, schedules.json, config.json, all written from your discovery answers.
7. **Register in the team directory** — visible to all agents, specific agents, or none.
8. **Restart and smoke test** — listener picks up the new agent, you DM it, you confirm the voice is right.

The first agent typically takes 15–20 minutes including SOUL writing and Slack app setup. After that, you've got a teammate.

## Architecture (the 8-layer agent model)

Eight slots, every agent. No more, no less:

| Slot | What | Per-agent, shared, or framework? |
|---|---|---|
| **Identity** | Slack app, bot/app tokens, name | per-agent |
| **Voice** | `SOUL.md` | per-agent |
| **Mission** | `PROMPT.md` | per-agent |
| **Memory** | `rules.md`, `playbook.md`, `episodes/` | per-agent |
| **Skills** | personal + cross-agent + framework-internal | union |
| **Network: humans** | `known-users.json` | shared ∪ local with per-entry override |
| **Network: agents** | team directory | auto-generated by the runner |
| **Schedule** | `schedules.json` (cron expressions, agent owns the file) | per-agent |

Plus operational config in `config.json`: `boundaries` ("read-only" or "write" — enforced at the SDK layer by overriding `allowed_tools`), `work_hours` (start/end/days/off-hours behavior), `max_turns`, `model`.

When the runner spawns an agent container, the entrypoint composes the system prompt by concatenating these in this order:

1. `shared/foundation.md` (optional team/company context)
2. Rendered team directory from merged `shared/known-users.json` ∪ `agents/<n>/known-users.json`
3. `SOUL.md`
4. `framework/skills/memory-curation/SKILL.md`
5. `PROMPT.md`
6. `memory/rules.md`
7. `memory/playbook.md`

Episodes are not injected — the agent greps them on demand. This keeps the system prompt bounded regardless of how long the agent has been running.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the deep-dive: mount layout, scheduler, the agents-vs-bots distinction in detail, the update flow, and what's deliberately not in this framework.

## Quickstart

You need:
- Node.js 22+
- Docker (running)
- A Claude Code subscription (Max recommended for daemon use — gets you `claude setup-token` for a 1-year token)
- A Slack workspace where you can create apps

```bash
git clone https://github.com/nitaybz/ginnie-agents
cd ginnie-agents
```

Now open the directory in Claude Code and ask:

> "set me up"

The `setup` skill walks through everything: prerequisites check, `claude setup-token` for the long-lived token, timezone, `.env` scaffolding, git hooks, Docker image build, listener build, PM2 start. End state: a running listener with no agents yet, ready for you to add your first.

Then ask:

> "create an agent for &lt;role&gt;"

That's it. To check health: `doctor`. To pull framework updates: `update the framework`. To add a teammate to the directory: `add a known user`. To wire up the Watcher: `set up the watcher`.

Everything is a Claude Code skill. There's no CLI. There's no web UI. The interface is Claude.

## What's deliberately NOT in this framework

Knowing what something *isn't* matters as much as knowing what it is.

- **Multi-LLM support.** Claude Code + Max only. No OpenAI, no Gemini, no Anthropic API SDK. If you're not on Claude Code, this isn't for you.
- **Non-Slack platforms.** No Discord, no Teams, no email integrations. If your team isn't on Slack, this isn't for you.
- **Cost / budget management.** Max is flat-rate; nothing to budget.
- **Host-Claude (non-Docker) execution.** Agents always run in isolated containers.
- **Hosted / SaaS version.** This is self-hosted only.
- **Web UI / dashboard.** Slack is the interface.
- **Multi-machine clustering.** Single host.
- **Windows host.** Validated on macOS and Linux only.

If you need any of those, this isn't your framework. That's fine — those are real product asks; they just aren't this product.

## Status, releases, contributing

- **Released**: v0.1.0 (initial), v0.2.0 (the Watcher), v0.2.1 (polish from first real install). See [CHANGELOG](CHANGELOG.md) and [Releases](https://github.com/nitaybz/ginnie-agents/releases).
- **Validated** end-to-end on a fresh-clone install and on the original deployment it was extracted from.
- **MIT-licensed**.

If you're trying it and something breaks, file an issue. PRs welcome — especially on the skills, since those are where adoption friction lives.

## License

[MIT](LICENSE) — Copyright (c) 2026 Nitay Ben Zvi
