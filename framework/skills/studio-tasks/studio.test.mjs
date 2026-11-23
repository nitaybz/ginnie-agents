// Run: node --test framework/skills/studio-tasks/*.test.mjs   (from the repo root)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { profileFor, buildStudioMessage, openTask, configFrom, anchorFor } from "./studio.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "studio.mjs");
const tmp = () => mkdtempSync(path.join(tmpdir(), "shared-studio-"));

function fakeFetch(handlers) {
	const calls = [];
	const fn = async (url, init) => {
		const body = init?.body ? JSON.parse(init.body) : null;
		calls.push({ url: String(url), body });
		if (String(url).includes("slack.com/api/")) return new Response(JSON.stringify({ ok: true, ts: "9.1" }), { status: 200 });
		const h = handlers[body.params.name];
		const result = typeof h === "function" ? h(body.params.arguments) : h;
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } }), { status: 200 });
	};
	fn.calls = calls;
	return fn;
}

test("profiles exist for adam and shai, with their own title, key prefix and Hebrew line", () => {
	for (const a of ["adam", "shai"]) {
		const p = profileFor(a);
		assert.equal(p.agent, a);
		assert.match(p.keyPrefix, new RegExp(`^${a}-`));
		assert.equal(p.stateFile, "/workspace/data/studio-tasks.json");
		assert.match(p.defaultOpenText("x"), /Studio/);
		assert.doesNotMatch(p.defaultOpenText("x"), /[—–]/);
	}
	assert.throws(() => profileFor("omer"), /adam|shai/);
});

test("the Studio message names the agent, carries the problem and asks for a final status line", () => {
	const m = buildStudioMessage(profileFor("adam"), { title: "iCount sync fails", body: "details here", slackLink: null });
	assert.match(m, /Adam/);
	assert.match(m, /details here/);
	assert.match(m, /STUDIO-STATUS/);
});

test("open without a Slack message works: a stable anchor from the title, one chat per title", async () => {
	const state = path.join(tmp(), "s.json");
	const f = fakeFetch({ create_chat: () => ({ id: "op1", chatId: "c1", url: "/?chat=c1" }) });
	const cfg = { mcpUrl: "https://studio.example/mcp", token: "t", origin: "https://studio.example", slackToken: null };
	const a = await openTask(profileFor("adam"), cfg, state, { project: "ginnie-agents", title: "Fix X", body: "why" }, f);
	const b = await openTask(profileFor("adam"), cfg, state, { project: "ginnie-agents", title: "Fix X", body: "why" }, f);
	assert.equal(a.chatId, "c1");
	assert.equal(a.studioLink, "https://studio.example/?chat=c1");
	assert.equal(b.id, a.id);
	assert.equal(f.calls.filter((c) => c.body?.params?.name === "create_chat").length, 1);
	const args = f.calls[0].body.params.arguments;
	assert.match(args.idempotencyKey, /^adam-task-/);
	assert.match(args.title, /^Adam: Fix X/);
	assert.equal(f.calls.filter((c) => c.url.includes("slack.com")).length, 0, "Adam tells Nitay himself; no Slack post");
	assert.deepEqual(anchorFor("Fix X"), anchorFor("Fix X"));
});

test("config: each agent has its own studio_mcp_token in its credentials.json; Adam never relays to himself", () => {
	const d = tmp();
	const creds = path.join(d, "credentials.json");
	writeFileSync(creds, JSON.stringify({ studio_mcp_token: "abc", slack_bot_token: "x", handoff_channel: "C1" }));
	const adam = configFrom(profileFor("adam"), creds);
	assert.equal(adam.token, "abc");
	assert.equal(adam.slackToken, null);
	assert.equal(adam.handoffChannel, null);
	const shai = configFrom(profileFor("shai"), creds);
	assert.equal(shai.slackToken, "x");
	assert.equal(shai.handoffChannel, "C1");
});

test("no token: exits 3 with a plain line saying where Nitay pastes the key, and never prints a token", () => {
	const d = tmp();
	const creds = path.join(d, "credentials.json");
	writeFileSync(creds, JSON.stringify({}));
	const r = spawnSync(process.execPath, [SCRIPT, "projects", "--agent", "adam", "--creds", creds], { encoding: "utf8" });
	assert.equal(r.status, 3);
	assert.match(r.stderr, /studio_mcp_token/);
	assert.match(r.stderr, /credentials\.json/);
});

test("the core is the same file as Omer's (when the agents folder is next to it)", () => {
	const omer = path.join(HERE, "..", "..", "..", "agents", "omer", "skills", "studio-tasks", "studio-core.mjs");
	if (!existsSync(omer)) return;
	assert.equal(readFileSync(path.join(HERE, "studio-core.mjs"), "utf8"), readFileSync(omer, "utf8"));
});
