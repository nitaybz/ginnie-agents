/**
 * The open-run wait (lingering), unit level with a fake clock: after its answer a run can stay open
 * for more messages for a while (createFeed's lingerMs, the container's MIDRUN_LINGER_MS). A message
 * that arrives in that wait is handed to the same run; when the wait runs out with nothing new, the
 * run ends. The existing caps still close the inbox: the turn budget, the message cap, an error
 * result, and holdMs. The real-program version of these is in midrun-sdk.test.ts.
 */
import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { MidRunInbox } from "./midrun-inbox";

const repoRoot = path.join(__dirname, "..", "..");
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
const container = () => esmImport(require("node:url").pathToFileURL(path.join(repoRoot, "docker", "midrun.mjs")).href);

const flush = () => new Promise((r) => setImmediate(r));
const assistant = (id: string) => ({ type: "assistant", parent_tool_use_id: null, message: { id, content: [] } });
const result = (is_error = false) => ({ type: "result", is_error });

/** A feed on a fake clock, its input read the way the Claude program reads it. */
async function start(t: TestContext, opts: Record<string, unknown>) {
	const { createFeed } = await container();
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 0 });
	const inbox = new MidRunInbox<string>(mkdtempSync(path.join(os.tmpdir(), "midrun-feed-")), "run");
	const feed = createFeed(inbox.dir, "task", { pollMs: 1000, ...opts });
	const got: any[] = [];
	let ended = false;
	(async () => { for await (const m of feed.input) got.push(m); ended = true; })();
	await flush();
	const tick = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
	/** The program takes a handed message (confirms it) and starts a turn on it. */
	const takeLast = (turnId: string) => {
		feed.observe({ type: "user", isReplay: true, uuid: got[got.length - 1].uuid });
		feed.observe(assistant(turnId));
	};
	return { feed, inbox, got, tick, takeLast, ended: () => ended };
}

