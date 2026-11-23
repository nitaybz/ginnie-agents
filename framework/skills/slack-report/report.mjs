#!/usr/bin/env node
// Slack number report: a card instead of a paragraph (see SKILL.md). No dependencies (Node 18+).
//   node report.mjs --channel <id> --spec <file.json> [--thread <ts>] [--dry-run]
// spec: { "title": "...", "fields": [{"label": "...", "value": "..."}], "note": "...", "context": "..." }
// Prints the posted message's ts. Token: $SLACK_BOT_TOKEN.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIMITS = { title: 150, label: 40, value: 60, fields: 20, perSection: 10, note: 400, noteLines: 3, context: 200 };

// Data never becomes a mention, a link or formatting: strip Slack's control syntax.
const safe = (s) => String(s).replace(/[<>]/g, "").replace(/[*_~`]/g, "").trim();
// Note and context keep *bold* and _italic_, but never a mention or a link.
const noLinks = (s) => String(s).replace(/[<>]/g, "").trim();

export function buildMessage(spec) {
	const s = spec || {};
	const title = typeof s.title === "string" ? s.title.trim() : "";
	if (!title || title.length > LIMITS.title) throw new Error(`title is required, at most ${LIMITS.title} characters`);
	const fields = s.fields || [];
	if (!Array.isArray(fields) || fields.length > LIMITS.fields) throw new Error(`at most ${LIMITS.fields} numbers in one report; keep the ones that matter`);
	for (const f of fields) {
		if (!f || typeof f.label !== "string" || !f.label.trim() || f.label.length > LIMITS.label) throw new Error(`each field needs a label of at most ${LIMITS.label} characters`);
		if (f.value == null || String(f.value).trim() === "" || String(f.value).length > LIMITS.value) throw new Error(`each value is a short number or phrase, at most ${LIMITS.value} characters`);
	}
	const note = typeof s.note === "string" ? noLinks(s.note) : "";
	if (note.length > LIMITS.note || note.split("\n").length > LIMITS.noteLines) throw new Error(`note: at most ${LIMITS.noteLines} short lines (${LIMITS.note} characters)`);
	const context = typeof s.context === "string" ? noLinks(s.context).slice(0, LIMITS.context) : "";

	const blocks = [{ type: "header", text: { type: "plain_text", text: title, emoji: true } }];
	for (let i = 0; i < fields.length; i += LIMITS.perSection) {
		blocks.push({ type: "section", fields: fields.slice(i, i + LIMITS.perSection).map((f) => ({ type: "mrkdwn", text: `*${safe(f.label)}*\n${safe(f.value)}` })) });
	}
	if (note) blocks.push({ type: "section", text: { type: "mrkdwn", text: note } });
	if (context) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: context }] });
	const text = [noLinks(title), ...fields.map((f) => `${noLinks(f.label)}: ${noLinks(f.value)}`), note].filter(Boolean).join("\n");
	return { text, blocks };
}

export async function postReport({ channel, thread, spec, token, fetchImpl = fetch }) {
	if (!channel) throw new Error("--channel is required");
	if (!token) throw new Error("no SLACK_BOT_TOKEN");
	const msg = buildMessage(spec);
	const res = await fetchImpl("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({ channel, ...(thread ? { thread_ts: String(thread) } : {}), ...msg }),
		signal: AbortSignal.timeout(20000),
	});
	const data = await res.json();
	if (!data.ok) throw new Error(`Slack refused: ${data.error || "unknown"}`);
	return { ts: data.ts };
}

async function main() {
	const args = process.argv.slice(2);
	const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
	const specFile = opt("--spec");
	if (!specFile) { console.error("usage: report.mjs --channel <id> --spec <file.json> [--thread <ts>] [--dry-run]"); return 2; }
	const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
	if (args.includes("--dry-run")) { console.log(JSON.stringify(buildMessage(spec), null, 2)); return 0; }
	const { ts } = await postReport({ channel: opt("--channel"), thread: opt("--thread"), spec, token: process.env.SLACK_BOT_TOKEN });
	console.log(ts);
	return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
