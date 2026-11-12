/**
 * Wake inbox (Nitay 2026-11-12: "an order that comes in must be handled right away, an email too").
 * A host job (no model) drops <agent>/data/wake/<name>.json = {"id","message"}; the listener wakes
 * the agent once per file with that message, like a schedule fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, mkdirSync, utimesSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { takeWakeFiles } from "./wake-inbox";

const dir = () => { const d = path.join(mkdtempSync(path.join(tmpdir(), "wake-")), "wake"); mkdirSync(d); return d; };

test("a valid file is taken once and moved to done/", () => {
	const d = dir();
	writeFileSync(path.join(d, "orders-1.json"), JSON.stringify({ id: "orders-new", message: "[ROUTINE: orders] new paid order #1390" }));
	const first = takeWakeFiles(d);
	assert.deepEqual(first, [{ id: "orders-new", message: "[ROUTINE: orders] new paid order #1390", file: "orders-1.json" }]);
	assert.deepEqual(takeWakeFiles(d), [], "never twice");
	assert.ok(existsSync(path.join(d, "done", "orders-1.json")));
});

test("bad files are moved to rejected/ and never wake", () => {
	const d = dir();
	writeFileSync(path.join(d, "a.json"), "{not json");
	writeFileSync(path.join(d, "b.json"), JSON.stringify({ id: "x", message: "" }));
	writeFileSync(path.join(d, "c.json"), JSON.stringify({ id: "x", message: "y".repeat(30001) }));
	writeFileSync(path.join(d, "d.json"), JSON.stringify({ id: "bad id with spaces", message: "hi" }));
	assert.deepEqual(takeWakeFiles(d), []);
	assert.equal(readdirSync(path.join(d, "rejected")).length, 4);
});

test("half-written and hidden files are left for the next poll", () => {
	const d = dir();
	writeFileSync(path.join(d, ".tmp-orders.json"), JSON.stringify({ id: "orders-new", message: "m" }));
	writeFileSync(path.join(d, "orders.json.tmp"), JSON.stringify({ id: "orders-new", message: "m" }));
	assert.deepEqual(takeWakeFiles(d), []);
	assert.ok(existsSync(path.join(d, ".tmp-orders.json")));
});

test("several files are taken oldest first", () => {
	const d = dir();
	writeFileSync(path.join(d, "b.json"), JSON.stringify({ id: "mail-new", message: "second" }));
	writeFileSync(path.join(d, "a.json"), JSON.stringify({ id: "orders-new", message: "first" }));
	utimesSync(path.join(d, "a.json"), new Date(1000), new Date(1000));
	assert.deepEqual(takeWakeFiles(d).map((w) => w.message), ["first", "second"]);
});

test("a missing folder is simply nothing to do", () => {
	assert.deepEqual(takeWakeFiles(path.join(tmpdir(), "no-such-wake-dir-xyz")), []);
});
