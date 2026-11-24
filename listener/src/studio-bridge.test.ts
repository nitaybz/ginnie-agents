import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { AddressInfo } from "net";
import { startStudioBridge } from "./studio-bridge";
import type { AgentConfig, AgentRunResult } from "./runner";

const GOOD_KEY = "k".repeat(64);

function agentDir(): string {
	return mkdtempSync(path.join(tmpdir(), "bridge-agent-"));
}

function fakeAgent(name: string): AgentConfig {
	return {
		name,
		dir: agentDir(),
		slackBotId: "",
		slackBotMsgId: "",
		slackChannel: "",
		slackBotToken: "",
		slackAppToken: "",
		maxTurns: 50,
		allowedTools: [],
		boundaries: "write",
		workHours: { enabled: false, start: "09:00", end: "18:00", days: [], off_hours_behavior: "queue" },
		allowUnverifiedSenders: false,
		buttonTtlHours: 48,
	};
}

function writeKeyFile(contents: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "bridge-key-"));
	const file = path.join(dir, "key");
	writeFileSync(file, contents);
	return file;
}

interface Harness {
	url: string;
	runCalls: Array<{ name: string; message: string; sessionId?: string }>;
	close: () => Promise<void>;
}

async function start(overrides: {
	keyFile?: string;
	run?: (a: AgentConfig, m: string) => Promise<AgentRunResult>;
	resume?: (a: AgentConfig, s: string, m: string) => Promise<AgentRunResult>;
} = {}): Promise<Harness> {
	const runCalls: Harness["runCalls"] = [];
	const server = startStudioBridge({
		port: 0,
		keyFile: overrides.keyFile ?? writeKeyFile(GOOD_KEY),
		listAgents: () => [fakeAgent("casper")],
		run: overrides.run ?? (async (a, m) => {
			runCalls.push({ name: a.name, message: m });
			return { sessionId: "sess-new", isError: false, result: "hello from casper" };
		}),
		resume: overrides.resume ?? (async (a, s, m) => {
			runCalls.push({ name: a.name, message: m, sessionId: s });
			return { sessionId: s, isError: false, result: "resumed" };
		}),
	});
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		runCalls,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

test("roster requires a key", async () => {
	const h = await start();
	const res = await fetch(`${h.url}/studio/roster`);
	assert.equal(res.status, 401);
	assert.deepEqual(await res.json(), { error: "unauthorized" });
	await h.close();
});

test("roster rejects a wrong key", async () => {
	const h = await start();
	const res = await fetch(`${h.url}/studio/roster`, { headers: { "x-studio-key": "x".repeat(64) } });
	assert.equal(res.status, 401);
	await h.close();
});

test("roster refuses to serve when no key is installed", async () => {
	const h = await start({ keyFile: path.join(tmpdir(), "definitely-missing-key-file") });
	const res = await fetch(`${h.url}/studio/roster`, { headers: { "x-studio-key": GOOD_KEY } });
	assert.equal(res.status, 503);
	assert.deepEqual(await res.json(), { error: "no_key" });
	await h.close();
});

test("roster refuses a key file that is too short to be a secret", async () => {
	const h = await start({ keyFile: writeKeyFile("short") });
	const res = await fetch(`${h.url}/studio/roster`, { headers: { "x-studio-key": "short" } });
	assert.equal(res.status, 503);
	await h.close();
});

test("roster lists the agents", async () => {
	const h = await start();
	const res = await fetch(`${h.url}/studio/roster`, { headers: { "x-studio-key": GOOD_KEY } });
	assert.equal(res.status, 200);
	const body = await res.json() as { agents: Array<{ name: string; displayName: string }> };
	assert.equal(body.agents.length, 1);
	assert.equal(body.agents[0].name, "casper");
	assert.equal(body.agents[0].displayName, "Casper");
	await h.close();
});

test("run starts a new session when no sessionId is given", async () => {
	const h = await start();
	const res = await fetch(`${h.url}/studio/run`, {
		method: "POST",
		headers: { "x-studio-key": GOOD_KEY, "content-type": "application/json" },
		body: JSON.stringify({ agent: "casper", message: "what is our runway" }),
	});
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { sessionId: "sess-new", isError: false, result: "hello from casper" });
	assert.deepEqual(h.runCalls, [{ name: "casper", message: "what is our runway" }]);
	await h.close();
});

