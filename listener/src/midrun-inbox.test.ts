/**
 * Mid-run messages (Nitay 2026-11-16): a message that arrives while the agent works is handed to
 * the working run; it is run exactly once, inside that run or as the next run, never both and
 * never lost. Both sides of the handoff are tested together: the listener's MidRunInbox and the
 * container's docker/midrun.mjs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { MIDRUN_CONTAINER_DIR, MidRunInbox, midrunDockerArgs, openMidRunInbox } from "./midrun-inbox";
import { parseRunOutput } from "./runner";
import { SDK_DIR, pinnedSdk } from "./sdk-harness";
import { ThreadDispatcher, queueKey } from "./thread-routing";
import { MIDRUN_NOTE, buildMidRunPrompt } from "./slack-prompt";

const repoRoot = path.join(__dirname, "..", "..");
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
const container = () => esmImport(require("node:url").pathToFileURL(path.join(repoRoot, "docker", "midrun.mjs")).href);

const root = () => mkdtempSync(path.join(os.tmpdir(), "midrun-test-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("inbox handoff between listener and container", () => {
	test("taken and seen by the run: not run again", async () => {
		const { claim, markSeen } = await container();
		const inbox = new MidRunInbox<string>(root(), "sally-1");
		assert.equal(inbox.offer("m1", "stop counting"), true);
		const got = claim(inbox.dir);
		assert.deepEqual(got.map((m: any) => m.text), ["stop counting"]);
		assert.deepEqual(inbox.seen(), [], "taken but the model has not got it yet");
		markSeen(inbox.dir, got[0].name);
		assert.deepEqual(inbox.seen(), ["m1"]);
		assert.deepEqual(inbox.finish(), []);
		assert.deepEqual(inbox.seen(), ["m1"], "still known after the folder is gone");
		assert.equal(existsSync(inbox.dir), false);
	});

	test("never taken (the run ended first): runs next", () => {
		const inbox = new MidRunInbox<string>(root(), "sally-2");
		inbox.offer("m1", "one");
		inbox.offer("m2", "two");
		assert.deepEqual(inbox.finish(), ["m1", "m2"]);
	});

	test("taken but the run died before the model got it: runs next", async () => {
		const { claim } = await container();
		const inbox = new MidRunInbox<string>(root(), "sally-3");
		inbox.offer("m1", "one");
		claim(inbox.dir);
		assert.deepEqual(inbox.finish(), ["m1"]);
	});

	test("race at the end: after the run closed its inbox a message cannot land in it", async () => {
		const { closeInbox } = await container();
		const inbox = new MidRunInbox<string>(root(), "sally-4");
		inbox.offer("early", "landed just before the close");
		assert.equal(closeInbox(inbox.dir), true);
		assert.equal(inbox.offer("late", "too late"), false, "the caller queues it as a normal run");
		assert.deepEqual(readdirSync(inbox.dir).filter((n) => n.startsWith(".tmp")), [], "no stray file");
		assert.deepEqual(inbox.finish(), ["early"], "the one that slipped in before the close is not lost");
	});

	test("after finish nothing is accepted", () => {
		const inbox = new MidRunInbox<string>(root(), "sally-5");
		inbox.finish();
		assert.equal(inbox.offer("m", "x"), false);
		assert.deepEqual(inbox.finish(), []);
	});

	test("flag off: no inbox, no extra docker args", () => {
		assert.deepEqual(midrunDockerArgs(undefined), []);
		assert.deepEqual(midrunDockerArgs("/data/midrun/r1"), ["-e", `MIDRUN_DIR=${MIDRUN_CONTAINER_DIR}`, "-v", `/data/midrun/r1:${MIDRUN_CONTAINER_DIR}`]);
	});

	test("the handed message keeps the usual Slack envelope under one note", () => {
		const text = buildMidRunPrompt({ channel: "C1", threadTs: "1700000000.000100", message: "From: Nitay | role: owner\nstop" });
		assert.ok(text.startsWith(MIDRUN_NOTE));
		assert.ok(text.includes("Slack reply (channel: C1, thread: 1700000000.000100):\n\nFrom: Nitay | role: owner\nstop"));
		assert.ok(text.endsWith("Reply in Slack channel C1, thread 1700000000.000100."));
	});
});

// How the feed behaves with the real Claude program is tested in midrun-sdk.test.ts. The one case
// below cannot be produced with the real program (it always takes what it is handed), so it is
// the only one driven by hand: the safety net for a program that never takes a message.
describe("container feed: safety net", () => {
	test("the session never takes a handed message: stop waiting, it runs next", async () => {
		const { createFeed } = await container();
		const inbox = new MidRunInbox<string>(root(), "r4");
		const feed = createFeed(inbox.dir, "task", { pollMs: 5, idleMs: 30 });
		const done = (async () => { for await (const _m of feed.input) { /* read like the program does */ } })();
		inbox.offer("m1", "ignored");
		await sleep(30);
		feed.observe({ type: "result", is_error: false });
		await done;
		assert.deepEqual(inbox.finish(), ["m1"]);
	});
});

