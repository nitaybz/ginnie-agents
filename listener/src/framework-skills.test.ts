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
		assert.ok(ep.includes("process.env.BOTTOM_LINE_CHANNEL"));
		assert.ok(read("docker/prompt-skills.mjs").includes("{{BOTTOM_LINE_CHANNEL}}"));
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

describe("bottom-line: triggers on scheduler turns (review B1)", () => {
	const body = () => readFileSync(path.join(skillsDir, "bottom-line", "SKILL.md"), "utf-8");

	test("the listener frames scheduled turns with the sender line the skill keys on", () => {
		assert.ok(read("listener/src/index.ts").includes("From: scheduler | role: system | schedule_id: ${entry.id}"));
	});

	test("the skill keys on the scheduler sender line and schedule_id, not only on [ROUTINE: <id>]", () => {
		const scope = body().split("\n").find((l) => /applies only to/i.test(l)) || "";
		assert.ok(scope.includes("From: scheduler"), `scope line must name the scheduler sender line: ${scope}`);
		assert.ok(body().includes("schedule_id"));
	});
});

describe("bottom-line: posting guard (review minor)", () => {
	const body = () => readFileSync(path.join(skillsDir, "bottom-line", "SKILL.md"), "utf-8");

	test("only posts the thread reply when the first post returned a ts", () => {
		assert.ok(body().includes(".ts // empty"));
		assert.match(body(), /if \[ -z "\$TS" \]/);
	});

	test("at most once per day per schedule_id unless the finding changed", () => {
		const b = body();
		assert.ok(b.includes("date +%F"));
		assert.ok(b.includes("$SCHEDULE_ID"));
		assert.ok(b.includes("grep -qxF"));
	});
});

describe("bottom-line: prompt assembly includes the skill only when configured", () => {
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
	const mod = () => esmImport(require("node:url").pathToFileURL(path.join(repoRoot, "docker", "prompt-skills.mjs")).href);
	const template = () => readFileSync(path.join(skillsDir, "bottom-line", "SKILL.md"), "utf-8");

	test("included, channel filled, when BOTTOM_LINE_CHANNEL is set", async () => {
		const { bottomLineSkill } = await mod();
		const out = bottomLineSkill(template(), "C0TEST");
		assert.ok(out && out.includes("name: bottom-line"));
		assert.ok(out.includes("C0TEST"));
		assert.ok(!out.includes("{{BOTTOM_LINE_CHANNEL}}"));
	});

	test("absent when blank or unset, or when the skill file is missing", async () => {
		const { bottomLineSkill } = await mod();
		assert.equal(bottomLineSkill(template(), ""), null);
		assert.equal(bottomLineSkill(template(), "   "), null);
		assert.equal(bottomLineSkill(template(), undefined), null);
		assert.equal(bottomLineSkill(null, "C0TEST"), null);
	});

	test("entrypoint uses it and the image ships it", () => {
		assert.ok(read("docker/entrypoint.mjs").includes("bottomLineSkill("));
		assert.ok(read("docker/Dockerfile").includes("COPY docker/prompt-skills.mjs /app/prompt-skills.mjs"));
	});
});

describe("consolidation: rules survival check fails closed (review B3)", () => {
	const { spawnSync } = require("node:child_process");
	const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
	const os = require("node:os");
	const script = path.join(skillsDir, "memory-curation", "check-rules-survived.sh");
	const run = (before: string | null, after: string | null) => {
		const d = mkdtempSync(path.join(os.tmpdir(), "rules-"));
		const b = path.join(d, "before"), a = path.join(d, "rules.md");
		if (before !== null) writeFileSync(b, before);
		if (after !== null) writeFileSync(a, after);
		const r = spawnSync("bash", [script, b, a], { encoding: "utf-8" });
		rmSync(d, { recursive: true, force: true });
		return r;
	};
	const rules = "# Rules\n\n- rule A\n- rule B\n- rule C\n";

	test("passes (0) when every rule line is still present", () => {
		assert.equal(run(rules, rules + "- rule D\n").status, 0);
	});
	test("reports (1) and lists lines no longer present verbatim (truncated file)", () => {
		const r = run(rules, "# Rules\n\n- rule A\n");
		assert.equal(r.status, 1);
		assert.match(r.stdout, /- rule B/);
		assert.match(r.stdout, /- rule C/);
	});
	test("fails closed (2) when rules.md is missing", () => {
		const r = run(rules, null);
		assert.equal(r.status, 2);
		assert.match(r.stdout + r.stderr, /FAILED/);
	});
	test("fails closed (2) when rules.md is empty", () => {
		assert.equal(run(rules, "").status, 2);
	});
	test("fails closed (2) when the snapshot is missing", () => {
		assert.equal(run(null, rules).status, 2);
	});
	test("the routine runs the script and aborts on exit 2", () => {
		const r = read("framework/skills/memory-curation/consolidation-routine.md");
		assert.ok(r.includes("check-rules-survived.sh /tmp/rules.before ./memory/rules.md"));
		assert.match(r, /exit code 2/i);
	});
});

describe("memory-curation: the rules cap never forces trimming (review I2)", () => {
	const skill = () => read("framework/skills/memory-curation/SKILL.md");
	test("no hard cap or hook rejection on rules.md", () => {
		assert.ok(!skill().includes("≤200 lines, hard cap"));
		assert.ok(!/rules\.md` > 200 lines → git commit-msg hook rejects/.test(skill()));
		assert.match(skill(), /flag it to the operator/i);
	});
});
