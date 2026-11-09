/**
 * Review r1 (2026-11-09): with two agents in one thread, each run overwrote the
 * other agent's saved session, so both kept starting fresh. Sessions are kept
 * per agent per thread now.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const dir = mkdtempSync(path.join(tmpdir(), "thread-store-"));
process.env.GINNIE_THREAD_STORE = path.join(dir, "threads.json");

import { loadStore, getThread, setThread } from "./store";

test("two agents in one thread keep their own sessions", () => {
	loadStore();
	setThread("C1", "1.1", "sess-adam", "adam");
	setThread("C1", "1.1", "sess-sally", "sally");
	assert.equal(getThread("adam", "C1", "1.1")?.sessionId, "sess-adam");
	assert.equal(getThread("sally", "C1", "1.1")?.sessionId, "sess-sally");
	assert.equal(getThread("omer", "C1", "1.1"), undefined);
});

test("an entry saved before this change still resumes for its own agent only", () => {
	writeFileSync(process.env.GINNIE_THREAD_STORE!, JSON.stringify({
		"C2:2.2": { sessionId: "old-sally", agentName: "sally", createdAt: Date.now() },
	}));
	loadStore();
	assert.equal(getThread("sally", "C2", "2.2")?.sessionId, "old-sally");
	assert.equal(getThread("adam", "C2", "2.2"), undefined);
	setThread("C2", "2.2", "new-adam", "adam");
	assert.equal(getThread("sally", "C2", "2.2")?.sessionId, "old-sally", "adam's run does not erase sally's");
});
