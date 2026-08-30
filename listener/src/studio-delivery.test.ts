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
