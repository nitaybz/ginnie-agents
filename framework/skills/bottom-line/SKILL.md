---
name: bottom-line
description: Every routine that ends with a material finding posts a 2-4 line summary to one shared Slack channel, with the details in a thread under it. Loaded automatically when the operator sets BOTTOM_LINE_CHANNEL.
---

# Bottom Line: one short post per routine that found something

The operator reads one channel to know what every agent found: `{{BOTTOM_LINE_CHANNEL}}`.
This applies only to turns started by a routine (`[ROUTINE: <id>]`). It does not apply to live
conversations, and it does not replace any report your PROMPT asks you to post elsewhere.

## When to post

Post only when the routine produced a **material finding**: something the operator would want
to know or act on (a change in a key number, a problem, a decision needed, an action you took).
If nothing material happened, post nothing here. Never post "all clear", "nothing new" or
"routine complete". Memory consolidation and other silent routines never post.

At most **one** bottom-line post per routine run.

## The shape

A top-level message in `{{BOTTOM_LINE_CHANNEL}}`, **2-4 lines**, plain words, no tables, no buttons:

```
[<your name>] <YYYY-MM-DD> <routine id>
<the finding, with the one number that matters>
<optional: why it matters, or what you did>
<optional: what you need from a human, or "no action needed">
```

Then put the details (numbers, lists, evidence, links) in **one reply in the thread** of that
post. If the routine already posted a full report elsewhere, the thread reply can be a link to
it plus anything not in it. Write in the language your PROMPT and rules use for reports.

## How to post

```bash
export SLACK_BOT_TOKEN=$(jq -r .slack_bot_token ./credentials.json)
CH="{{BOTTOM_LINE_CHANNEL}}"
TS=$(curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json; charset=utf-8" \
  -d "$(jq -n --arg c "$CH" --arg t "$SUMMARY" '{channel:$c, text:$t}')" | jq -r .ts)
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json; charset=utf-8" \
  -d "$(jq -n --arg c "$CH" --arg ts "$TS" --arg t "$DETAILS" '{channel:$c, thread_ts:$ts, text:$t}')"
```

If the post fails (for example `not_in_channel`), do not retry in a loop. Note it in your
episode log and carry on; the routine's own work still counts.
