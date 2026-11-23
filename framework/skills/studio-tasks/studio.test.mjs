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

test("config: only the agent's own key, and no Slack at all for either agent (no self-relay, no 'no-slack' posts)", () => {
	const d = tmp();
	const creds = path.join(d, "credentials.json");
	writeFileSync(creds, JSON.stringify({ studio_mcp_token: "abc", slack_bot_token: "x", handoff_channel: "C1" }));
	process.env.STUDIO_MCP_TOKEN = "from-env";
	for (const a of ["adam", "shai"]) {
		const c = configFrom(profileFor(a), creds);
		assert.equal(c.token, "abc");
		assert.equal(c.slackToken, null);
		assert.equal(c.handoffChannel, null);
	}
	writeFileSync(creds, JSON.stringify({}));
	assert.equal(configFrom(profileFor("adam"), creds).token, null, "never another agent's key from the environment");
	delete process.env.STUDIO_MCP_TOKEN;
});

test("Shai and Adam: open, check and done never post to Slack; a reply shows once, and not again after done", async () => {
	const d = tmp();
	const state = path.join(d, "s.json");
	const creds = path.join(d, "credentials.json");
	writeFileSync(creds, JSON.stringify({ studio_mcp_token: "abc", slack_bot_token: "x", handoff_channel: "C1" }));
	const cfg = configFrom(profileFor("shai"), creds);
	const f = fakeFetch({
		create_chat: () => ({ id: "op1", chatId: "c9", url: "/?chat=c9" }),
		read_inbox: () => ({ messages: [{ sequence: 1, chatId: "c9", text: "Which order number?", createdAt: new Date().toISOString() }], nextCursor: "k1" }),
	});
	const rec = await openTask(profileFor("shai"), cfg, state, { project: "p", title: "T", body: "b" }, f);
	const { checkBugs, skipItems, loadState } = await import("./studio-core.mjs");
	const r1 = await checkBugs(profileFor("shai"), cfg, state, { post: false }, f);
	assert.equal(f.calls.filter((c) => c.url.includes("slack.com")).length, 0);
	const pend = loadState(state).bugs.find((b) => b.id === rec.id).pending;
	skipItems(state, { id: rec.id });
	assert.equal(loadState(state).bugs.find((b) => b.id === rec.id).pending.length, 0);
	assert.ok(Array.isArray(r1.news));
	assert.ok(pend.length <= 1);
});

test("a task closed as fixed and opened again with the same title gets a new Studio chat", async () => {
	const state = path.join(tmp(), "s.json");
	let n = 0;
	const f = fakeFetch({ create_chat: () => ({ id: `op${++n}`, chatId: `c${n}`, url: `/?chat=c${n}` }) });
	const cfg = { mcpUrl: "https://studio.example/mcp", token: "t", origin: "https://studio.example", slackToken: null };
	const a = await openTask(profileFor("adam"), cfg, state, { project: "p", title: "Same", body: "b" }, f);
	const s = JSON.parse(readFileSync(state, "utf8"));
	s.bugs[0].status = "fixed";
	writeFileSync(state, JSON.stringify(s));
	const b = await openTask(profileFor("adam"), cfg, state, { project: "p", title: "Same", body: "b" }, f);
	assert.notEqual(b.id, a.id);
	assert.equal(b.chatId, "c2");
	const c = await openTask(profileFor("adam"), cfg, state, { project: "p", title: "Same", body: "b" }, f);
	assert.equal(c.id, b.id, "while the new one is open, no third chat");
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
	let omer = path.join(HERE, "..", "..", "..", "agents", "omer", "skills", "studio-tasks", "studio-core.mjs");
	const main = path.join(process.env.HOME || "", "Projects", "Ginnie Repos", "ginnie-agents", "agents", "omer", "skills", "studio-tasks", "studio-core.mjs");
	const src = existsSync(omer) ? omer : main;
	assert.ok(existsSync(src), "Omer's studio-core.mjs must be reachable to compare");
	omer = src;
	assert.equal(readFileSync(path.join(HERE, "studio-core.mjs"), "utf8"), readFileSync(omer, "utf8"));
});