describe("the inbox folder", () => {
	test("private to the listener's user (0700), which is the user the container runs as", () => {
		const inbox = new MidRunInbox<string>(root(), "sally");
		for (const d of ["", "inbox", "claimed", "seen"]) {
			assert.equal(statSync(path.join(inbox.dir, d)).mode & 0o777, 0o700, d || "run folder");
		}
		assert.equal(statSync(inbox.dir).uid, process.getuid!());
		inbox.finish();
	});

	test("cannot be created: no inbox, said once, and the message is not lost (it waits in line as before)", async () => {
		const blocked = path.join(root(), "not-a-folder");
		writeFileSync(blocked, "x"); // the data folder is unusable
		const logs: string[] = [];
		assert.equal(openMidRunInbox<string>(blocked, "sally", (l) => logs.push(l)), undefined);
		assert.equal(openMidRunInbox<string>(blocked, "sally", (l) => logs.push(l)), undefined);
		assert.equal(logs.length, 1);

		// The listener's wiring: with no inbox the busy thread's message queues and runs next.
		type Msg = { agent: { name: string }; channel: string; threadTs: string; text: string };
		const runs: string[][] = [];
		let release!: () => void;
		const d = new ThreadDispatcher<Msg>({
			debounceMs: 5,
			offerToRun: (msg) => { const inbox = openMidRunInbox<Msg>(blocked, "sally", () => {}); return !!inbox && inbox.offer(msg, msg.text); },
			process: async (_a, batch) => { runs.push(batch.map((x) => x.text)); if (runs.length === 1) await new Promise<void>((r) => { release = r; }); },
		});
		d.enqueue({ agent: { name: "sally" }, channel: "C1", threadTs: "1.1", text: "a1" });
		await sleep(20);
		d.enqueue({ agent: { name: "sally" }, channel: "C1", threadTs: "1.1", text: "a2" });
		release();
		await d.idle();
		assert.deepEqual(runs, [["a1"], ["a2"]]);
	});

	test("a write that fails is refused, not thrown: the caller queues the message", () => {
		const inbox = new MidRunInbox<string>(root(), "sally");
		rmSync(inbox.dir, { recursive: true, force: true }); // the folder vanished under the run
		assert.equal(inbox.offer("m1", "x"), false);
		assert.deepEqual(inbox.finish(), []);
	});
});

describe("the installed SDK is checked before a run feeds mid-run messages", () => {
	test("the pinned SDK has what the feed needs", async () => {
		const { feedSupport } = await container();
		await pinnedSdk(); // the version in docker/package.json is the one installed
		const inbox = new MidRunInbox<string>(root(), "sally");
		assert.deepEqual(feedSupport(SDK_DIR, inbox.dir), { ok: true, reason: "" });
		inbox.finish();
	});

	test("an SDK without the confirmation: the feed is off and says why", async () => {
		const { feedSupport } = await container();
		const fake = path.join(root(), "claude-agent-sdk");
		mkdirSync(fake);
		writeFileSync(path.join(fake, "sdk.d.ts"), "export declare type SDKUserMessage = { type: 'user' };");
		const inbox = new MidRunInbox<string>(root(), "sally");
		const support = feedSupport(fake, inbox.dir);
		assert.equal(support.ok, false);
		assert.match(support.reason, /isReplay/);
		inbox.finish();
	});

	test("an inbox the container user cannot write: the feed is off", async () => {
		const { feedSupport } = await container();
		const support = feedSupport(SDK_DIR, path.join(root(), "missing"));
		assert.equal(support.ok, false);
	});

	test("feed off = inbox closed at once, so the listener queues as before", async () => {
		const { closeInbox } = await container();
		const inbox = new MidRunInbox<string>(root(), "sally");
		closeInbox(inbox.dir); // what the entrypoint does when the check fails
		assert.equal(inbox.offer("m1", "x"), false);
	});
});

