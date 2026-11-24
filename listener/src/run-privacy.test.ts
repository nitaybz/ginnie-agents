/**
 * A run's message can carry a customer's text, name and phone number. The
 * listener's own output (the pm2 log) and its failure file (run-failures.json,
 * posted to Slack after three failures in a row) must never carry it.
 *
 * These tests go through the REAL runAgent in a child node process, so every
 * line the listener code prints is captured, with a fake HOME, a PATH with no
 * docker (or a fake docker that fails) and a temporary failure file. No real
 * container is ever started.
 *
 * Run: cd listener && npx tsc && node --test dist/run-privacy.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BODY = "private customer text Dana +000-555-SECRET";

let root = "";
let agentDir = "";
let emptyBin = "";
let failBin = "";

before(() => {
	root = mkdtempSync(path.join(tmpdir(), "run-privacy-"));
	agentDir = path.join(root, "agent-a");
	mkdirSync(agentDir);
	writeFileSync(path.join(agentDir, "PROMPT.md"), "test agent");
	mkdirSync(path.join(root, "home"));
	emptyBin = path.join(root, "empty-bin");
	mkdirSync(emptyBin);
	failBin = path.join(root, "fail-bin");
	mkdirSync(failBin);
	// A docker that runs and fails: its result quotes the message, its stderr names an error.
	const fake = path.join(failBin, "docker");
	writeFileSync(fake, `#!/bin/sh\necho "docker: something broke" >&2\necho '{"session_id":"sess-x","is_error":true,"result":"the run failed on ${BODY}"}'\nexit 1\n`);
	chmodSync(fake, 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Run runAgent once in a child process; returns everything it printed and the failure file. */
function runOnce(opts: { bin: string; origin: string; tag: string }): { output: string; failures: Record<string, { lastError: string; count: number }> } {
	const failuresFile = path.join(root, `failures-${opts.tag}.json`);
	const script = `
		const { runAgent } = require(${JSON.stringify(path.join(__dirname, "runner.js"))});
		const agent = {
			name: "agent-a", dir: ${JSON.stringify(agentDir)}, slackBotId: "", slackBotMsgId: "", slackChannel: "",
			slackBotToken: "", slackAppToken: "", maxTurns: 5, allowedTools: ["Read"], boundaries: "write",
			workHours: { enabled: false, start: "09:00", end: "18:00", days: [], off_hours_behavior: "queue" },
			allowUnverifiedSenders: false, buttonTtlHours: 48,
		};
		runAgent(agent, ${JSON.stringify(BODY)}, ${JSON.stringify(opts.origin)})
			.then((r) => console.log("RUN-DONE isError=" + r.isError))
			.catch((e) => console.log("RUN-THREW code=" + (e && e.code)));
	`;
	const env: Record<string, string> = {
		PATH: opts.bin,
		HOME: path.join(root, "home"),
		GINNIE_RUN_FAILURES_FILE: failuresFile,
		TZ: "UTC",
	};
	const r = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 20_000 });
	const failures = existsSync(failuresFile) ? JSON.parse(readFileSync(failuresFile, "utf8")) : {};
	return { output: `${r.stdout}\n${r.stderr}`, failures };
}

describe("the message never reaches the listener's log or failure file", () => {
	test("docker missing (spawn ENOENT): the log names the error code only, never the container args", () => {
		for (const origin of ["conversation", "slack"]) {
			const { output, failures } = runOnce({ bin: emptyBin, origin, tag: `enoent-${origin}` });
			assert.match(output, /RUN-THREW code=ENOENT/, output);
			assert.match(output, /ENOENT/);
			assert.ok(!output.includes("SECRET"), `${origin}: the log leaks the message:\n${output}`);
			assert.ok(!output.includes("AGENT_MESSAGE"), `${origin}: the log prints the container env:\n${output}`);
			const lastError = failures["agent-a"]?.lastError ?? "";
			assert.match(lastError, /ENOENT/);
			assert.ok(!lastError.includes("SECRET"), `${origin}: the failure file leaks the message: ${lastError}`);
		}
	});

	test("a conversation run that fails: the failure file keeps the kind and lengths only, never the result text", () => {
		const { output, failures } = runOnce({ bin: failBin, origin: "conversation", tag: "fail-conv" });
		assert.match(output, /RUN-DONE isError=true/, output);
		const lastError = failures["agent-a"]?.lastError ?? "";
		assert.ok(lastError, "the failure is recorded");
		assert.ok(!lastError.includes("SECRET") && !lastError.includes("the run failed on"), `result text stored: ${lastError}`);
		assert.ok(!lastError.includes("something broke"), `stderr text stored: ${lastError}`);
		assert.match(lastError, /conversation run failed/);
		assert.match(lastError, /\d+ chars/);
		// The listener's own lines: nothing of the message. (The fake container's own stderr line passes through, as before.)
		assert.ok(!output.includes("SECRET"), `the log leaks the message:\n${output}`);
	});

	test("control: a Slack run that fails keeps today's failure text (the result line)", () => {
		const { failures } = runOnce({ bin: failBin, origin: "slack", tag: "fail-slack" });
		assert.match(failures["agent-a"]?.lastError ?? "", /the run failed on/);
	});
});