describe("open-run wait (lingerMs)", () => {
	test("lingerMs 0 keeps today's behavior: the input ends at the result", async (t) => {
		const f = await start(t, {});
		f.feed.observe(assistant("a1"));
		f.feed.observe(result());
		await flush();
		assert.equal(f.ended(), true);
		assert.equal(f.inbox.offer("late", "after the answer"), false, "inbox closed");
	});

	test("a message 3 s after the answer, inside a 10 s wait, is handed to the same run; the wait restarts after that turn", async (t) => {
		const f = await start(t, { lingerMs: 10_000 });
		f.feed.observe(assistant("a1"));
		f.feed.observe(result());
		await f.tick(3000);
		assert.equal(f.ended(), false, "still open 3 s after the answer");
		assert.equal(f.inbox.offer("m1", "one more thing"), true);
		await f.tick(1000);
		assert.equal(f.got.length, 2, "handed over");
		assert.equal(f.got[1].message.content, "one more thing");
		f.takeLast("a2");
		f.feed.observe(result());
		await f.tick(9000);
		assert.equal(f.ended(), false, "a new 10 s wait after the second answer");
		await f.tick(2000);
		assert.equal(f.ended(), true, "ends when that wait runs out");
		assert.equal(f.inbox.offer("late", "too late"), false);
		assert.deepEqual(f.inbox.finish(), [], "the handed message was seen: not run again");
	});

	test("no message: the input ends when the wait runs out, and the inbox closes", async (t) => {
		const f = await start(t, { lingerMs: 10_000 });
		f.feed.observe(assistant("a1"));
		f.feed.observe(result());
		await f.tick(9000);
		assert.equal(f.ended(), false);
		await f.tick(2000);
		assert.equal(f.ended(), true);
		assert.equal(f.inbox.offer("late", "after the wait"), false);
	});

	test("turn budget used up during the wait closes the inbox and ends the run", async (t) => {
		const f = await start(t, { lingerMs: 10_000, maxTurns: 2 });
		f.feed.observe(assistant("a1"));
		f.feed.observe(result());
		await f.tick(3000);
		assert.equal(f.inbox.offer("m1", "one more thing"), true);
		await f.tick(1000);
		f.takeLast("a2");
		assert.equal(f.inbox.offer("m2", "and another"), false, "budget of 2 turns used: the inbox closed");
		f.feed.observe(result());
		await flush();
		assert.equal(f.ended(), true, "no wait after the last turn of the budget");
		assert.deepEqual(f.inbox.finish(), []);
	});

	test("the mid-run message cap reached during the wait: no further wait", async (t) => {
		const f = await start(t, { lingerMs: 10_000, maxMessages: 1 });
		f.feed.observe(assistant("a1"));
		f.feed.observe(result());
		await f.tick(2000);
		f.inbox.offer("m1", "one more thing");
		await f.tick(1000);
		assert.equal(f.inbox.offer("m2", "and another"), false, "cap of 1 reached");
		f.takeLast("a2");
		f.feed.observe(result());
		await flush();
		assert.equal(f.ended(), true);
	});

	test("an error result does not wait", async (t) => {
		const f = await start(t, { lingerMs: 10_000 });
		f.feed.observe(assistant("a1"));
		f.feed.observe(result(true));
		await flush();
		assert.equal(f.ended(), true);
	});

	test("holdMs caps the wait", async (t) => {
		const f = await start(t, { lingerMs: 10_000, holdMs: 4000 });
		f.feed.observe(assistant("a1"));
		f.feed.observe(result());
		await f.tick(3000);
		assert.equal(f.ended(), false);
		await f.tick(2000);
		assert.equal(f.ended(), true);
	});

	test("a message taken just before the wait runs out keeps the run open while the model works on it", async (t) => {
		const f = await start(t, { lingerMs: 10_000, pollMs: 500 });
		f.feed.observe(assistant("a1"));
		f.feed.observe(result());
		await f.tick(9200);
		assert.equal(f.inbox.offer("m1", "one more thing"), true);
		await f.tick(300); // 9.5 s: handed
		assert.equal(f.got.length, 2, "handed at 9.5 s");
		f.feed.observe({ type: "user", isReplay: true, uuid: f.got[1].uuid }); // the program takes it; its answer starts later
		await f.tick(1500); // 11 s: the first wait has passed, the model is still thinking
		assert.equal(f.ended(), false, "input still open while the model works on the taken message");
		assert.equal(f.inbox.offer("m2", "and another"), true, "a second message at 11 s still reaches this run");
		await f.tick(500); // 11.5 s: handed
		assert.equal(f.got.length, 3);
		await f.tick(500); // 12 s: the model's first output on m1
		f.feed.observe(assistant("a2"));
		f.feed.observe({ type: "user", isReplay: true, uuid: f.got[2].uuid });
		f.feed.observe(result());
		await f.tick(9000);
		assert.equal(f.ended(), false, "the wait restarts after that turn's result");
		await f.tick(1500);
		assert.equal(f.ended(), true, "and ends when it runs out");
		assert.deepEqual(f.inbox.finish(), [], "both messages seen by this run: none run again");
	});

	test("background work still running at the answer holds the run past the wait; it ends once that work is done and the wait has passed", async (t) => {
		const f = await start(t, { lingerMs: 5000, graceMs: 1000 });
		f.feed.observe(assistant("a1"));
		f.feed.observe({ type: "system", subtype: "background_tasks_changed", tasks: [{ id: "b1" }] });
		f.feed.observe(result());
		await f.tick(7000);
		assert.equal(f.ended(), false, "held by the background work after the 5 s wait");
		assert.equal(f.inbox.offer("m0", "probe"), true, "still taking messages");
		await f.tick(1000); // 8 s: handed; the program takes it and answers
		f.takeLast("a2");
		f.feed.observe({ type: "system", subtype: "background_tasks_changed", tasks: [] });
		f.feed.observe(result());
		await f.tick(4000);
		assert.equal(f.ended(), false, "a new 5 s wait after that answer");
		await f.tick(2000);
		assert.equal(f.ended(), true, "background done, grace and wait passed: the run ends");
		assert.deepEqual(f.inbox.finish(), []);
	});
});

describe("open-run wait setting (MIDRUN_LINGER_MS)", () => {
	test("above 60 minutes is treated as 60 minutes", async () => {
		const { lingerMsFor, MAX_LINGER_MS } = await container();
		assert.equal(MAX_LINGER_MS, 60 * 60_000);
		assert.equal(lingerMsFor(String(2 * 3600_000), true), 60 * 60_000);
		assert.equal(lingerMsFor(String(10 * 60_000), true), 10 * 60_000);
	});

	test("non-numeric, negative, empty or unset is 0 (no wait)", async () => {
		const { lingerMsFor } = await container();
		for (const raw of ["abc", "-5000", "", undefined, "NaN", "Infinity", "1e400"]) assert.equal(lingerMsFor(raw, true), 0, String(raw));
	});

	test("a run with no mid-run inbox (no MIDRUN_DIR, or the feed is off) does not wait", async () => {
		const { lingerMsFor } = await container();
		assert.equal(lingerMsFor("600000", false), 0);
	});

	test("entrypoint: the wait is read after the feed check and passed to the feed only", () => {
		const ep = readFileSync(path.join(repoRoot, "docker", "entrypoint.mjs"), "utf8");
		const check = ep.indexOf("feedSupport(");
		const read = ep.indexOf("lingerMsFor(process.env.MIDRUN_LINGER_MS, !!midrunDir)");
		assert.ok(check > 0 && read > check, "computed after the feed check, which clears midrunDir when the feed is off");
		assert.match(ep, /createFeed\(midrunDir, prompt, \{[^}]*\blingerMs\b/);
		assert.match(ep, /prompt: feed \? feed\.input : prompt/, "no feed: a plain prompt, the run ends at its result");
	});
});