test("run resumes when a sessionId is given", async () => {
	const h = await start();
	const res = await fetch(`${h.url}/studio/run`, {
		method: "POST",
		headers: { "x-studio-key": GOOD_KEY, "content-type": "application/json" },
		body: JSON.stringify({ agent: "casper", message: "and next quarter", sessionId: "sess-old" }),
	});
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { sessionId: "sess-old", isError: false, result: "resumed" });
	assert.deepEqual(h.runCalls, [{ name: "casper", message: "and next quarter", sessionId: "sess-old" }]);
	await h.close();
});

test("run rejects an unknown agent", async () => {
	const h = await start();
	const res = await fetch(`${h.url}/studio/run`, {
		method: "POST",
		headers: { "x-studio-key": GOOD_KEY, "content-type": "application/json" },
		body: JSON.stringify({ agent: "nobody", message: "hi" }),
	});
	assert.equal(res.status, 404);
	assert.deepEqual(await res.json(), { error: "unknown_agent" });
	await h.close();
});

test("run rejects a body with no message", async () => {
	const h = await start();
	const res = await fetch(`${h.url}/studio/run`, {
		method: "POST",
		headers: { "x-studio-key": GOOD_KEY, "content-type": "application/json" },
		body: JSON.stringify({ agent: "casper" }),
	});
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: "bad_request" });
	await h.close();
});

test("run rejects malformed JSON", async () => {
	const h = await start();
	const res = await fetch(`${h.url}/studio/run`, {
		method: "POST",
		headers: { "x-studio-key": GOOD_KEY, "content-type": "application/json" },
		body: "{ not json",
	});
	assert.equal(res.status, 400);
	await h.close();
});

test("run reports a container failure instead of hanging", async () => {
	const h = await start({
		run: async () => { throw new Error("docker daemon is not running"); },
	});
	const res = await fetch(`${h.url}/studio/run`, {
		method: "POST",
		headers: { "x-studio-key": GOOD_KEY, "content-type": "application/json" },
		body: JSON.stringify({ agent: "casper", message: "hi" }),
	});
	assert.equal(res.status, 500);
	const body = await res.json() as { error: string; detail: string };
	assert.equal(body.error, "run_failed");
	assert.match(body.detail, /docker daemon/);
	await h.close();
});

test("run passes an agent-reported error through rather than swallowing it", async () => {
	const h = await start({
		run: async () => ({ sessionId: "sess-err", isError: true, result: "Could not process image" }),
	});
	const res = await fetch(`${h.url}/studio/run`, {
		method: "POST",
		headers: { "x-studio-key": GOOD_KEY, "content-type": "application/json" },
		body: JSON.stringify({ agent: "casper", message: "hi" }),
	});
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { sessionId: "sess-err", isError: true, result: "Could not process image" });
	await h.close();
});

test("a second bridge on an already-bound port fails to bind without throwing", async () => {
	const h = await start();
	// h is already listening on a real (ephemeral) port. Starting a second
	// bridge on that same port must hit EADDRINUSE. Deliberately do NOT
	// attach an 'error' listener from this test — doing so would itself
	// satisfy Node's "someone is listening" check and mask the very bug
	// we're proving is fixed. Instead spy on console.error (production's own
	// reporting channel) so we observe how the failure surfaces without
	// touching the EventEmitter ourselves.
	const port = Number(new URL(h.url).port);

	const originalError = console.error;
	const logged: unknown[][] = [];
	console.error = (...args: unknown[]) => { logged.push(args); };

	let second: ReturnType<typeof startStudioBridge> | undefined;
	try {
		second = startStudioBridge({
			port,
			keyFile: writeKeyFile(GOOD_KEY),
			listAgents: () => [fakeAgent("casper")],
		});

		// Give the async EADDRINUSE 'error' event a tick to fire. Before the
		// fix, this event had no listener anywhere, so Node would throw it as
		// an uncaught exception right here and crash the whole test process —
		// this test would never reach the assertions below. Simply getting
		// here is itself evidence the process survived.
		await new Promise((resolve) => setTimeout(resolve, 100));
	} finally {
		console.error = originalError;
	}

	assert.ok(
		logged.some((args) =>
			String(args[0]).includes("[studio-bridge]") && String(args[0]).includes("failed to bind")),
		"expected the bind failure to be reported via console.error, not thrown as an uncaught exception",
	);

	await h.close();
	if (second) await new Promise<void>((resolve) => second.close(() => resolve()));
});