describe("run outcome: the last result decides", () => {
	const line = (o: object) => JSON.stringify({ session_id: "s1", ...o });

	test("max turns, then the handed message was answered: not a failure, no failure notice", () => {
		const out = parseRunOutput([line({ is_error: true, result: "Reached maximum number of turns (2)" }), line({ is_error: false, result: "stopped" })].join("\n"), 0);
		assert.equal(out.isError, false);
		assert.equal(out.result, "stopped");
	});

	test("a final error is still a failure, also after an earlier success", () => {
		assert.equal(parseRunOutput([line({ is_error: false, result: "ok" }), line({ is_error: true, result: "boom" })].join("\n"), 0).isError, true);
		assert.equal(parseRunOutput(line({ is_error: true, result: "boom" }), 0).isError, true);
	});

	test("a non-zero exit is a failure whatever was printed", () => {
		assert.equal(parseRunOutput(line({ is_error: false, result: "ok" }), 1).isError, true);
		assert.equal(parseRunOutput("", 137).isError, true);
	});

	test("a usage limit counts only when the run ended on it", () => {
		const limit = line({ is_error: true, result: "limit", limit_hit: true, limit_type: "five_hour", resets_at: 5 });
		assert.deepEqual(parseRunOutput(limit, 1).limit, { type: "five_hour", resetsAt: 5 });
		assert.equal(parseRunOutput([limit, line({ is_error: false, result: "ok" })].join("\n"), 0).limit, null);
	});

	test("one result, as before: session, model and tool calls are read", () => {
		const out = parseRunOutput(line({ is_error: false, result: "hi", model: "m", tool_calls: 3 }), 0, "old");
		assert.deepEqual(out, { sessionId: "s1", isError: false, result: "hi", model: "m", limit: null, toolCalls: 3, reportedSessionId: "s1" });
	});
});

describe("dispatcher: a busy thread hands the message to the working run", () => {
	type Msg = { agent: { name: string }; channel: string; threadTs: string; text: string };
	const m = (text: string): Msg => ({ agent: { name: "sally" }, channel: "C1", threadTs: "1.1", text });

	test("no loss, no duplicate: taken messages are not run again, the rest run next, in order", async () => {
		const { claim, markSeen, closeInbox } = await container();
		const dataRoot = root();
		const key = queueKey("sally", "C1", "1.1");
		const runs: string[][] = [];
		const takenMidRun: string[] = [];
		let inbox: MidRunInbox<Msg> | undefined;
		let release!: () => void;
		const d: ThreadDispatcher<Msg> = new ThreadDispatcher<Msg>({
			debounceMs: 5,
			offerToRun: (msg) => !!inbox && inbox.offer(msg, msg.text),
			process: async (_agent, batch) => {
				runs.push(batch.map((x) => x.text));
				if (runs.length > 1) return;
				inbox = new MidRunInbox<Msg>(dataRoot, "sally-run");
				await new Promise<void>((r) => { release = r; });
				// The container: takes what is there, the model sees the first only, then it closes.
				const got = claim(inbox.dir);
				markSeen(inbox.dir, got[0].name);
				takenMidRun.push(got[0].text);
				closeInbox(inbox.dir);
				d.enqueue(m("a4 after the close"));
				d.requeue(key, inbox.finish());
				inbox = undefined;
			},
		});
		d.enqueue(m("a1"));
		await sleep(20); // the run is working
		d.enqueue(m("a2"));
		d.enqueue(m("a3"));
		release();
		await d.idle();
		assert.deepEqual(takenMidRun, ["a2"]);
		assert.deepEqual(runs, [["a1"], ["a3", "a4 after the close"]]);
	});

	test("flag off (no offerToRun) or no inbox: the message waits for the run to end, as before", async () => {
		for (const offerToRun of [undefined, () => false]) {
			const runs: string[][] = [];
			let release!: () => void;
			const d = new ThreadDispatcher<Msg>({
				debounceMs: 5,
				offerToRun,
				process: async (_agent, batch) => {
					runs.push(batch.map((x) => x.text));
					if (runs.length === 1) await new Promise<void>((r) => { release = r; });
				},
			});
			d.enqueue(m("a1"));
			await sleep(20);
			d.enqueue(m("a2"));
			assert.deepEqual(runs, [["a1"]]);
			release();
			await d.idle();
			assert.deepEqual(runs, [["a1"], ["a2"]]);
		}
	});

	test("an idle thread is never offered: the message starts a run", async () => {
		let offered = 0;
		const runs: string[][] = [];
		const d = new ThreadDispatcher<Msg>({
			debounceMs: 5,
			offerToRun: () => { offered++; return true; },
			process: async (_agent, batch) => { runs.push(batch.map((x) => x.text)); },
		});
		d.enqueue(m("a1"));
		await d.idle();
		assert.equal(offered, 0);
		assert.deepEqual(runs, [["a1"]]);
	});
});
