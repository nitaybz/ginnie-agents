/**
 * Conversation runs: one open run per conversation, fed by POST /studio/converse.
 *
 * A host process (for example a chat line's host script) hands the listener a
 * message for a conversation key. The first message starts a run; a message
 * while that run works goes into its mid-run inbox; a message while it is
 * ending waits in line and runs next, resuming the conversation's session
 * when its last activity was under 24 hours ago.
 *
 * Run: cd listener && npx tsc && node --test dist/conversation-runs.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConversationRuns, CONVERSATION_ID } from "./conversation-runs";
import { ThreadDispatcher } from "./thread-routing";
import type { AgentConfig, AgentRunResult, RunOptions } from "./runner";

const HOUR = 60 * 60 * 1000;

function agentWith(name = "agent-a", extra: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		dir: "/tmp/" + name,
		slackBotId: "",
		slackBotMsgId: "",
		slackChannel: "",
		slackBotToken: "",
		slackAppToken: "",
		maxTurns: 50,
		allowedTools: ["Read"],
		boundaries: "write",
		workHours: { enabled: false, start: "09:00", end: "18:00", days: [], off_hours_behavior: "queue" },
		allowUnverifiedSenders: false,
		buttonTtlHours: 48,
		runProfiles: { chat: { lingerMinutes: 10 } },
		...extra,
	};
}

interface Call {
	kind: "run" | "resume";
	agent: string;
	sessionId?: string;
	message: string;
	midrunDir?: string;
	profile?: string;
	opts: RunOptions;
	finish: (r?: Partial<AgentRunResult>) => void;
	fail: (err: Error) => void;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (cond()) return;
		await tick(5);
	}
	assert.fail(`timed out waiting for: ${what}`);
}

function harness(extra: { maxOpen?: number; root?: string; store?: Map<string, { sessionId: string; createdAt: number }> } = {}) {
	const calls: Call[] = [];
	const logs: string[] = [];
	const store = extra.store ?? new Map<string, { sessionId: string; createdAt: number }>();
	const root = extra.root ?? mkdtempSync(path.join(tmpdir(), "conv-runs-"));
	const clock = { now: 10_000 * HOUR };
	let n = 0;
	const call = (c: Omit<Call, "finish" | "fail">): Promise<AgentRunResult> =>
		new Promise((resolve, reject) => {
			const id = ++n;
			calls.push({
				...c,
				finish: (r = {}) => resolve({ sessionId: c.sessionId ?? `sess-${id}`, isError: false, result: "done", ...r }),
				fail: reject,
			});
		});
	const runs = new ConversationRuns({
		run: (agent, message, midrunDir, profile, opts) => call({ kind: "run", agent: agent.name, message, midrunDir, profile, opts }),
		resume: (agent, sessionId, message, midrunDir, profile, opts) =>
			call({ kind: "resume", agent: agent.name, sessionId, message, midrunDir, profile, opts }),
		getSession: (agentName, conversation) => store.get(`${agentName}|${conversation}`),
		setSession: (agentName, conversation, sessionId) => store.set(`${agentName}|${conversation}`, { sessionId, createdAt: clock.now }),
		now: () => clock.now,
		maxOpen: extra.maxOpen,
		inboxRoot: root,
		log: (line) => logs.push(line),
	});
	return { runs, calls, logs, store, root, clock, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** What a run's container does: the model takes every waiting inbox message. */
function modelTakesAll(dir: string): void {
	for (const name of readdirSync(path.join(dir, "inbox"))) renameSync(path.join(dir, "inbox", name), path.join(dir, "seen", name));
}

/** What a run's container does when its run is over: no more messages. */
function runEnding(dir: string): void {
	renameSync(path.join(dir, "inbox"), path.join(dir, "closed"));
}

