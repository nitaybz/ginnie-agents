import test from "node:test";
import assert from "node:assert/strict";
import { deliveryInstruction } from "./studio-delivery";

test("a Slack turn gets no extra instruction", () => {
	assert.equal(deliveryInstruction("slack"), "");
});

test("a Studio turn is told where it is and how to answer", () => {
	const text = deliveryInstruction("studio");
	assert.match(text, /Ginnie Studio/);
	assert.match(text, /do not post/i);
	assert.match(text, /reply/i);
});

test("an unknown origin is treated as Slack, the safe default", () => {
	assert.equal(deliveryInstruction("something-else"), "");
});

test("a conversation run is told its answer goes out through its own tools, never Slack; no other origin gets that line", () => {
	const text = deliveryInstruction("conversation");
	assert.ok(text, "a conversation run gets an instruction");
	assert.match(text, /own tools/i);
	assert.match(text, /Slack/);
	assert.match(text, /never post/i);
	for (const origin of ["slack", "studio", "whatsapp", "something-else"]) {
		assert.notEqual(deliveryInstruction(origin), text, `${origin} must not get the conversation line`);
	}
	assert.ok(!/Ginnie Studio/.test(text) && !/WhatsApp/.test(text), "one generic line, not another origin's");
});

test("the conversation line does not forbid asking a person through the agent's own skills", () => {
	const text = deliveryInstruction("conversation");
	assert.doesNotMatch(text, /anywhere else/i, "a blanket ban would stop an agent's own ask-a-person step");
	assert.match(text, /answer/i);
	assert.match(text, /ask(ing)? .*(person|people|team)/i);
});