test("unknown routes are refused", async () => {
	const h = await start();
	const res = await fetch(`${h.url}/anything-else`, { headers: { "x-studio-key": GOOD_KEY } });
	assert.equal(res.status, 404);
	assert.deepEqual(await res.json(), { error: "not_found" });
	await h.close();
});

// ─── POST /studio/converse: one open run per conversation ────────────────

import { ConversationRuns } from "./conversation-runs";

interface ConverseHarness {
	url: string;
	pending: Array<{ message: string; finish: () => void }>;
	logs: string[];
	runs: ConversationRuns;
	close: () => Promise<void>;
}

async function startConverse(opts: { withRoute?: boolean } = {}): Promise<ConverseHarness> {
	const pending: ConverseHarness["pending"] = [];
	const logs: string[] = [];
	const call = (message: string) => new Promise<AgentRunResult>((resolve) => {
		pending.push({ message, finish: () => resolve({ sessionId: "sess-c", isError: false, result: "ok" }) });
	});
	const inboxRoot = mkdtempSync(path.join(tmpdir(), "bridge-conv-"));
	const runs = new ConversationRuns({
		run: (_a, m) => call(m),
		resume: (_a, _s, m) => call(m),
		getSession: () => undefined,
		setSession: () => {},
		now: () => Date.now(),
		inboxRoot,
		log: (l) => logs.push(l),
	});
	const server = startStudioBridge({
		port: 0,
		keyFile: writeKeyFile(GOOD_KEY),
		listAgents: () => [{ ...fakeAgent("agent-a"), runProfiles: { chat: { lingerMinutes: 10 } } }],
		converse: opts.withRoute === false ? undefined : (agent, conversation, message, profile) => runs.deliver(agent, conversation, message, profile),
	});
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		pending,
		logs,
		runs,
		close: async () => {
			for (const p of pending) p.finish();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function converse(h: { url: string }, body: unknown, key: string | null = GOOD_KEY): Promise<Response> {
	return fetch(`${h.url}/studio/converse`, {
		method: "POST",
		headers: { ...(key ? { "x-studio-key": key } : {}), "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

test("converse: missing or wrong key is 401", async () => {
	const h = await startConverse();
	const body = { agent: "agent-a", conversation: "conv-1", message: "hi" };
	assert.equal((await converse(h, body, null)).status, 401);
	assert.equal((await converse(h, body, "x".repeat(64))).status, 401);
	assert.equal(h.pending.length, 0);
	await h.close();
});

test("converse: a bad body is 400 (conversation id, message, profile, JSON)", async () => {
	const h = await startConverse();
	for (const body of [
		{ agent: "agent-a", conversation: "has space", message: "hi" },
		{ agent: "agent-a", conversation: "../x", message: "hi" },
		{ agent: "agent-a", conversation: "x".repeat(129), message: "hi" },
		{ agent: "agent-a", conversation: "conv-1" },
		{ agent: "agent-a", conversation: "conv-1", message: "" },
		{ agent: "agent-a", conversation: "conv-1", message: "hi", profile: 7 },
		{ conversation: "conv-1", message: "hi" },
		"{ not json",
	]) {
		const res = await converse(h, body);
		assert.equal(res.status, 400, JSON.stringify(body));
		assert.deepEqual(await res.json(), { error: "bad_request" });
	}
	assert.equal(h.pending.length, 0);
	await h.close();
});

test("converse: an unknown agent is 404", async () => {
	const h = await startConverse();
	const res = await converse(h, { agent: "nobody", conversation: "conv-1", message: "hi" });
	assert.equal(res.status, 404);
	assert.deepEqual(await res.json(), { error: "unknown_agent" });
	await h.close();
});

test("converse: answers 202 within 100 ms while the run is still going; started, then midrun", async () => {
	const h = await startConverse();
	const t0 = Date.now();
	const res = await converse(h, { agent: "agent-a", conversation: "conv-1", message: "first", profile: "chat" });
	const ms = Date.now() - t0;
	assert.equal(res.status, 202);
	assert.deepEqual(await res.json(), { delivery: "started" });
	assert.ok(ms < 100, `answered in ${ms} ms`);
	for (let i = 0; i < 100 && h.pending.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(h.pending.length, 1, "the run is going");
	const res2 = await converse(h, { agent: "agent-a", conversation: "conv-1", message: "second" });
	assert.equal(res2.status, 202);
	assert.deepEqual(await res2.json(), { delivery: "midrun" });
	assert.equal(h.runs.openCount("agent-a"), 1);
	await h.close();
});

test("converse: a listener without the route answers 404 not_found (the host falls back to its old path)", async () => {
	const h = await startConverse({ withRoute: false });
	const res = await converse(h, { agent: "agent-a", conversation: "conv-1", message: "hi" });
	assert.equal(res.status, 404);
	assert.deepEqual(await res.json(), { error: "not_found" });
	await h.close();
});

test("converse: the message body never reaches the log (bridge and runs)", async () => {
	const BODY = "private customer text +000-SECRET";
	const lines: string[] = [];
	const saved = { log: console.log, warn: console.warn, error: console.error };
	const grab = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
	console.log = grab; console.warn = grab; console.error = grab;
	let h: ConverseHarness | undefined;
	try {
		h = await startConverse();
		await converse(h, { agent: "agent-a", conversation: "conv-1", message: `${BODY} 1` });
		for (let i = 0; i < 100 && h.pending.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
		await converse(h, { agent: "agent-a", conversation: "conv-1", message: `${BODY} 2` });
		await converse(h, { agent: "agent-a", conversation: "bad id", message: `${BODY} 3` });
		await converse(h, { agent: "nobody", conversation: "conv-1", message: `${BODY} 4` });
	} finally {
		console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
	}
	const all = [...lines, ...h!.logs];
	assert.ok(lines.some((l) => l.includes("conv-1") && l.includes("started")), `the bridge logs the delivery: ${lines.join(" | ")}`);
	for (const l of all) assert.ok(!l.includes("SECRET"), `log line leaks the message: ${l}`);
	await h!.close();
});

test("converse: a message over 100 KB (UTF-8 bytes) is 413, so the host falls back instead of a run that cannot start", async () => {
	const h = await startConverse();
	try {
	const ok = await converse(h, { agent: "agent-a", conversation: "conv-1", message: "a".repeat(100 * 1024) });
	assert.equal(ok.status, 202, "exactly 100 KB is accepted");
	// 60,000 Hebrew letters: under 100 K characters, 120,000 bytes.
	const big = await converse(h, { agent: "agent-a", conversation: "conv-2", message: "\u05d0".repeat(60_000) });
	assert.equal(big.status, 413);
	assert.deepEqual(await big.json(), { error: "too_large" });
	const ascii = await converse(h, { agent: "agent-a", conversation: "conv-3", message: "a".repeat(100 * 1024 + 1) });
	assert.equal(ascii.status, 413);
	for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(h.pending.length, 1, "only the accepted message started a run");
	} finally {
		await h.close();
	}
});

test("converse: the profile must be one the agent defines (400 otherwise); the raw profile is never logged", async () => {
	const lines: string[] = [];
	const saved = { log: console.log, warn: console.warn, error: console.error };
	const grab = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
	console.log = grab; console.warn = grab; console.error = grab;
	let h: ConverseHarness | undefined;
	try {
		h = await startConverse();
		const bad = await converse(h, { agent: "agent-a", conversation: "conv-1", message: "hi", profile: "nope-PROFILE-SECRET" });
		assert.equal(bad.status, 400);
		assert.deepEqual(await bad.json(), { error: "bad_request" });
		const empty = await converse(h, { agent: "agent-a", conversation: "conv-1", message: "hi", profile: "" });
		assert.equal(empty.status, 400, "an empty profile is not a profile name");
		const good = await converse(h, { agent: "agent-a", conversation: "conv-1", message: "hi", profile: "chat" });
		assert.equal(good.status, 202);
	} catch (err) {
		await h?.close();
		throw err;
	} finally {
		console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
	}
	try {
		for (const l of [...lines, ...h!.logs]) assert.ok(!l.includes("PROFILE-SECRET"), `raw profile logged: ${l}`);
	} finally {
		await h!.close();
	}
});
