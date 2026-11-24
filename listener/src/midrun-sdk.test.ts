/**
 * Mid-run messages against the real Claude program (sdk-harness.ts): the SDK version pinned for the
 * image and docker/midrun.mjs run a session against a fake model API, so every ordering below is
 * the program's own. Each test checks the one thing that matters: a message is handled exactly
 * once, inside the working run or as the next run.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";
import { MidRunInbox } from "./midrun-inbox";
import { containerMidrun, runSession, trace, type ModelRequest, type Reply } from "./sdk-harness";

const newInbox = () => new MidRunInbox<string>(mkdtempSync(path.join(os.tmpdir(), "midrun-sdk-")), "run");
const assistants = (events: any[]) => events.filter((e) => e.type === "assistant").length;
const toolResults = (events: any[]) => events.filter((e) => e.type === "user" && !e.isReplay).length;
/** How often the model was shown this text (once per request that carried it does not count: it looks for the replay events). */
const taken = (events: any[], text: string) => events.filter((e) => e.type === "user" && e.isReplay && e.message?.content === text).length;

// A model that keeps counting with one short command per turn, until it is told to stop.
const counter = (steps: number) => (r: ModelRequest): Reply =>
	r.userText.includes("STOP") ? { text: "stopped" } : r.toolResults < steps ? { bash: "sleep 0.3" } : { text: "counted" };

