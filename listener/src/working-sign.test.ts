/**
 * The working sign (Nitay 2026-11-16: "I don't always see when she is working"): shown the moment
 * a message is accepted, kept up for the whole run, taken down on every way out.
 *
 * Since 2026-11-23 the sign is Slack's "is thinking…" status only, the way Sasha shows it (Nitay:
 * "why did Gadi react with an eyes emoji? ... the hourglass is the old method"). No reactions.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { THINKING, WorkingSign, type SignApi, type SignMessage } from "./working-sign";

const TS1 = "1700000000.000100";
const TS2 = "1700000000.000200";
const msg = (messageTs: string, extra: Partial<SignMessage> = {}): SignMessage =>
	({ agent: { name: "sally" }, channel: "C1", threadTs: TS1, messageTs, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fake(fail: { status?: string } = {}, clearDelayMs = 1) {
	const calls: string[] = [];
	const logs: string[] = [];
	const api: SignApi = {
		status: async (_a, _c, _t, text) => {
			calls.push(`status:${text || "clear"}`);
			if (fail.status) throw Object.assign(new Error("x"), { data: { error: fail.status } });
		},
	};
	// Anything else the sign might call on Slack (a reaction) is recorded too, so a test sees it.
	const spy = new Proxy(api, {
		get: (t, k) => (k in t ? (t as any)[k] : async (...args: unknown[]) => { calls.push(`other:${String(k)}:${JSON.stringify(args)}`); }),
	});
	const sign = new WorkingSign(spy, { heartbeatMs: 10, clearDelayMs, log: (l) => logs.push(l) });
	const lastStatus = () => calls.filter((c) => c.startsWith("status:")).pop();
	const others = () => calls.filter((c) => !c.startsWith("status:"));
	return { sign, calls, logs, lastStatus, others };
}

describe("working sign", () => {
	test("on receipt: the status at once, before any run, and no reaction", async () => {
		const f = fake();
		f.sign.received(msg(TS1));
		await sleep(5);
		assert.deepEqual(f.calls, [`status:${THINKING}`]);
	});

	test("success: status re-set while the run works, cleared after, never a reaction", async () => {
		const f = fake();
		f.sign.received(msg(TS1));
		const out = await f.sign.during([msg(TS1)], async () => { await sleep(45); return "ok"; });
		await sleep(5);
		assert.equal(out, "ok");
		assert.ok(f.calls.filter((c) => c === `status:${THINKING}`).length >= 4, "received + start + heartbeats");
		assert.equal(f.lastStatus(), "status:clear");
		assert.deepEqual(f.others(), []);
	});

	test("the run throws: still cleared, and the error is passed on", async () => {
		const f = fake();
		f.sign.received(msg(TS1));
		await assert.rejects(f.sign.during([msg(TS1)], async () => { throw new Error("container failed"); }), /container failed/);
		await sleep(5);
		assert.equal(f.lastStatus(), "status:clear");
	});

	test("the run ends with an error result or a usage limit (resolves): cleared the same way", async () => {
		const f = fake();
		f.sign.received(msg(TS1));
		await f.sign.during([msg(TS1)], async () => ({ isError: true, limitHit: true }));
		await sleep(5);
		assert.equal(f.lastStatus(), "status:clear");
	});

	test("a mid-run message keeps the status up until the run ends, no reaction on it", async () => {
		const f = fake();
		const picked: SignMessage[] = [];
		await f.sign.during([msg(TS1)], async () => {
			f.sign.received(msg(TS2));
			picked.push(msg(TS2));
			const before = f.calls.length;
			await sleep(35);
			assert.ok(f.calls.slice(before).filter((c) => c === `status:${THINKING}`).length >= 2, "still re-set");
		});
		await sleep(5);
		assert.equal(f.lastStatus(), "status:clear");
		assert.deepEqual(f.others(), []);
	});

	test("quiet run (woken by another agent, may stay silent): no Slack calls at all", async () => {
		const f = fake();
		f.sign.received(msg(TS1, { quiet: true }));
		await f.sign.during([msg(TS1, { quiet: true })], async () => { await sleep(25); });
		await sleep(5);
		assert.deepEqual(f.calls, []);
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
		});
		await sleep(5);
		assert.equal(f.lastStatus(), "status:clear");
		assert.deepEqual(f.others(), []);
	});

	test("a person's message that arrives while the ending run waits to clear keeps the status up for the next run", async () => {
		const f = fake({}, 30);
		f.sign.received(msg(TS1));
		const ending = f.sign.during([msg(TS1)], async () => { await sleep(5); });
		await sleep(15); // the run is over, the sign waits to clear
		f.sign.received(msg(TS2));
		await ending;
		await sleep(5);
		assert.equal(f.lastStatus(), `status:${THINKING}`, "not cleared under the new message");
	});

	test("status refused by Slack: logged once, the run still completes", async () => {
		const f = fake({ status: "method_not_supported_for_channel_type" });
		f.sign.received(msg(TS1));
		const out = await f.sign.during([msg(TS1)], async () => { await sleep(35); return 7; });
		await sleep(5);
		assert.equal(out, 7);
		assert.equal(f.logs.length, 1);
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
