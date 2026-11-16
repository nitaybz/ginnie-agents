/**
 * Mid-run messages (Nitay 2026-11-16): a message that arrives while the agent works is handed to
 * the working run; it is run exactly once, inside that run or as the next run, never both and
 * never lost. Both sides of the handoff are tested together: the listener's MidRunInbox and the
 * container's docker/midrun.mjs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "fs";
import os from "os";
import path from "path";
import { MIDRUN_CONTAINER_DIR, MidRunInbox, midrunDockerArgs } from "./midrun-inbox";
import { ThreadDispatcher, queueKey } from "./thread-routing";
import { MIDRUN_NOTE, buildMidRunPrompt } from "./slack-prompt";

const repoRoot = path.join(__dirname, "..", "..");
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
const container = () => esmImport(require("node:url").pathToFileURL(path.join(repoRoot, "docker", "midrun.mjs")).href);

const root = () => mkdtempSync(path.join(os.tmpdir(), "midrun-test-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const result = { type: "result", is_error: false };
const replay = (uuid: string) => ({ type: "user", isReplay: true, uuid });

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

describe("container feed: the prompt as a stream", () => {
	// Reads what the feed gives the session, like the Claude program does.
	async function reader(feed: any) {
		const got: any[] = [];
		const done = (async () => { for await (const m of feed.input) got.push(m); })();
		await sleep(5);
		return { got, done };
	}

	test("first prompt, then a message that arrives while working; ends after the result", async () => {
		const { createFeed } = await container();
		const inbox = new MidRunInbox<string>(root(), "r1");
		const feed = createFeed(inbox.dir, "count to 5", { pollMs: 5 });
		const { got, done } = await reader(feed);
		assert.equal(got.length, 1);
		assert.equal(got[0].message.content, "count to 5");

		inbox.offer("m1", "stop counting");
		await sleep(30);
		assert.equal(got.length, 2);
		assert.equal(got[1].message.content, "stop counting");
		assert.equal(got[1].priority, "next");
		assert.deepEqual(inbox.seen(), []);

		feed.observe(replay(got[1].uuid));
		assert.deepEqual(inbox.seen(), ["m1"]);
		feed.observe(result);
		await done; // the stream ended, so the query returns
		assert.equal(inbox.offer("m2", "too late"), false, "inbox closed with the run");
		assert.deepEqual(inbox.finish(), []);
	});

	test("result comes while a handed message is still unseen: wait for its own turn", async () => {
		const { createFeed } = await container();
		const inbox = new MidRunInbox<string>(root(), "r2");
		const feed = createFeed(inbox.dir, "task", { pollMs: 5 });
		const { got, done } = await reader(feed);
		inbox.offer("m1", "one more thing");
		await sleep(30);
		let ended = false;
		void done.then(() => { ended = true; });
		feed.observe(result);
		await sleep(30);
		assert.equal(ended, false, "the session has not taken the message yet");
		feed.observe(replay(got[1].uuid));
		feed.observe({ type: "assistant" });
		await sleep(30);
		assert.equal(ended, false, "its turn is running");
		feed.observe(result);
		await done;
		assert.deepEqual(inbox.finish(), []);
	});

	test("a message that lands exactly at the result is still taken by this run", async () => {
		const { createFeed } = await container();
		const inbox = new MidRunInbox<string>(root(), "r3");
		const feed = createFeed(inbox.dir, "task", { pollMs: 100000 });
		const { got } = await reader(feed);
		inbox.offer("m1", "just in time");
		feed.observe(result); // the last look before closing finds it
		await sleep(10);
		assert.equal(got.length, 2);
		assert.equal(got[1].message.content, "just in time");
		feed.stop();
	});

	test("the session never takes a handed message: give up, it runs next", async () => {
		const { createFeed } = await container();
		const inbox = new MidRunInbox<string>(root(), "r4");
		const feed = createFeed(inbox.dir, "task", { pollMs: 5, idleMs: 30 });
		const { done } = await reader(feed);
		inbox.offer("m1", "ignored");
		await sleep(30);
		feed.observe(result);
		await done;
		assert.deepEqual(inbox.finish(), ["m1"]);
	});

	test("the run fails: the stream ends and what was not seen runs next", async () => {
		const { createFeed } = await container();
		const inbox = new MidRunInbox<string>(root(), "r5");
		const feed = createFeed(inbox.dir, "task", { pollMs: 5 });
		const { done } = await reader(feed);
		inbox.offer("m1", "one");
		await sleep(30);
		feed.observe({ type: "result", is_error: true });
		await done;
		assert.deepEqual(inbox.finish(), ["m1"]);
	});

	test("a second try of the same run (usage limit, API error) gets what the first took but never showed", async () => {
		const { createFeed } = await container();
		const inbox = new MidRunInbox<string>(root(), "r6");
		const first = createFeed(inbox.dir, "task", { pollMs: 5 });
		await reader(first);
		inbox.offer("m1", "one");
		await sleep(30);
		first.observe({ type: "result", is_error: true }); // closed its inbox

		const second = createFeed(inbox.dir, "continue", { pollMs: 5 });
		const { got, done } = await reader(second);
		assert.deepEqual(got.map((m) => m.message.content), ["continue", "one"]);
		assert.equal(inbox.offer("m2", "two"), true, "the inbox is open again");
		await sleep(30);
		for (const m of got.slice(1)) second.observe(replay(m.uuid));
		second.observe(result);
		await done;
		assert.deepEqual(inbox.seen().sort(), ["m1", "m2"]);
		assert.deepEqual(inbox.finish(), []);
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