describe("conversation runs", () => {
	test("first message starts a run with the message as is, the profile and the open-run wait", async () => {
		const h = harness();
		const agent = agentWith();
		assert.equal(h.runs.deliver(agent, "conv-1", "hello there", "chat"), "started");
		await until(() => h.calls.length === 1, "the run");
		const c = h.calls[0];
		assert.equal(c.kind, "run");
		assert.equal(c.message, "hello there");
		assert.equal(c.profile, "chat");
		assert.equal(c.opts.linger, true);
		assert.ok(c.midrunDir && existsSync(path.join(c.midrunDir, "inbox")), "the run has a mid-run inbox");
		assert.equal(h.runs.openCount("agent-a"), 1);
		c.finish({ sessionId: "sess-a" });
		await until(() => h.runs.openCount("agent-a") === 0, "run end");
		assert.equal(h.store.get("agent-a|conv-1")?.sessionId, "sess-a");
		assert.ok(!existsSync(c.midrunDir!), "the inbox folder is removed when the run ends");
		h.cleanup();
	});

	test("a second message while the run works goes into its inbox (midrun), as is", async () => {
		const h = harness();
		const agent = agentWith();
		h.runs.deliver(agent, "conv-1", "first", "chat");
		await until(() => h.calls.length === 1, "the run");
		assert.equal(h.runs.deliver(agent, "conv-1", "second", "chat"), "midrun");
		const dir = h.calls[0].midrunDir!;
		const files = readdirSync(path.join(dir, "inbox"));
		assert.equal(files.length, 1);
		assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "inbox", files[0]), "utf8")), { text: "second" });
		modelTakesAll(dir);
		h.calls[0].finish();
		await until(() => h.runs.openCount("agent-a") === 0, "run end");
		await tick(20);
		assert.equal(h.calls.length, 1, "a message the run took is not run again");
		h.cleanup();
	});

	test("a message while the run is ending waits in line and runs next, resuming the session (queued)", async () => {
		const h = harness();
		const agent = agentWith();
		h.runs.deliver(agent, "conv-1", "first", "chat");
		await until(() => h.calls.length === 1, "the run");
		runEnding(h.calls[0].midrunDir!);
		assert.equal(h.runs.deliver(agent, "conv-1", "late one", "chat"), "queued");
		await tick(20);
		assert.equal(h.calls.length, 1, "the next run waits for this one to end");
		h.calls[0].finish({ sessionId: "sess-1" });
		await until(() => h.calls.length === 2, "the next run");
		const next = h.calls[1];
		assert.equal(next.kind, "resume");
		assert.equal(next.sessionId, "sess-1");
		assert.equal(next.message, "late one");
		assert.equal(next.profile, "chat");
		next.finish();
		await until(() => h.runs.openCount("agent-a") === 0, "run end");
		h.cleanup();
	});

	test("a stored session under 24 h old is resumed; 25 h old starts fresh", async () => {
		const h = harness();
		const agent = agentWith();
		h.store.set("agent-a|conv-1", { sessionId: "sess-old", createdAt: h.clock.now - 23 * HOUR });
		h.store.set("agent-a|conv-2", { sessionId: "sess-stale", createdAt: h.clock.now - 25 * HOUR });
		assert.equal(h.runs.deliver(agent, "conv-1", "hi again", "chat"), "started");
		assert.equal(h.runs.deliver(agent, "conv-2", "hi after a day", "chat"), "started");
		await until(() => h.calls.length === 2, "both runs");
		const byMsg = (m: string) => h.calls.find((c) => c.message === m)!;
		assert.equal(byMsg("hi again").kind, "resume");
		assert.equal(byMsg("hi again").sessionId, "sess-old");
		assert.equal(byMsg("hi after a day").kind, "run", "a 25 h old session starts fresh");
		byMsg("hi again").finish();
		byMsg("hi after a day").finish({ sessionId: "sess-new" });
		await until(() => h.runs.openCount("agent-a") === 0, "runs end");
		assert.equal(h.store.get("agent-a|conv-2")?.sessionId, "sess-new");
		assert.equal(h.store.get("agent-a|conv-1")?.createdAt, h.clock.now, "a resumed run refreshes the last activity");
		h.cleanup();
	});

	test("two conversations run in parallel", async () => {
		const h = harness();
		const agent = agentWith();
		assert.equal(h.runs.deliver(agent, "conv-1", "a", "chat"), "started");
		assert.equal(h.runs.deliver(agent, "conv-2", "b", "chat"), "started");
		await until(() => h.calls.length === 2, "both runs going at once");
		assert.equal(h.runs.openCount("agent-a"), 2);
		assert.notEqual(h.calls[0].midrunDir, h.calls[1].midrunDir);
		for (const c of h.calls) c.finish();
		await until(() => h.runs.openCount("agent-a") === 0, "runs end");
		h.cleanup();
	});

	test("the fifth open run for one agent starts without the open-run wait (default cap 4)", async () => {
		const h = harness();
		const agent = agentWith();
		for (let i = 1; i <= 5; i++) assert.equal(h.runs.deliver(agent, `conv-${i}`, `m${i}`, "chat"), "started");
		await until(() => h.calls.length === 5, "five runs");
		const linger = (m: string) => h.calls.find((c) => c.message === m)!.opts.linger;
		assert.deepEqual([1, 2, 3, 4].map((i) => linger(`m${i}`)), [true, true, true, true]);
		assert.equal(linger("m5"), false);
		// Another agent has its own count.
		const other = agentWith("agent-b");
		assert.equal(h.runs.deliver(other, "conv-1", "b1", "chat"), "started");
		await until(() => h.calls.length === 6, "agent-b run");
		assert.equal(linger("b1"), true);
		// The agent config is not changed by the cap.
		assert.deepEqual(agent.runProfiles, { chat: { lingerMinutes: 10 } });
		// Once one closes, the next run waits again.
		h.calls[0].finish();
		await until(() => h.runs.openCount("agent-a") === 4, "one closed");
		h.runs.deliver(agent, "conv-9", "m9", "chat");
		await until(() => h.calls.length === 7, "next run");
		assert.equal(linger("m9"), true);
		for (const c of h.calls.slice(1)) c.finish();
		await until(() => h.runs.openCount("agent-a") === 0 && h.runs.openCount("agent-b") === 0, "runs end");
		h.cleanup();
	});

	test("linger_max_open in the profile sets the cap; the maxOpen option is the fallback", async () => {
		const h = harness({ maxOpen: 1 });
		const capped = agentWith("agent-a", { runProfiles: { chat: { lingerMinutes: 10, lingerMaxOpen: 2 } } });
		for (let i = 1; i <= 3; i++) h.runs.deliver(capped, `conv-${i}`, `m${i}`, "chat");
		const plain = agentWith("agent-b", { runProfiles: { chat: { lingerMinutes: 10 } } });
		for (let i = 1; i <= 2; i++) h.runs.deliver(plain, `conv-${i}`, `b${i}`, "chat");
		await until(() => h.calls.length === 5, "runs");
		const linger = (m: string) => h.calls.find((c) => c.message === m)!.opts.linger;
		assert.deepEqual([linger("m1"), linger("m2"), linger("m3")], [true, true, false]);
		assert.deepEqual([linger("b1"), linger("b2")], [true, false]);
		for (const c of h.calls) c.finish();
		await until(() => h.runs.openCount("agent-a") === 0 && h.runs.openCount("agent-b") === 0, "runs end");
		h.cleanup();
	});

	test("a failed run is logged, keeps the old session, and its unseen mid-run messages run next", async () => {
		const h = harness();
		const agent = agentWith();
		h.store.set("agent-a|conv-1", { sessionId: "sess-good", createdAt: h.clock.now - HOUR });
		h.runs.deliver(agent, "conv-1", "first", "chat");
		await until(() => h.calls.length === 1, "the run");
		assert.equal(h.runs.deliver(agent, "conv-1", "not taken", "chat"), "midrun");
		h.calls[0].finish({ isError: true, sessionId: "sess-broken", result: "boom" });
		await until(() => h.calls.length === 2, "the unseen message runs next");
		assert.equal(h.calls[1].message, "not taken");
		assert.equal(h.calls[1].sessionId, "sess-good", "a failed run does not replace the stored session");
		assert.ok(h.logs.some((l) => /failed/i.test(l) && l.includes("conv-1")), "the failure is logged");
		// A run that throws (container never started) is logged too, and the line moves on.
		h.runs.deliver(agent, "conv-1", "third", "chat");
		h.calls[1].fail(new Error("spawn docker ENOENT"));
		await until(() => h.calls.length === 3, "next run after a thrown one");
		assert.equal(h.calls[2].message, "third");
		h.calls[2].finish();
		await until(() => h.runs.openCount("agent-a") === 0, "runs end");
		assert.ok(h.logs.some((l) => l.includes("ENOENT")));
		h.cleanup();
	});

	test("no run gets a mid-run inbox when the agent turned mid-run messages off; later messages wait in line", async () => {
		const h = harness();
		const agent = agentWith("agent-a", { midrunMessages: false });
		h.runs.deliver(agent, "conv-1", "first", "chat");
		await until(() => h.calls.length === 1, "the run");
		assert.equal(h.calls[0].midrunDir, undefined);
		assert.equal(h.runs.deliver(agent, "conv-1", "second", "chat"), "queued");
		h.calls[0].finish();
		await until(() => h.calls.length === 2, "next run");
		h.calls[1].finish();
		await until(() => h.runs.openCount("agent-a") === 0, "runs end");
		h.cleanup();
	});

	test("the inbox folder removed under a working run: the message waits in line and runs next", async () => {
		const h = harness();
		const agent = agentWith();
		h.runs.deliver(agent, "conv-1", "first", "chat");
		await until(() => h.calls.length === 1, "the run");
		rmSync(h.root, { recursive: true, force: true });
		assert.equal(h.runs.deliver(agent, "conv-1", "second", "chat"), "queued");
		h.calls[0].finish();
		await until(() => h.calls.length === 2, "next run");
		assert.equal(h.calls[1].message, "second");
		h.calls[1].finish();
		await until(() => h.runs.openCount("agent-a") === 0, "runs end");
		h.cleanup();
	});

	test("after a restart with the inbox folder gone, a message starts a new run that resumes the stored session", async () => {
		const store = new Map<string, { sessionId: string; createdAt: number }>();
		const first = harness({ store });
		first.runs.deliver(agentWith(), "conv-1", "before restart", "chat");
		await until(() => first.calls.length === 1, "the run");
		first.calls[0].finish({ sessionId: "sess-kept" });
		await until(() => first.runs.openCount("agent-a") === 0, "run end");
		first.cleanup(); // the listener clears the inbox root at start
		const after = harness({ store, root: first.root });
		after.clock.now = first.clock.now + HOUR;
		assert.equal(after.runs.deliver(agentWith(), "conv-1", "after restart", "chat"), "started");
		await until(() => after.calls.length === 1, "new run");
		assert.equal(after.calls[0].kind, "resume");
		assert.equal(after.calls[0].sessionId, "sess-kept");
		assert.ok(after.calls[0].midrunDir && existsSync(after.calls[0].midrunDir), "a fresh inbox is made");
		after.calls[0].finish();
		await until(() => after.runs.openCount("agent-a") === 0, "run end");
		after.cleanup();
	});

	test("a run with no profile gets no open-run wait request beyond the defaults", async () => {
		const h = harness();
		h.runs.deliver(agentWith(), "conv-1", "x");
		await until(() => h.calls.length === 1, "the run");
		assert.equal(h.calls[0].profile, undefined);
		h.calls[0].finish();
		await until(() => h.runs.openCount("agent-a") === 0, "run end");
		h.cleanup();
	});

	test("a bad conversation id is refused", () => {
		const h = harness();
		assert.match("conv-1", CONVERSATION_ID);
		assert.match("a.b_c:d-1", CONVERSATION_ID);
		for (const bad of ["", "has space", "x".repeat(129), "../up", "a/b"]) {
			assert.throws(() => h.runs.deliver(agentWith(), bad, "m"), /conversation/);
		}
		h.cleanup();
	});

	test("an open conversation run does not hold up the same agent's Slack or schedule work", async () => {
		const h = harness();
		const agent = agentWith();
		h.runs.deliver(agent, "conv-1", "chat message", "chat");
		await until(() => h.calls.length === 1, "conversation run open (waiting for more messages)");
		// The Slack line is its own dispatcher (index.ts), keyed by Slack thread.
		const started: string[] = [];
		const slack = new ThreadDispatcher<{ agent: { name: string }; channel: string; threadTs: string }>({
			debounceMs: 0,
			process: async (_a, batch) => { started.push(batch[0].threadTs); },
		});
		slack.enqueue({ agent: { name: "agent-a" }, channel: "C1", threadTs: "1700000000.000100" });
		slack.enqueue({ agent: { name: "agent-a" }, channel: "C1", threadTs: "scheduled:daily" });
		await slack.idle();
		assert.deepEqual(started.sort(), ["1700000000.000100", "scheduled:daily"]);
		assert.equal(h.runs.openCount("agent-a"), 1, "the conversation run is still open");
		h.calls[0].finish();
		await until(() => h.runs.openCount("agent-a") === 0, "run end");
		h.cleanup();
	});

	test("the message body never appears in the log: started, midrun, queued, failed and thrown runs", async () => {
		const h = harness();
		const agent = agentWith();
		const BODY = (n: number) => `private customer text ${n} +000-SECRET-${n}`;
		h.runs.deliver(agent, "conv-1", BODY(1), "chat");
		await until(() => h.calls.length === 1, "the run");
		h.runs.deliver(agent, "conv-1", BODY(2), "chat"); // midrun, not taken
		h.calls[0].finish({ isError: true, result: `the run failed on ${BODY(1)}` });
		await until(() => h.calls.length === 2, "requeued run");
		runEnding(h.calls[1].midrunDir!);
		h.runs.deliver(agent, "conv-1", BODY(3), "chat"); // queued
		h.calls[1].fail(new Error(`container said: ${BODY(2)}`));
		await until(() => h.calls.length === 3, "queued run");
		h.calls[2].finish();
		await until(() => h.runs.openCount("agent-a") === 0, "runs end");
		assert.ok(h.logs.length >= 4, `some log lines were written (${h.logs.length})`);
		for (const line of h.logs) {
			for (let i = 1; i <= 3; i++) assert.ok(!line.includes(BODY(i)) && !line.includes(`SECRET-${i}`), `log line leaks a message: ${line}`);
		}
		h.cleanup();
	});
});
