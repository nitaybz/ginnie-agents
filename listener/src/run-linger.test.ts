/**
 * The open-run wait (MIDRUN_LINGER_MS) is for conversation runs only. The
 * listener reads a run's result only when its container exits, so a wait on
 * any other run (Slack, schedule, wake inbox, WhatsApp, /studio/run) would
 * hold up everything the listener does with that result. Those runs never get
 * it, even when the agent's profile has linger_minutes; a conversation run
 * asks for it with RunOptions { linger: true }.
 *
 * The end-to-end tests put a fake `docker` first on PATH that records its
 * arguments, so they see the exact container env a real run would get.
 *
 * Run: cd listener && npx tsc && node --test dist/run-linger.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentForRun, profileEnv, runAgent, resumeAgent, type AgentConfig } from "./runner";

const repoRoot = path.join(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(repoRoot, p), "utf-8");

function agentWith(dir: string, extra: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "agent-a",
		dir,
		slackBotId: "",
		slackBotMsgId: "",
		slackChannel: "",
		slackBotToken: "",
		slackAppToken: "",
		maxTurns: 50,
		allowedTools: ["Read"],
		boundaries: "write",
		workHours: { enabled: false, start: "09:00", end: "18:00", days: [], off_hours_behavior: "queue" },
		allowUnverifiedSenders: false,
		buttonTtlHours: 48,
		runProfiles: { chat: { model: "m1", effort: "low", lingerMinutes: 10 } },
		...extra,
	};
}

describe("agentForRun", () => {
	test("without linger: the run's profile keeps model and effort but has no open-run wait", () => {
		const agent = agentWith("/tmp/agent-a");
		const env = profileEnv(agentForRun(agent), "chat");
		assert.ok(env.includes("AGENT_MODEL=m1"));
		assert.ok(env.includes("AGENT_EFFORT=low"));
		assert.ok(!env.some((e) => e.startsWith("MIDRUN_LINGER_MS")));
		assert.ok(!profileEnv(agentForRun(agent, { linger: false }), "chat").some((e) => e.startsWith("MIDRUN_LINGER_MS")));
	});

	test("with linger: the profile's wait is passed", () => {
		const agent = agentWith("/tmp/agent-a");
		assert.ok(profileEnv(agentForRun(agent, { linger: true }), "chat").includes("MIDRUN_LINGER_MS=600000"));
	});

	test("never changes the loaded agent config", () => {
		const agent = agentWith("/tmp/agent-a");
		const before = JSON.stringify(agent);
		agentForRun(agent);
		agentForRun(agent, { linger: false });
		assert.equal(JSON.stringify(agent), before);
	});
});

describe("runAgent / resumeAgent: container env (fake docker)", () => {
	let bin = "";
	let argsFile = "";
	let agentDir = "";
	const savedPath = process.env.PATH;

	before(() => {
		bin = mkdtempSync(path.join(tmpdir(), "fake-docker-"));
		agentDir = mkdtempSync(path.join(tmpdir(), "agent-a-"));
		writeFileSync(path.join(agentDir, "PROMPT.md"), "test agent");
		argsFile = path.join(bin, "args.txt");
		const script = path.join(bin, "docker");
		writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argsFile}"\necho '{"session_id":"sess-x","is_error":false,"result":"ok"}'\n`);
		chmodSync(script, 0o755);
		process.env.PATH = `${bin}:${savedPath}`;
	});

	after(() => {
		process.env.PATH = savedPath;
		rmSync(bin, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	const lastArgs = () => {
		const lines = readFileSync(argsFile, "utf8").trim().split("\n");
		writeFileSync(argsFile, "");
		return lines;
	};

	test("Slack, schedule, wake-inbox, WhatsApp and /studio/run runs never get the wait, even with a lingering profile", async () => {
		const agent = agentWith(agentDir);
		for (const origin of ["slack", "whatsapp", "studio"]) {
			await runAgent(agent, "hi", origin, undefined, "chat");
			const a = lastArgs();
			assert.ok(a.includes("AGENT_MODEL=m1"), `${origin}: the profile is used`);
			assert.ok(!a.some((x) => x.startsWith("MIDRUN_LINGER_MS")), `${origin}: no open-run wait`);
			await resumeAgent(agent, "sess-1", "hi", origin, undefined, "chat");
			assert.ok(!lastArgs().some((x) => x.startsWith("MIDRUN_LINGER_MS")), `${origin} resume: no open-run wait`);
		}
	});

	test("a conversation run that asks for it gets the wait; one over the cap (linger false) does not", async () => {
		const agent = agentWith(agentDir);
		await runAgent(agent, "hi", "conversation", undefined, "chat", { linger: true });
		assert.ok(lastArgs().includes("MIDRUN_LINGER_MS=600000"));
		await resumeAgent(agent, "sess-1", "hi", "conversation", undefined, "chat", { linger: true });
		assert.ok(lastArgs().includes("MIDRUN_LINGER_MS=600000"));
		await runAgent(agent, "hi", "conversation", undefined, "chat", { linger: false });
		const a = lastArgs();
		assert.ok(!a.some((x) => x.startsWith("MIDRUN_LINGER_MS")));
		assert.ok(a.includes("AGENT_EFFORT=low"), "the over-the-cap run keeps the rest of its profile");
	});

	test("wiring: only the conversation route asks for the wait", () => {
		const idx = read("listener/src/index.ts");
		const bridge = read("listener/src/studio-bridge.ts");
		// The Slack line, schedule fires and wake-inbox files all run through processMessage;
		// WhatsApp wakes call runAgent directly. None of them passes RunOptions.
		for (const call of idx.match(/\b(runAgent|resumeAgent)\([^)]*\)/g) ?? []) {
			assert.ok(!/linger/.test(call), `index.ts call asks for the wait: ${call}`);
		}
		assert.ok(bridge.includes(`run(agent, message, "studio")`));
		assert.ok(bridge.includes(`resume(agent, sessionId, message, "studio")`));
		// The conversation route hands its own linger choice through.
		const conv = read("listener/src/conversation-runs.ts");
		assert.ok(/linger/.test(conv));
	});
});
