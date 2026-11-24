/**
 * Run profiles: config.json "run_profiles" sets model, effort, preloaded
 * skills and the open-run wait per kind of run (for example a customer chat
 * versus everything else). The listener checks the profile when it loads the
 * agent and turns the chosen one into container env (profileEnv); the
 * entrypoint reads that env.
 *
 * Run: cd listener && npx tsc && node --test dist/run-profiles.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseRunProfiles, profileEnv, profileModel, type AgentConfig } from "./runner";

const repoRoot = path.join(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(repoRoot, p), "utf-8");

function agentWith(extra: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "agent-a",
		dir: "/tmp/agent-a",
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
		...extra,
	};
}

function loaded(raw: unknown) {
	const warnings: string[] = [];
	const profiles = parseRunProfiles(raw, (w) => warnings.push(w));
	return { profiles, warnings };
}

describe("parseRunProfiles", () => {
	test("keeps a valid profile", () => {
		const { profiles, warnings } = loaded({
			chat: { model: "m1", effort: "low", preload_skills: ["a", "b"], linger_minutes: 10, linger_max_open: 3 },
		});
		assert.deepEqual(warnings, []);
		assert.deepEqual(profiles, {
			chat: { model: "m1", effort: "low", preloadSkills: ["a", "b"], lingerMinutes: 10, lingerMaxOpen: 3 },
		});
	});

	test("max_running is kept; a bad one is dropped with a warning", () => {
		const ok = loaded({ chat: { max_running: 3 } });
		assert.deepEqual(ok.profiles, { chat: { maxRunning: 3 } });
		assert.deepEqual(ok.warnings, []);
		for (const bad of [0, -1, 2.5, "3"]) {
			const r = loaded({ chat: { max_running: bad } });
			assert.deepEqual(r.profiles, { chat: {} }, JSON.stringify(bad));
			assert.equal(r.warnings.length, 1);
			assert.match(r.warnings[0], /max_running/);
		}
	});

	test("missing run_profiles = none, no warning", () => {
		const { profiles, warnings } = loaded(undefined);
		assert.equal(profiles, undefined);
		assert.deepEqual(warnings, []);
	});

	test("a bad effort and a bad skill name are dropped with one warning", () => {
		const { profiles, warnings } = loaded({
			chat: { model: "m1", effort: "huge", preload_skills: ["a", "../x"] },
		});
		assert.deepEqual(profiles, { chat: { model: "m1", preloadSkills: ["a"] } });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /chat/);
		assert.match(warnings[0], /effort/);
		assert.match(warnings[0], /\.\.\/x/);
	});

	test("every allowed effort level is kept", () => {
		for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
			const { profiles, warnings } = loaded({ p: { effort } });
			assert.deepEqual(profiles, { p: { effort } });
			assert.deepEqual(warnings, []);
		}
	});

	test("bad linger values, a blank model and a non-object profile are dropped", () => {
		const { profiles, warnings } = loaded({
			chat: { model: "  ", linger_minutes: -1, linger_max_open: 1.5 },
			other: "fast",
		});
		assert.deepEqual(profiles, { chat: {} });
		assert.equal(warnings.length, 2);
	});

	test("run_profiles that is not an object is ignored with a warning", () => {
		const { profiles, warnings } = loaded(["chat"]);
		assert.equal(profiles, undefined);
		assert.equal(warnings.length, 1);
	});
});

describe("profileEnv", () => {
	const agent = agentWith({
		model: "base",
		runProfiles: { chat: { model: "m1", effort: "low", preloadSkills: ["a", "b"], lingerMinutes: 10 } },
	});

	test("a profile sets model, effort, preloaded skills and the open-run wait", () => {
		const env = profileEnv(agent, "chat");
		const pairs = [];
		for (let i = 0; i < env.length; i += 2) {
			assert.equal(env[i], "-e");
			pairs.push(env[i + 1]);
		}
		assert.deepEqual(pairs.sort(), [
			"AGENT_EFFORT=low",
			"AGENT_MODEL=m1",
			"MIDRUN_LINGER_MS=600000",
			"PRELOAD_SKILLS=a,b",
		]);
	});

	test("no profile gives only the agent's model", () => {
		assert.deepEqual(profileEnv(agent), ["-e", "AGENT_MODEL=base"]);
		assert.deepEqual(profileEnv(agentWith()), []);
	});

	test("an unknown profile name gives the agent defaults and no wait", () => {
		assert.deepEqual(profileEnv(agent, "nope"), ["-e", "AGENT_MODEL=base"]);
	});

	test("a profile without a model keeps the agent's model", () => {
		const a = agentWith({ model: "base", runProfiles: { chat: { effort: "medium" } } });
		assert.deepEqual(profileEnv(a, "chat"), ["-e", "AGENT_MODEL=base", "-e", "AGENT_EFFORT=medium"]);
	});

	test("profileModel picks the profile's model, else the agent's (used for account cooldowns)", () => {
		assert.equal(profileModel(agent, "chat"), "m1");
		assert.equal(profileModel(agent), "base");
		assert.equal(profileModel(agent, "nope"), "base");
		assert.equal(profileModel(agentWith()), undefined);
	});
});

describe("run profiles: wiring", () => {
	test("runner reads run_profiles and passes the profile through to the container env", () => {
		const src = read("listener/src/runner.ts");
		assert.ok(src.includes("parseRunProfiles(manifest.run_profiles"));
		assert.ok(src.includes("profileEnv(agent, profile)"));
		const params = (fn: string) => {
			const start = src.indexOf(`export async function ${fn}(`);
			return src.slice(start, src.indexOf("): Promise<AgentRunResult>", start));
		};
		assert.ok(params("runAgent").includes("profile?: string"));
		assert.ok(params("resumeAgent").includes("profile?: string"));
	});

	test("entrypoint passes the effort and preloads the named skills", () => {
		const ep = read("docker/entrypoint.mjs");
		assert.ok(ep.includes("effort: process.env.AGENT_EFFORT || undefined"));
		assert.ok(ep.includes("process.env.PRELOAD_SKILLS"));
		assert.ok(ep.includes("preloadSkills("));
		assert.ok(ep.includes("/workspace/skills/"));
	});
});
