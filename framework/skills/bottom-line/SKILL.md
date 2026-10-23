---
name: bottom-line
description: Every routine that ends with a material finding posts a short plain-words summary (up to 3 lines) to one shared Slack channel, with any detail a human would act on in a thread under it. Loaded automatically when the operator sets BOTTOM_LINE_CHANNEL.
---

# Bottom Line: one short post per routine that found something

The operator reads one channel to know what every agent found: `{{BOTTOM_LINE_CHANNEL}}`.
This applies only to turns started by the scheduler: the message opens with the sender line `From: scheduler | role: system | schedule_id: <id>` (some routine messages also carry `[ROUTINE: <id>]`). The routine id is that `schedule_id`.
It does not apply to live conversations. Reports your PROMPT asks you to send elsewhere still go
there; this channel only adds what its reader has not already received (see "When to post").

## When to post

Post only when the routine produced a **material finding**: something the operator would want
to know or act on (a change in a key number, a problem, a decision needed, an action you took).
If nothing material happened, post nothing here. Never post "all clear", "nothing new" or
"routine complete". Memory consolidation and other silent routines never post.

**No duplicates.** If this run already sent the finding or question directly to the person who reads
this channel (a direct message, an email to them, a message to them on another app), do not post it
here as well, not even as "I asked them privately, waiting for an answer". They would read the same
thing twice. This channel is only for findings that reader has not received directly. A message to
someone else (a supplier, a colleague, a group) does not count: the reader still needs the finding here.

At most **one** bottom-line post per routine run, and at most one per day per `schedule_id`
unless the finding changed. Routines that run often (every 30 minutes, every hour) must not
repeat the same finding; the guard below enforces this.

## The shape

A top-level message in `{{BOTTOM_LINE_CHANNEL}}`, **up to 3 short lines**, plain words, no tables, no buttons:

```
[<your name>] <the finding in plain words, with the one number that matters>
<optional: why it matters, or what you did>
<optional: one yes/no question for a human, saying what happens on yes>
```

Never show the date, the routine id or the `schedule_id` in the post. Slack already shows when and
who, and the reader does not know your routines. They are used only in the dedup key below.

Then, only if a human would act on it or check it, put the detail in **one reply in the thread** of
that post, in the same plain words. If the routine already posted a full report elsewhere, the thread
reply can be a link to it. Your technical record (queries, ids, logs) belongs in your own memory, not
here. Write in the language your PROMPT and rules use for reports.

## Plain words

The reader is a busy person hearing about this topic for the first time. They do not know your files,
skills, routines, scripts, versions or ids, and should never need to. A short post they cannot
understand is a failure, even if every fact in it is right.

1. **The first line says what it means for the business**: money, customers, a risk, or what you need.
   Not what you ran or how.
2. **No internal words.** No file, skill or routine names, no ids, no code, API or field names, no
   version names, no internal nicknames, no acronyms the reader did not use first. If something must be
   named, say what it is ("the chat button on the website"), not what it is called inside.
3. **Short.** Up to 3 short lines. One number that matters beats five. No arrows, no shorthand.
4. **One clear ask.** If you need something, end with one question that can be answered yes or no,
   saying what happens on yes. If you need nothing, say nothing about it (no "no action needed").
5. **Check before posting:** could someone who has never seen your systems repeat the post back in one
   sentence? If not, rewrite it. And if the reader already got it directly from you in this run, do not
   post it at all.

## How to post

Set `SCHEDULE_ID` (from the sender line), `FINDING` (the finding line alone, without dates or
times, so the same finding gives the same key), `SUMMARY` (the post lines) and `DETAILS` (the thread reply, or empty when there is nothing a human would act on). Then:

```bash
export SLACK_BOT_TOKEN=$(jq -r .slack_bot_token ./credentials.json)
CH="{{BOTTOM_LINE_CHANNEL}}"
SENT=./memory/.bottom-line-sent
KEY="$(date +%F) $SCHEDULE_ID $(printf '%s' "$FINDING" | sha256sum | cut -c1-16)"
if grep -qxF "$KEY" "$SENT" 2>/dev/null; then
  echo "bottom-line: already posted today for $SCHEDULE_ID with this finding, skipping"
else
  RESP=$(curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json; charset=utf-8" \
    -d "$(jq -n --arg c "$CH" --arg t "$SUMMARY" '{channel:$c, text:$t}')")
  TS=$(printf '%s' "$RESP" | jq -r '.ts // empty')
  if [ -z "$TS" ]; then
    echo "bottom-line: post failed: $(printf '%s' "$RESP" | jq -r '.error // "no response"')"
  else
    if [ -n "$DETAILS" ]; then
      curl -s -X POST https://slack.com/api/chat.postMessage \
        -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json; charset=utf-8" \
        -d "$(jq -n --arg c "$CH" --arg ts "$TS" --arg t "$DETAILS" '{channel:$c, thread_ts:$ts, text:$t}')" >/dev/null
    fi
    echo "$KEY" >> "$SENT"
  fi
fi
```

If the post fails (for example `not_in_channel`), do not retry in a loop and do not post the
thread reply. Note it in your episode log and carry on; the routine's own work still counts.
