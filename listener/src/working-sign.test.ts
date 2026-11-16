/**
 * The working sign (Nitay 2026-11-16: "I don't always see when she is working"): shown the moment
 * a message is accepted, kept up for the whole run, taken down on every way out.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RECEIVED, THINKING, WORKING, WorkingSign, type SignApi, type SignMessage } from "./working-sign";

const TS1 = "1700000000.000100";
const TS2 = "1700000000.000200";
const msg = (messageTs: string, extra: Partial<SignMessage> = {}): SignMessage =>
	({ agent: { name: "sally" }, channel: "C1", threadTs: TS1, messageTs, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fake(fail: { react?: string; status?: string } = {}) {
	const calls: string[] = [];
	const logs: string[] = [];
	const api: SignApi = {
		status: async (_a, _c, _t, text) => {
			calls.push(`status:${text || "clear"}`);
			if (fail.status) throw Object.assign(new Error("x"), { data: { error: fail.status } });
		},
		react: async (_a, _c, ts, emoji, add) => {
			calls.push(`${add ? "+" : "-"}${emoji}@${ts.slice(-3)}`);
			if (fail.react) throw Object.assign(new Error("x"), { data: { error: fail.react } });
		},
	};
	const sign = new WorkingSign(api, { heartbeatMs: 10, clearDelayMs: 1, log: (l) => logs.push(l) });
	// Reactions currently on each message, replayed from the calls.
	const reactions = () => {
		const on = new Set<string>();
		for (const c of calls) {
			if (c.startsWith("+")) on.add(c.slice(1));
			if (c.startsWith("-")) on.delete(c.slice(1));
		}
		return [...on].sort();
	};
	const lastStatus = () => calls.filter((c) => c.startsWith("status:")).pop();
	return { sign, calls, logs, reactions, lastStatus };
}

describe("working sign", () => {
	test("on receipt: reaction and status at once, before any run", async () => {
		const f = fake();
		f.sign.received(msg(TS1));
		await sleep(5);
		assert.deepEqual(f.calls.sort(), [`+${RECEIVED}@100`, `status:${THINKING}`].sort());
	});

	test("success: working reaction during the run, status re-set while it runs, all cleared after", async () => {
		const f = fake();
		f.sign.received(msg(TS1));
		const out = await f.sign.during([msg(TS1)], async () => {
			await sleep(45);
			assert.deepEqual(f.reactions(), [`${WORKING}@100`]);
			return "ok";
		});
		await sleep(5);
		assert.equal(out, "ok");
		assert.ok(f.calls.filter((c) => c === `status:${THINKING}`).length >= 4, "received + start + heartbeats");
		assert.deepEqual(f.reactions(), []);
		assert.equal(f.lastStatus(), "status:clear");
	});

	test("the run throws: still cleared, and the error is passed on", async () => {
		const f = fake();
		f.sign.received(msg(TS1));
		await assert.rejects(f.sign.during([msg(TS1)], async () => { throw new Error("container failed"); }), /container failed/);
		await sleep(5);
		assert.deepEqual(f.reactions(), []);
		assert.equal(f.lastStatus(), "status:clear");
	});

	test("the run ends with an error result or a usage limit (resolves): cleared the same way", async () => {
		const f = fake();
		f.sign.received(msg(TS1));
		await f.sign.during([msg(TS1)], async () => ({ isError: true, limitHit: true }));
		await sleep(5);
		assert.deepEqual(f.reactions(), []);
		assert.equal(f.lastStatus(), "status:clear");
	});

	test("a batch: every message in it carries the sign and loses it", async () => {
		const f = fake();
		f.sign.received(msg(TS1));
		f.sign.received(msg(TS2));
		await f.sign.during([msg(TS1), msg(TS2)], async () => {
			await sleep(5);
			assert.deepEqual(f.reactions(), [`${WORKING}@100`, `${WORKING}@200`]);
		});
		await sleep(5);
		assert.deepEqual(f.reactions(), []);
	});

	test("mid-run message: received on arrival, working once the run took it, cleared when the run ends", async () => {
		const f = fake();
		const picked: SignMessage[] = [];
		await f.sign.during([msg(TS1)], async () => {
			f.sign.received(msg(TS2));
			await sleep(15);
			assert.deepEqual(f.reactions(), [`${RECEIVED}@200`, `${WORKING}@100`], "arrived, not taken yet");
			picked.push(msg(TS2));
			await sleep(25);
			assert.deepEqual(f.reactions(), [`${WORKING}@100`, `${WORKING}@200`], "the run took it");
		}, () => picked);
		await sleep(5);
		assert.deepEqual(f.reactions(), []);
	});

	test("a message that waits for the next run keeps its received reaction", async () => {
		const f = fake();
		await f.sign.during([msg(TS1)], async () => { f.sign.received(msg(TS2)); await sleep(5); });
		await sleep(5);
		assert.deepEqual(f.reactions(), [`${RECEIVED}@200`]);
		await f.sign.during([msg(TS2)], async () => {});
		await sleep(5);
		assert.deepEqual(f.reactions(), []);
	});

	test("quiet run (not mentioned, may stay silent): reaction only, no status", async () => {
		const f = fake();
		f.sign.received(msg(TS1, { quiet: true }));
		await f.sign.during([msg(TS1, { quiet: true })], async () => { await sleep(25); });
		await sleep(5);
		assert.equal(f.calls.some((c) => c.startsWith("status:")), false);
		assert.deepEqual(f.calls, [`+${RECEIVED}@100`, `-${RECEIVED}@100`, `+${WORKING}@100`, `-${WORKING}@100`]);
	});

	test("a quiet run takes in a mention mid-run: the status that message raised is kept up and cleared at the end", async () => {
		const f = fake();
		const picked: SignMessage[] = [];
		f.sign.received(msg(TS1, { quiet: true }));
		await f.sign.during([msg(TS1, { quiet: true })], async () => {
			f.sign.received(msg(TS2)); // mentions the agent: raises "is thinking"
			picked.push(msg(TS2));
			await sleep(35);
			assert.ok(f.calls.filter((c) => c === `status:${THINKING}`).length >= 3, "re-set while the run works");
		}, () => picked);
		await sleep(5);
		assert.equal(f.lastStatus(), "status:clear");
		assert.deepEqual(f.reactions(), []);
	});

	test("bot without reactions:write: no reactions, said once, status and run unaffected", async () => {
		const f = fake({ react: "missing_scope" });
		f.sign.received(msg(TS1));
		f.sign.received(msg(TS2));
		const out = await f.sign.during([msg(TS1), msg(TS2)], async () => { await sleep(25); return 7; });
		await sleep(5);
		assert.equal(out, 7);
		assert.equal(f.calls.filter((c) => !c.startsWith("status:")).length <= 2, true, "stops trying after the refusal");
		assert.equal(f.logs.filter((l) => l.includes("reactions:write")).length, 1);
		assert.equal(f.lastStatus(), "status:clear");
	});

	test("status refused by Slack: logged once, the run still completes and reactions still work", async () => {
		const f = fake({ status: "method_not_supported_for_channel_type" });
		f.sign.received(msg(TS1));
		await f.sign.during([msg(TS1)], async () => { await sleep(35); });
		await sleep(5);
		assert.equal(f.logs.length, 1);
		assert.deepEqual(f.reactions(), []);
	});

	test("scheduled run (no Slack message or thread): no Slack calls at all", async () => {
		const f = fake();
		const scheduled = msg("scheduled_daily_1700000000000", { threadTs: "scheduled_daily_1700000000000" });
		f.sign.received(scheduled);
		await f.sign.during([scheduled], async () => { await sleep(15); });
		await sleep(5);
		assert.deepEqual(f.calls, []);
	});
});