describe("mid-run messages with the real Claude program", { concurrency: false }, () => {
	test("arrives while the agent works: taken between two tool calls, in this run, once", async () => {
		const inbox = newInbox();
		let offered = false;
		const run = await runSession({
			inboxDir: inbox.dir, prompt: "count to 5", script: counter(5),
			onEvent: (_m, ev) => { if (!offered && assistants(ev) === 2) { offered = true; assert.equal(inbox.offer("stop", "STOP now"), true); } },
		});
		const t = trace(run.events);
		assert.equal(run.results.length, 1, t.join(" | "));
		assert.equal(taken(run.events, "STOP now"), 1);
		assert.ok(t.indexOf("replay:STOP now") < t.indexOf('assistant:"stopped"'));
		assert.ok(toolResults(run.events) < 5, "the count was cut short");
		assert.equal(inbox.offer("late", "after the run"), false, "the run closed its inbox");
		assert.deepEqual(inbox.finish(), [], "nothing left to run again");
	});

	test("lands as the run is ending: this run answers it in a follow-up turn", async () => {
		const inbox = newInbox();
		let offered = false;
		const run = await runSession({
			inboxDir: inbox.dir, prompt: "count to 1", script: counter(1),
			onEvent: (m) => { if (!offered && m.type === "assistant" && trace([m])[0] === 'assistant:"counted"') { offered = true; inbox.offer("stop", "STOP now"); } },
		});
		assert.deepEqual(run.results.map((r) => r.subtype), ["success", "success"], trace(run.events).join(" | "));
		assert.equal(taken(run.events, "STOP now"), 1);
		assert.deepEqual(inbox.finish(), []);
	});

	test("handed just before the run hits max turns: the program still answers it, so it is not run again", async () => {
		const inbox = newInbox();
		let offered = false;
		const run = await runSession({
			inboxDir: inbox.dir, prompt: "count to 5", maxTurns: 2,
			// The second answer takes a moment; the message is handed while the model is thinking,
			// after the program looked for waiting messages at the tool boundary.
			script: (r) => ({ ...counter(5)(r), delayMs: r.call === 2 ? 400 : 0 }),
			onEvent: (_m, ev) => { if (!offered && toolResults(ev) === 1) { offered = true; setTimeout(() => inbox.offer("stop", "STOP now"), 100); } },
		});
		const t = trace(run.events);
		assert.deepEqual(run.results.map((r) => r.subtype), ["error_max_turns", "success"], t.join(" | "));
		assert.equal(run.error, undefined, "the query ends normally after the answer, so the run is not reported as failed");
		assert.ok(t.indexOf("result:error_max_turns") < t.indexOf("replay:STOP now"), "taken after the error result");
		assert.equal(taken(run.events, "STOP now"), 1);
		assert.deepEqual(inbox.seen(), ["stop"], "its confirmation is recorded after the error result too");
		assert.deepEqual(inbox.finish(), [], "one delivery: not run again as a new run");
	});

	test("the run fails with nothing handed: it ends, and a later message waits in line", async () => {
		const inbox = newInbox();
		const run = await runSession({ inboxDir: inbox.dir, prompt: "count to 5", maxTurns: 1, script: counter(5) });
		assert.deepEqual(run.results.map((r) => r.subtype), ["error_max_turns"]);
		assert.equal(inbox.offer("late", "STOP now"), false);
		assert.deepEqual(inbox.finish(), []);
	});

	test("one turn budget for the whole run: once it is used up the inbox closes and later messages wait", async () => {
		const inbox = newInbox();
		const offers: boolean[] = [];
		const run = await runSession({
			inboxDir: inbox.dir, prompt: "hello", maxTurns: 2,
			script: (r) => ({ text: `answer ${r.call}` }),
			onEvent: (m, ev) => {
				if (m.type !== "assistant") return;
				if (assistants(ev) === 1) offers.push(inbox.offer("m1", "one more thing"));
				if (assistants(ev) === 2) offers.push(inbox.offer("m2", "and another"));
			},
		});
		assert.deepEqual(offers, [true, false], "the second follow-up is refused: budget of 2 turns used");
		assert.equal(assistants(run.events), 2, trace(run.events).join(" | "));
		assert.deepEqual(inbox.finish(), []);
	});

	test("at most N mid-run messages per run; the next one waits in line", async () => {
		const inbox = newInbox();
		const offers: boolean[] = [];
		const run = await runSession({
			inboxDir: inbox.dir, prompt: "count to 4", feed: { maxMessages: 2 },
			script: (r) => (r.toolResults < 4 ? { bash: "sleep 0.3" } : { text: "counted" }),
			onEvent: (m, ev) => { if (m.type === "assistant" && assistants(ev) <= 3) offers.push(inbox.offer(`m${assistants(ev)}`, `note ${assistants(ev)}`)); },
		});
		assert.deepEqual(offers, [true, true, false], trace(run.events).join(" | "));
		assert.equal(taken(run.events, "note 1") + taken(run.events, "note 2"), 2);
		assert.deepEqual(inbox.finish(), []);
	});

	test("a second try of the same run gets what the first try took but never showed the model", async () => {
		const { claim } = await containerMidrun();
		const inbox = newInbox();
		inbox.offer("m1", "STOP now");
		claim(inbox.dir); // the first container took it, then died
		const run = await runSession({ inboxDir: inbox.dir, prompt: "continue", script: counter(5) });
		assert.equal(taken(run.events, "STOP now"), 1);
		assert.deepEqual(inbox.finish(), []);
	});

	test("a retry that starts the request over gets the messages the dropped session had already seen", async () => {
		const inbox = newInbox();
		let offered = false;
		await runSession({
			inboxDir: inbox.dir, prompt: "hello", script: (r) => ({ text: `answer ${r.call}` }),
			onEvent: (m) => { if (!offered && m.type === "assistant") { offered = true; inbox.offer("m1", "one more thing"); } },
		});
		assert.deepEqual(inbox.seen(), ["m1"]);

		// From scratch (usage limit or API error before any tool call): a new session, the original request again.
		const again = await runSession({ inboxDir: inbox.dir, prompt: "hello", feed: { refeedSeen: true }, script: (r) => ({ text: `answer ${r.call}` }) });
		assert.equal(taken(again.events, "one more thing"), 1, "the new session gets it too");
		assert.deepEqual(inbox.finish(), []);
	});

	test("open-run wait: a message 3 s after the answer, inside a 10 s wait, is answered by the same run, once", async () => {
		const inbox = newInbox();
		let offeredAt = 0;
		const run = await runSession({
			inboxDir: inbox.dir, prompt: "hello", feed: { lingerMs: 10_000 },
			script: (r) => ({ text: r.userText.includes("one more thing") ? "answered the follow-up" : `answer ${r.call}` }),
			onEvent: (m) => { if (m.type === "result" && !offeredAt) { offeredAt = Date.now(); setTimeout(() => assert.equal(inbox.offer("m1", "one more thing"), true), 3000); } },
		});
		const t = trace(run.events);
		assert.deepEqual(run.results.map((r) => r.subtype), ["success", "success"], t.join(" | "));
		assert.equal(taken(run.events, "one more thing"), 1, "taken once by this run");
		assert.ok(t.includes('assistant:"answered the follow-up"'), t.join(" | "));
		assert.equal(inbox.offer("late", "after the run"), false, "the run closed its inbox when the second wait ran out");
		assert.deepEqual(inbox.finish(), [], "not run again as a new run");
	});

	test("open-run wait: with no message the run ends when the 10 s wait runs out", async () => {
		const inbox = newInbox();
		let answeredAt = 0;
		const run = await runSession({
			inboxDir: inbox.dir, prompt: "hello", feed: { lingerMs: 10_000 },
			script: (r) => ({ text: `answer ${r.call}` }),
			onEvent: (m) => { if (m.type === "result") answeredAt = Date.now(); },
		});
		const waited = Date.now() - answeredAt;
		assert.equal(run.results.length, 1, trace(run.events).join(" | "));
		assert.ok(waited >= 8000 && waited <= 12_000, `ended ${waited} ms after its answer`);
		assert.equal(inbox.offer("late", "after the run"), false);
		assert.deepEqual(inbox.finish(), []);
	});

	test("a retry that continues the same session does not get seen messages again", async () => {
		const { markSeen, claim } = await containerMidrun();
		const inbox = newInbox();
		inbox.offer("m1", "one more thing");
		markSeen(inbox.dir, claim(inbox.dir)[0].name); // the first try's session has it in its history
		const run = await runSession({ inboxDir: inbox.dir, prompt: "continue", script: (r) => ({ text: `answer ${r.call}` }) });
		assert.equal(taken(run.events, "one more thing"), 0);
		assert.deepEqual(inbox.finish(), []);
	});
});
