---
name: slack-report
description: Any Slack report or post that carries numbers (money, counts, rates, dates) goes out as a number card, not a paragraph. A headline with the finding, the numbers as label and value pairs, one line of what it means, an optional small source line. Mounted at /workspace/.framework/skills/slack-report/.
---

# Number reports in Slack: a card, not a paragraph

The reader is a busy operator on a phone. A paragraph with five numbers inside it takes a minute to read
and understand. The same numbers as a card take five seconds. So: **whenever a Slack message carries three or
more numbers, post it as a card with `report.mjs`.** One or two numbers: a short plain sentence is fine.

```
┌──────────────────────────────────────────┐
│ Cash: 12K better than last week          │  title: the finding, with the number that matters
│ Balance           Credit limit           │
│ -40K              80K                    │  fields: label / value pairs, two columns
│ In from customers Out                    │
│ +25K              -6K                    │
│ Invoicing this month is thin, so this    │  note: what it means, what you did, or one question
│ room may not last.                       │
│ Biggest payment in: 15K on 3 Mar         │  context: optional small grey line (source, period)
└──────────────────────────────────────────┘
```

## How to post

Write the spec to a file, then post it (prints the message ts; `--thread <ts>` to answer in a thread):

```bash
export SLACK_BOT_TOKEN=$(jq -r .slack_bot_token ./credentials.json)
cat > /tmp/report.json <<'EOF'
{"title": "Cash: 12K better than last week",
 "fields": [{"label": "Balance", "value": "-40K"}, {"label": "Credit limit", "value": "80K"},
            {"label": "In from customers", "value": "+25K"}, {"label": "Out", "value": "-6K"}],
 "note": "Invoicing this month is thin, so this room may not last.",
 "context": "Biggest payment in: 15K on 3 Mar"}
EOF
node /workspace/.framework/skills/slack-report/report.mjs --channel "$CHANNEL" --spec /tmp/report.json
```

Check it first with `--dry-run` (prints the blocks, posts nothing). An error names what to shorten.

## Writing the card

1. **Title = the finding**, not the topic: "Ad spend up 40% this week", not "Weekly ads report". At most one line.
2. **Fields = the numbers**, at most 10 that matter (20 is the hard limit). Label: 1 to 4 words. Value: the
   number with its unit and sign (`+12%`, `-3K`, `4 of 79`, `₪1,600 a month`). Same unit and rounding for
   numbers the reader compares. Order: the most important first, compared pairs side by side (this week / last).
3. **Note = what it means** for the business, or what you did, or ONE yes/no question saying what happens on
   yes. At most 3 short lines. Never repeat a number that is already a field.
4. **Context** (optional) = where the numbers come from or the period. Small, last.
5. No paragraph after the card, no second message, no "full report below". Details the reader may want go in
   the thread only if your instructions ask for a thread.
6. Plain words: no internal names, ids, file or tool names, as in all your messages. Write in the language your
   instructions use for reports.

Approval buttons (an `actions` block) are a separate message per your own instructions; never mix them into a card.
