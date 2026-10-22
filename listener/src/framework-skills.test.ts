/**
 * Contract tests for the framework-shipped runtime skills and how they reach
 * the agent container.
 *
 *   - bottom-line: routines with a material finding post a 2-4 line summary to
 *     the channel in BOTTOM_LINE_CHANNEL, details in a thread. The listener
 *     forwards the env var into the container; the entrypoint loads the skill
 *     (like `routines`) only when the channel is configured.
 *   - memory-curation: consolidation may merge rules but never delete one;
 *     after a correction the agent replies "נרשם: <the line>".
 *
 * Run: cd listener && npx tsc && node --test dist/framework-skills.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { bottomLineDockerEnv } from "./bottom-line";

const repoRoot = path.join(__dirname, "..", "..");
const skillsDir = path.join(repoRoot, "framework", "skills");
const read = (p: string) => readFileSync(path.join(repoRoot, p), "utf-8");

describe("bottom-line skill", () => {
	const skillPath = path.join(skillsDir, "bottom-line", "SKILL.md");

	test("ships as a framework skill with frontmatter", () => {
		assert.ok(existsSync(skillPath), "framework/skills/bottom-line/SKILL.md missing");
		const body = readFileSync(skillPath, "utf-8");
		assert.match(body, /^---\nname: bottom-line\n/);
	});

	test("names the configured channel via a placeholder, not a hard-coded one", () => {
		const body = readFileSync(skillPath, "utf-8");
		assert.ok(body.includes("{{BOTTOM_LINE_CHANNEL}}"));
		assert.doesNotMatch(body, /\bC0[A-Z0-9]{8,}\b/, "no hard-coded Slack channel id");
	});

	test("states the post shape: 2-4 lines, details in a thread, only on material findings", () => {
		const body = readFileSync(skillPath, "utf-8");
		assert.match(body, /2-4 lines/);
		assert.match(body, /thread/i);
		assert.match(body, /material/i);
	});

	test("entrypoint loads it like routines and fills the channel", () => {
		const ep = read("docker/entrypoint.mjs");
		assert.ok(ep.includes("/workspace/.framework/skills/bottom-line/SKILL.md"));
		assert.ok(ep.includes("BOTTOM_LINE_CHANNEL"));
		assert.ok(ep.includes("{{BOTTOM_LINE_CHANNEL}}"));
	});
});

describe("bottomLineDockerEnv", () => {
	test("forwards the channel when set", () => {
		assert.deepEqual(bottomLineDockerEnv({ BOTTOM_LINE_CHANNEL: "C123" }), [
			"-e",
			"BOTTOM_LINE_CHANNEL=C123",
		]);
	});

	test("trims whitespace", () => {
		assert.deepEqual(bottomLineDockerEnv({ BOTTOM_LINE_CHANNEL: "  #ops \n" }), [
			"-e",
			"BOTTOM_LINE_CHANNEL=#ops",
		]);
	});

	test("forwards nothing when unset or blank (skill stays off)", () => {
		assert.deepEqual(bottomLineDockerEnv({}), []);
		assert.deepEqual(bottomLineDockerEnv({ BOTTOM_LINE_CHANNEL: "   " }), []);
	});

	test("runner uses it", () => {
		assert.ok(read("listener/src/runner.ts").includes("bottomLineDockerEnv(process.env)"));
	});
});

describe("memory-curation: learned rules are never lost", () => {
	const skill = () => read("framework/skills/memory-curation/SKILL.md");
	const routine = () => read("framework/skills/memory-curation/consolidation-routine.md");

	test("after a correction the agent replies with the exact recorded line", () => {
		assert.ok(skill().includes("נרשם: <the line>"));
	});

	test("consolidation never deletes a rule, only merges", () => {
		const r = routine();
		assert.doesNotMatch(r, /Drop rules/i);
		assert.match(r, /never delete a rule/i);
		assert.match(skill(), /never delete/i);
	});

	test("consolidation checks every pre-existing rule survives before committing", () => {
		assert.match(routine(), /rules\.before/);
	});

	test("points to the consolidation procedure at the path that is actually mounted", () => {
		const p = "/workspace/.framework/skills/memory-curation/consolidation-routine.md";
		assert.ok(skill().includes(p));
		assert.ok(!skill().includes("/workspace/.shared/skills/memory-curation"));
	});
});
