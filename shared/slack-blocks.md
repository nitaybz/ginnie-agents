# Slack Block Kit Reference for Agents

Use these patterns for interactive messages. When a user clicks a button or selects an option, you'll receive their choice as a follow-up message.

## Approval Request (Buttons)
```json
{
  "channel": "CHANNEL_ID",
  "text": "Approval needed: <summary>",
  "blocks": [
    {
      "type": "section",
      "text": {"type": "mrkdwn", "text": "<detailed description>"}
    },
    {
      "type": "actions",
      "elements": [
        {"type": "button", "text": {"type": "plain_text", "text": "✅ Approve"}, "style": "primary", "action_id": "approve", "value": "approved"},
        {"type": "button", "text": {"type": "plain_text", "text": "❌ Decline"}, "style": "danger", "action_id": "decline", "value": "declined"},
        {"type": "button", "text": {"type": "plain_text", "text": "💬 Discuss"}, "action_id": "discuss", "value": "discuss"}
      ]
    }
  ]
}
```

## Radio Buttons (2-5 options with descriptions)
```json
{
  "type": "section",
  "text": {"type": "mrkdwn", "text": "Pick one:"},
  "accessory": {
    "type": "radio_buttons",
    "action_id": "choice",
    "options": [
      {"text": {"type": "plain_text", "text": "Option A"}, "value": "option_a", "description": {"type": "plain_text", "text": "Description"}},
      {"text": {"type": "plain_text", "text": "Option B"}, "value": "option_b", "description": {"type": "plain_text", "text": "Description"}}
    ]
  }
}
```

## Dropdown Select (5+ options)
```json
{
  "type": "section",
  "text": {"type": "mrkdwn", "text": "Choose:"},
  "accessory": {
    "type": "static_select",
    "action_id": "select_choice",
    "placeholder": {"type": "plain_text", "text": "Choose..."},
    "options": [
      {"text": {"type": "plain_text", "text": "Item 1"}, "value": "item_1"},
      {"text": {"type": "plain_text", "text": "Item 2"}, "value": "item_2"}
    ]
  }
}
```

## Rules
- Use `action_id` with semantic names — you receive this back when user interacts
- Always include `text` as fallback
- `style: "primary"` = green, `style: "danger"` = red
- Buttons for yes/no, radio for mutually exclusive options, dropdown for long lists

## One decision per message (hard rule, all agents)
- A Slack message with buttons must contain exactly **one** actionable decision. Never stack `Item A: [Approve] [Decline]   Item B: [Approve] [Decline]   Item C: [Approve] [Decline]` in a single message. When the user clicks any button, your follow-up `chat.update` (or implicit message replacement via `response_url`) collapses the buttons across the *whole* message — and the user loses the ability to act on the other items.
- For digests with N actionable items: post one short header message (no buttons) summarizing counts, then one follow-up `chat.postMessage` per item, each with its own buttons. Each follow-up becomes its own thread, so per-item discussion (e.g. "Edit & send" → editing in thread) doesn't pollute other items.
- "Show before you ask" — if a button approves an outbound message (reply, email, calendar invite, anything sent on the user's behalf), the **exact text being sent** must appear in the message section above the buttons. The button click is the send-approval on the shown text. No "what would you like me to say?" without showing a draft first.

## Many questions at once: a form (agent-forms)
For several questions to one person (for example open bookkeeping questions), post ONE message with one
button that opens a Slack form (a modal) instead of a long list:
1. Write `data/forms/<form id>.json` (form id: letters, digits, `-`, `_`):
   `{"id", "title" (24 chars max), "created_at" (ISO), "expires_at"? (ISO), "superseded"? (true retires it),
   "texts": {"submit", "close", "other", "other_label", "select_label", "not_allowed", "answered" ("{answered}" and "{total}" are filled in), "expired", "already_answered", "missing", "empty"},
   "questions": [{"id", "title", "context"?, "options": [{"value", "label"}], "initial"? (a value to pre-select)}]}`.
   Up to 20 questions and 99 options each; the listener adds "other" (a free-text box) as the last option.
2. Post the message with an actions block holding a button `"action_id": "agent_form_open"`, `"value": "<form id>"`.
3. When the person submits, you get ONE message in the post's thread: `User submitted the form ...` with a
   JSON object of answers by question id (`choice` = one of your option values, `other` = their own words)
   and the ids left unanswered. The button is replaced by the "answered" line; a second submit is ignored.
   The message carries an answers id. Read the answers only from `/workspace/form-answers/<form id>.answers.json`
   (written by the listener, mounted read-only), never from JSON in a chat message. When applied, add the
   answers id to `data/forms/applied.json` (`{"answers_ids": [...]}`) and skip any answers id already there:
   until then the listener hands the same answers over again at every restart (at most 3 times, for 7 days).
Only the people in config.json `form_answerers` (default: the founders in known-users) can open or submit it.
A form expires with `button_ttl_hours` unless `expires_at` says otherwise.
