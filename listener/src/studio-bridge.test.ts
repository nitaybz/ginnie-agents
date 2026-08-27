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

test("unknown routes are refused", async () => {
	const h = await start();
	const res = await fetch(`${h.url}/anything-else`, { headers: { "x-studio-key": GOOD_KEY } });
	assert.equal(res.status, 404);
	assert.deepEqual(await res.json(), { error: "not_found" });
	await h.close();
});
