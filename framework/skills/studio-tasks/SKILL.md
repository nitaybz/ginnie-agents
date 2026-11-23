---
name: studio-tasks
description: Open a developer task in Ginnie Studio yourself (Adam, Shai), follow Studio's replies, answer Studio, and tell Nitay what was opened and what Studio did. Use when something in your work needs a code change, a bug fix or a new capability that only a developer can make.
---

# Developer tasks in Studio (Nitay 2026-11-23)

Nitay: Adam and Shai open developer tasks in Ginnie Studio themselves, not through Sally.
The tool is shared and mounted read-only in your container:

```bash
S=/workspace/.framework/skills/studio-tasks/studio.mjs
node $S projects                                    # once: which Studio project owns the code
node $S open --project <slug> --title "<short English title>" --body-file /tmp/task.md --nitay "<one plain Hebrew line>"
node $S check                                       # Studio's new replies (news) for your tasks
node $S reply --id <id> --text "<answer, with facts>"
node $S skip  --id <id>                             # a reply with nothing worth telling
node $S list | pending
```

- The body file: what is wrong or missing, a real example (dates, numbers, what you saw), what done
  looks like. No customer phone numbers or emails, no tokens.
- One task per problem: `open` with the same title again does nothing. Add to an open task with `reply`.
- Tell Nitay once, in plain short Hebrew, what you opened and why, with the link the tool prints.
  Adam: in his private WhatsApp. Shai: `tell` / `ask` (they go to Nitay through Adam).
- Run `check` in your regular rounds. For each news item: Studio asks something you know, `reply`;
  only Nitay knows, ask him in one plain question; progress or done, tell him one plain sentence.

## The key

Each agent has its own Studio access key, and only Nitay creates it (Studio, CLI token, 30 days).
It goes in the agent's own `credentials.json` as `"studio_mcp_token": "<key>"` (on the server:
`~/Projects/Ginnie Repos/ginnie-agents/agents/<agent>/credentials.json`). No restart needed.
No key: the tool exits 3; tell Nitay in one line that the Studio key is missing, then carry on.
