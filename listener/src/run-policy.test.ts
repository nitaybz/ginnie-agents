/**
 * Repeat-action guards in the container entrypoint (docker/run-policy.mjs)
 * and the runner:
 *  - a continuation resume (after a usage limit) whose session is gone fails,
 *    it never starts over from scratch;
 *  - a transient API error after tool calls resumes the same session with a
 *    "continue, don't repeat" message instead of replaying the request.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";

const repoRoot = path.join(__dirname, "..", "..");
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
const mod = () => esmImport(require("node:url").pathToFileURL(path.join(repoRoot, "docker", "run-policy.mjs")).href);

const base = { error: "", sessionArg: undefined as string | undefined, strictResume: false, toolCalls: 0, sessionId: "", transientRetries: 0 };

describe("entrypoint run policy", () => {
	test("stale thread session with nothing done: start fresh (unchanged behaviour)", async () => {
		const { nextStep } = await mod();
		assert.deepEqual(nextStep({ ...base, sessionArg: "s1", error: "Error: No conversation found with session ID s1" }), { action: "fresh" });
	});

	test("continuation resume whose session is missing: fail, never fresh", async () => {
		const { nextStep } = await mod();
		const r = nextStep({ ...base, sessionArg: "s1", strictResume: true, error: "No conversation found with session ID s1" });
		assert.equal(r.action, "fail");
	});

	test("transient error before any tool call: plain retry", async () => {
		const { nextStep } = await mod();
		assert.deepEqual(nextStep({ ...base, error: "API Error: 529 overloaded" }), { action: "retry" });
	});

	test("transient error after tool calls: continue the same session, never replay", async () => {
		const { nextStep } = await mod();
		assert.deepEqual(
			nextStep({ ...base, error: "fetch failed", toolCalls: 3, sessionId: "s9" }),
			{ action: "continue", sessionId: "s9" },
		);
		assert.equal(nextStep({ ...base, error: "fetch failed", toolCalls: 3, sessionId: "" }).action, "fail");
	});

	test("the continued session missing later also fails", async () => {
		const { nextStep } = await mod();
		assert.equal(nextStep({ ...base, sessionArg: "s9", toolCalls: 3, error: "No conversation found" }).action, "fail");
	});

	test("retry budget and non-transient errors fail", async () => {
		const { nextStep, MAX_TRANSIENT_RETRIES } = await mod();
		assert.equal(nextStep({ ...base, error: "overloaded", transientRetries: MAX_TRANSIENT_RETRIES }).action, "fail");
		assert.equal(nextStep({ ...base, error: "invalid_request_error: bad shape" }).action, "fail");
	});

	test("entrypoint uses the policy and the strict-resume flag", () => {
		const src = readFileSync(path.join(repoRoot, "docker", "entrypoint.mjs"), "utf-8");
		assert.ok(src.includes('from "./run-policy.mjs"'));
		assert.ok(src.includes("RESUME_STRICT"));
		assert.ok(src.includes("CONTINUE_AFTER_ERROR_MESSAGE"));
		assert.ok(src.includes("nextStep("));
		assert.ok(!src.includes("expired, starting fresh"), "old unconditional fresh-start path is gone");
		const docker = readFileSync(path.join(repoRoot, "docker", "Dockerfile"), "utf-8");
		assert.ok(docker.includes("COPY docker/run-policy.mjs /app/run-policy.mjs"));
	});

	test("runner marks a limit continuation as strict resume", () => {
		const src = readFileSync(path.join(repoRoot, "listener", "src", "runner.ts"), "utf-8");
		assert.match(src, /RESUME_STRICT=1/);
	});
});
