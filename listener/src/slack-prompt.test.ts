import test from "node:test";
import assert from "node:assert/strict";
import { buildSlackPrompt, scheduledThreadKey } from "./slack-prompt";

test("a scheduled run is not told to reply in a thread that does not exist", () => {
	const threadTs = scheduledThreadKey("wp-plugins-2026-10-28", 1793197800669);
	const p = buildSlackPrompt({ channel: "C123", threadTs, message: "do the thing" });
	assert.ok(!p.includes(threadTs), "synthetic scheduler id must not reach the agent");
	assert.ok(!/thread scheduled_/.test(p));
	assert.ok(!/Reply in Slack channel C123, thread/.test(p));
	assert.match(p, /top-level message in channel C123/);
	assert.match(p, /do the thing/);
});

test("a scheduled run that somehow resumes still gets no fake thread", () => {
	const threadTs = scheduledThreadKey("orders", 1);
	const p = buildSlackPrompt({ channel: "C1", threadTs, message: "m", resumed: true });
	assert.ok(!p.includes(threadTs));
});

test("a real Slack message keeps its thread reply instruction", () => {
	const p = buildSlackPrompt({ channel: "C9", threadTs: "1793197800.669000", message: "hi", threadContext: "\n\nctx\n\n" });
	assert.equal(p, "Slack message (channel: C9, thread: 1793197800.669000):\n\nctx\n\n\n\nhi\n\nReply in Slack channel C9, thread 1793197800.669000.");
});

test("a real Slack thread reply on a resumed session keeps its format", () => {
	const p = buildSlackPrompt({ channel: "C9", threadTs: "1.2", message: "hi", resumed: true });
	assert.equal(p, "Slack reply (channel: C9, thread: 1.2):\n\nhi\n\nReply in Slack channel C9, thread 1.2.");
});

test("the scheduler key is unique per fire and never looks like a Slack ts", () => {
	const k = scheduledThreadKey("x", 5);
	assert.equal(k, "scheduled_x_5");
	assert.ok(!/^\d+\.\d+$/.test(k));
});
