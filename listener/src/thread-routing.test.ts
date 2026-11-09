/**
 * Nitay 2026-11-09: "all involved agents in this thread should get the message
 * and decide if it is meant for them". Each agent has its own waiting line per
 * thread (a reply for Sally was swallowed into Adam's run when both shared one),
 * and an agent counts as involved when it posted in the thread or was mentioned.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ThreadDispatcher, agentInvolved, queueKey, THREAD_NOTE, withThreadNote } from "./thread-routing";

const ADAM = { name: "adam", slackBotId: "UADAM0001", slackBotMsgId: "BADAM0001" };
const SALLY = { name: "sally", slackBotId: "USALLY001", slackBotMsgId: "BSALLY001" };

type Msg = { agent: { name: string }; channel: string; threadTs: string; text: string };

describe("one waiting line per agent per thread", () => {
	test("queue keys differ per agent in the same thread", () => {
		assert.notEqual(queueKey("adam", "C1", "1.1"), queueKey("sally", "C1", "1.1"));
		assert.equal(queueKey("adam", "C1", "1.1"), queueKey("adam", "C1", "1.1"));
	});

	test("the 8/11 20:27 case: one human reply woke Adam and Sally; each runs with it", async () => {
		const runs: { agent: string; texts: string[] }[] = [];
		const d = new ThreadDispatcher<Msg>({
			debounceMs: 5,
			process: async (agentName, batch) => { runs.push({ agent: agentName, texts: batch.map((m) => m.text) }); },
		});
		d.enqueue({ agent: { name: "adam" }, channel: "C1", threadTs: "1.1", text: "מאושר, אל תחכי לי" });
		d.enqueue({ agent: { name: "sally" }, channel: "C1", threadTs: "1.1", text: "מאושר, אל תחכי לי" });
		await d.idle();
		runs.sort((a, b) => a.agent.localeCompare(b.agent));
		assert.deepEqual(runs, [
			{ agent: "adam", texts: ["מאושר, אל תחכי לי"] },
			{ agent: "sally", texts: ["מאושר, אל תחכי לי"] },
		]);
	});

	test("a busy agent does not hold another agent's message in the same thread", async () => {
		const order: string[] = [];
		let releaseAdam!: () => void;
		const adamBusy = new Promise<void>((r) => { releaseAdam = r; });
		const d = new ThreadDispatcher<Msg>({
			debounceMs: 5,
			process: async (agentName, batch) => {
				order.push(`${agentName}:start:${batch.map((m) => m.text).join("+")}`);
				if (agentName === "adam") await adamBusy;
				order.push(`${agentName}:end`);
			},
		});
		d.enqueue({ agent: { name: "adam" }, channel: "C1", threadTs: "1.1", text: "a1" });
		await new Promise((r) => setTimeout(r, 20)); // adam is now running
		d.enqueue({ agent: { name: "sally" }, channel: "C1", threadTs: "1.1", text: "s1" });
		d.enqueue({ agent: { name: "adam" }, channel: "C1", threadTs: "1.1", text: "a2" });
		await new Promise((r) => setTimeout(r, 20));
		assert.ok(order.includes("sally:start:s1"), "sally ran while adam was busy");
		assert.ok(order.includes("sally:end"));
		releaseAdam();
		await d.idle();
		assert.ok(order.includes("adam:start:a2"), "adam's second message waited for adam only, then ran");
		assert.equal(order.filter((o) => o.includes("s1")).length, 1, "sally's message ran once, as sally");
	});

	test("messages for one agent in a burst still batch into one run", async () => {
		const runs: string[][] = [];
		const d = new ThreadDispatcher<Msg>({ debounceMs: 10, process: async (_a, b) => { runs.push(b.map((m) => m.text)); } });
		d.enqueue({ agent: { name: "sally" }, channel: "C1", threadTs: "1.1", text: "one" });
		d.enqueue({ agent: { name: "sally" }, channel: "C1", threadTs: "1.1", text: "two" });
		await d.idle();
		assert.deepEqual(runs, [["one", "two"]]);
	});

	test("an error in one run does not stop the next run", async () => {
		const runs: string[] = [];
		const d = new ThreadDispatcher<Msg>({
			debounceMs: 2,
			process: async (_a, b) => { runs.push(b[0].text); if (b[0].text === "boom") throw new Error("x"); },
			onError: () => {},
		});
		d.enqueue({ agent: { name: "sally" }, channel: "C1", threadTs: "1.1", text: "boom" });
		await d.idle();
		d.enqueue({ agent: { name: "sally" }, channel: "C1", threadTs: "1.1", text: "after" });
		await d.idle();
		assert.deepEqual(runs, ["boom", "after"]);
	});
});

describe("who is involved in a thread", () => {
	const parentBySally = { bot_id: SALLY.slackBotMsgId, user: SALLY.slackBotId, ts: "1.1", text: "<@UADAM0001> for Nitay: ..." };
	test("the agent that started the thread", () => {
		assert.equal(agentInvolved([parentBySally], SALLY), true);
	});
	test("an agent mentioned in the thread", () => {
		assert.equal(agentInvolved([parentBySally], ADAM), true);
	});
	test("an agent that replied in the thread", () => {
		const reply = { bot_id: ADAM.slackBotMsgId, user: ADAM.slackBotId, ts: "1.2", thread_ts: "1.1", text: "טופל" };
		const parentByHuman = { user: "UHUMAN001", ts: "1.1", text: "hello" };
		assert.equal(agentInvolved([parentByHuman, reply], ADAM), true);
	});
	test("an agent that never posted and was never mentioned is not involved", () => {
		const omer = { name: "omer", slackBotId: "UOMER0001", slackBotMsgId: "BOMER0001" };
		assert.equal(agentInvolved([parentBySally], omer), false);
		assert.equal(agentInvolved([], omer), false);
	});
	test("a mention quoted inside code does not count", () => {
		const omer = { name: "omer", slackBotId: "UOMER0001", slackBotMsgId: "BOMER0001" };
		assert.equal(agentInvolved([{ user: "UHUMAN001", ts: "1.1", text: "see `<@UOMER0001>`" }], omer), false);
	});
});

describe("the agent is told it may stay silent", () => {
	test("the note says the message may be for someone else and silence is fine", () => {
		assert.match(THREAD_NOTE, /may be meant for another/i);
		assert.match(THREAD_NOTE, /post nothing/i);
		assert.equal(withThreadNote("hi"), `${THREAD_NOTE}\nhi`);
	});
});
