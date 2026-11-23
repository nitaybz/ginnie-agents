// Run: node --test framework/skills/slack-report/
// A report with numbers is a card the reader scans in seconds: a headline, the numbers as label/value
// fields, one line of meaning. Not a paragraph with the numbers buried in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMessage, postReport } from "./report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEC = {
	title: "Cash: 12K better than last week",
	fields: [
		{ label: "Balance", value: "-40K" },
		{ label: "Credit limit", value: "80K" },
		{ label: "In from customers", value: "+25K" },
		{ label: "Out", value: "-6K" },
	],
	note: "Invoicing this month is thin, so this room may not last.",
	context: "Biggest payment in: 15K on 3 Mar",
};

test("a card: header, the numbers as fields, the note, a small context line", () => {
	const m = buildMessage(SPEC);
	assert.deepEqual(m.blocks.map((b) => b.type), ["header", "section", "section", "context"]);
	assert.equal(m.blocks[0].text.type, "plain_text");
	assert.equal(m.blocks[0].text.text, SPEC.title);
	assert.deepEqual(m.blocks[1].fields[0], { type: "mrkdwn", text: "*Balance*\n-40K" });
	assert.equal(m.blocks[2].text.text, SPEC.note);
	assert.equal(m.blocks[3].elements[0].text, SPEC.context);
	assert.match(m.text, /Cash: 12K better/, "a plain fallback for notifications");
	assert.match(m.text, /Balance: -40K/);
});

test("more than 10 numbers are split into sections of 10 (Slack's limit)", () => {
	const fields = Array.from({ length: 13 }, (_, i) => ({ label: `L${i}`, value: String(i) }));
	const m = buildMessage({ title: "T", fields });
	const sections = m.blocks.filter((b) => b.type === "section" && b.fields);
	assert.deepEqual(sections.map((s) => s.fields.length), [10, 3]);
});

test("only a title is required; no empty blocks", () => {
	const m = buildMessage({ title: "One thing" });
	assert.deepEqual(m.blocks.map((b) => b.type), ["header"]);
});

test("refuses what makes a wall of text: a long note, long values, too many numbers, no title", () => {
	assert.throws(() => buildMessage({ fields: [] }), /title/);
	assert.throws(() => buildMessage({ title: "x".repeat(151) }), /title/);
	assert.throws(() => buildMessage({ title: "T", note: "a\nb\nc\nd" }), /note/);
	assert.throws(() => buildMessage({ title: "T", note: "x".repeat(401) }), /note/);
	assert.throws(() => buildMessage({ title: "T", fields: [{ label: "L", value: "x".repeat(61) }] }), /value/);
	assert.throws(() => buildMessage({ title: "T", fields: Array.from({ length: 21 }, () => ({ label: "L", value: "1" })) }), /20/);
	assert.throws(() => buildMessage({ title: "T", fields: [{ label: "", value: "1" }] }), /label/);
});

test("mrkdwn control characters from data are neutralized", () => {
	const m = buildMessage({ title: "T", fields: [{ label: "<!channel> a*b", value: "<http://x|y>" }] });
	assert.equal(m.blocks[1].fields[0].text.includes("<!channel>"), false);
	assert.equal(m.blocks[1].fields[0].text.includes("<http"), false);
});

test("postReport: one chat.postMessage with blocks and the fallback text, thread optional", async () => {
	const calls = [];
	const fetchImpl = async (url, init) => { calls.push({ url, init }); return { json: async () => ({ ok: true, ts: "1.2" }) }; };
	const r = await postReport({ channel: "C1", thread: "9.9", spec: SPEC, token: "xoxb-t", fetchImpl });
	assert.equal(r.ts, "1.2");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
	const body = JSON.parse(calls[0].init.body);
	assert.equal(body.channel, "C1");
	assert.equal(body.thread_ts, "9.9");
	assert.equal(body.blocks[0].type, "header");
	assert.equal(calls[0].init.headers.Authorization, "Bearer xoxb-t");
});

test("postReport: Slack's refusal is an error with its reason", async () => {
	const fetchImpl = async () => ({ json: async () => ({ ok: false, error: "not_in_channel" }) });
	await assert.rejects(postReport({ channel: "C1", spec: SPEC, token: "t", fetchImpl }), /not_in_channel/);
});

test("CLI --dry-run prints the blocks and posts nothing", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-report-"));
	const spec = path.join(dir, "spec.json");
	fs.writeFileSync(spec, JSON.stringify(SPEC));
	const r = spawnSync(process.execPath, [path.join(here, "report.mjs"), "--channel", "C1", "--spec", spec, "--dry-run"], { encoding: "utf8", env: { ...process.env, SLACK_BOT_TOKEN: "" } });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(JSON.parse(r.stdout).blocks[0].type, "header");
	const bad = spawnSync(process.execPath, [path.join(here, "report.mjs"), "--channel", "C1", "--spec", spec], { encoding: "utf8", env: { ...process.env, SLACK_BOT_TOKEN: "" } });
	assert.equal(bad.status, 1, "no token: refuses");
});
