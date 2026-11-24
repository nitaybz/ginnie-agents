/**
 * Replay harness: run an agent on a throwaway copy of its folder with a chosen
 * model and effort, and read how long it took from the copy's transcript.
 *
 * No docker here: a fake `docker` on PATH stands in for the container. It
 * records what it was given and writes a transcript into the mounted sessions
 * folder, the way the real container does.
 *
 * Run: cd listener && npx tsc && node --test dist/replay.test.js
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentConfig } from "./runner";
import { makeSandbox, replayOne, runTimings } from "./replay";
import { runReplayCli } from "./replay-cli";
import { spawnAttempt } from "./runner";
import type { ClaudeAccount } from "./claude-accounts";

const made: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(path.join(tmpdir(), `replay-test-${p}-`)); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function agentWith(dir: string, extra: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "agent-a",
		dir,
		slackBotId: "U1",
		slackBotMsgId: "B1",
		slackChannel: "C1",
		slackBotToken: "xoxb-test-bot-token",
		slackAppToken: "xapp-test-app-token",
		maxTurns: 20,
		allowedTools: ["Bash", "Read"],
		boundaries: "write",
		workHours: { enabled: false, start: "09:00", end: "18:00", days: [], off_hours_behavior: "queue" },
		allowUnverifiedSenders: false,
		buttonTtlHours: 48,
		model: "base-model",
		whatsapp: { apiUrl: "http://wa.invalid", accountId: "acc-1" } as any,
		whatsappToken: "wa-test-token",
		toolServers: { tools_a: { url: "http://tools.invalid/mcp", token_key: "tools_a_token" } } as any,
		midrunMessages: true,
		wakeInbox: true,
		runProfiles: { chat: { model: "chat-model", effort: "low", preloadSkills: ["skill-a"], lingerMinutes: 10 } },
		...extra,
	};
}

// A fixture agent folder with everything a real one can hold.
function fixtureAgent(): string {
	const dir = tmp("agent");
	const w = (rel: string, body: string) => {
		mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		writeFileSync(path.join(dir, rel), body);
	};
	w("PROMPT.md", "# agent-a prompt");
	w("SOUL.md", "# soul");
	w("config.json", JSON.stringify({ model: "base-model" }));
	w("credentials.json", JSON.stringify({ slack_bot_token: "xoxb-test-bot-token", crm_key: "crm-test-key" }));
	w(".env", "SECRET=1");
	w("sessions/projects/-workspace/old-session.jsonl", "{}\n");
	w("logs/run.log", "old log");
	w(".git/HEAD", "ref: refs/heads/main");
	w("memory/rules.md", "rule one");
	w("memory/episodes/2026-01-01.md", "episode");
	w("skills/skill-a/SKILL.md", "# skill a");
	w("data/keep/a.txt", "kept");
	w("data/keep/deeper/b.txt", "kept too");
	w("data/drop/c.txt", "dropped");
	w("data/top-level.txt", "dropped too");
	w("schedules.json", "[]");
	return dir;
}

// Every file under a folder with its content hash (byte-for-byte check).
function treeHash(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) { out[path.relative(dir, p) + "/"] = "dir"; walk(p); }
			else out[path.relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
		}
	};
	walk(dir);
	return out;
}

// ---- transcript fixture: known times ----
const T0 = Date.parse("2026-01-01T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const asst = (ms: number, id: string, out: number, content: unknown[], extra: Record<string, unknown> = {}) =>
	({ type: "assistant", timestamp: at(ms), effort: "low", message: { id, model: "chat-model", role: "assistant", content, usage: { output_tokens: out } }, ...extra });
const userResult = (ms: number, id: string) =>
	({ type: "user", timestamp: at(ms), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

function fixtureTranscript(prompt: unknown = "[CHAT] conversation conv-1: hello"): string {
	const lines = [
		{ type: "queue-operation", timestamp: at(-50) },
		{ type: "user", timestamp: at(0), message: { role: "user", content: prompt } },
		{ type: "user", isMeta: true, timestamp: at(10), message: { role: "user", content: "meta entry, not a prompt" } },
		{ type: "user", timestamp: at(20), message: { role: "user", content: "<system-reminder>not a prompt</system-reminder>" } },
		{ type: "api-request", timestamp: at(100) },
		asst(2100, "m1", 10, [{ type: "thinking", thinking: "..." }]),
		asst(3000, "m1", 40, [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/workspace/skills/skill-a/SKILL.md" } }]),
		userResult(3200, "tu1"), // tool 200
		{ type: "api-request", timestamp: at(3300) },
		asst(8300, "m2", 120, [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "node bin/chat.mjs reply conv-1 'text'" } }]),
		userResult(9300, "tu2"), // tool 1000
		{ type: "api-request", timestamp: at(9400) },
		asst(11400, "m3", 30, [{ type: "text", text: "done" }]),
		{ type: "last-prompt", timestamp: at(11450) },
	];
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
// model: (3000-100) + (8300-3300) + (11400-9400) = 9900; tools 1200; reply written at 8300; total 11450.
const EXPECTED = { toReplyMs: 8300, totalMs: 11450, modelMs: 9900, toolMs: 1200, outTokens: 190 };

describe("makeSandbox", () => {
	test("copies the agent folder without credentials, sessions, logs, .git, .env, and only the listed data folders", () => {
		const agentDir = fixtureAgent();
		const before = treeHash(agentDir);
		const sb = makeSandbox(agentDir, { keepData: ["keep", "missing-is-fine"] });
		try {
			assert.notEqual(path.resolve(sb), path.resolve(agentDir));
			assert.ok(!existsSync(path.join(sb, "credentials.json")), "no credentials.json unless given");
			assert.ok(!existsSync(path.join(sb, "sessions")), "no sessions copied");
			assert.ok(!existsSync(path.join(sb, "logs")), "no logs copied");
			assert.ok(!existsSync(path.join(sb, ".git")), "no .git copied");
			assert.ok(!existsSync(path.join(sb, ".env")), "no .env copied");
			assert.deepEqual(readdirSync(path.join(sb, "data")).sort(), ["keep"]);
			assert.equal(readFileSync(path.join(sb, "data/keep/deeper/b.txt"), "utf-8"), "kept too");
			for (const rel of ["PROMPT.md", "SOUL.md", "config.json", "memory/rules.md", "memory/episodes/2026-01-01.md", "skills/skill-a/SKILL.md", "schedules.json"]) {
				assert.equal(readFileSync(path.join(sb, rel), "utf-8"), readFileSync(path.join(agentDir, rel), "utf-8"), rel);
			}
			assert.equal(statSync(sb).mode & 0o777, 0o700, "sandbox is private to this user");
			assert.deepEqual(treeHash(agentDir), before, "real folder unchanged");
		} finally {
			rmSync(sb, { recursive: true, force: true });
		}
	});

	test("no data/ at all when nothing is listed", () => {
		const sb = makeSandbox(fixtureAgent(), {});
		try {
			assert.ok(!existsSync(path.join(sb, "data")) || readdirSync(path.join(sb, "data")).length === 0);
		} finally { rmSync(sb, { recursive: true, force: true }); }
	});

	test("writes credentials.json only from the given object, private to this user", () => {
		const sb = makeSandbox(fixtureAgent(), { credentials: { read_only_token: "ro-1" } });
		try {
			const p = path.join(sb, "credentials.json");
			assert.deepEqual(JSON.parse(readFileSync(p, "utf-8")), { read_only_token: "ro-1" });
			assert.equal(statSync(p).mode & 0o777, 0o600);
		} finally { rmSync(sb, { recursive: true, force: true }); }
	});

	test("a data folder name that climbs out is refused", () => {
		const agentDir = fixtureAgent();
		for (const bad of ["../x", "a/b", "..", "", "/etc"]) {
			assert.throws(() => makeSandbox(agentDir, { keepData: [bad] }), /keepData/, JSON.stringify(bad));
		}
	});
});

describe("runTimings (same rules as the baseline tool)", () => {
	const marker = /chat\.mjs (reply|handoff)/;

	test("reads reply time, whole run, model, tools and output tokens from a transcript", () => {
		const t = runTimings(fixtureTranscript(), marker);
		assert.ok(t);
		assert.deepEqual({ toReplyMs: t!.toReplyMs, totalMs: t!.totalMs, modelMs: t!.modelMs, toolMs: t!.toolMs, outTokens: t!.outTokens }, EXPECTED);
		assert.equal(t!.seenModel, "chat-model");
		assert.equal(t!.seenEffort, "low");
	});

	test("a prompt given as an array with a text item starts the run too", () => {
		const t = runTimings(fixtureTranscript([{ type: "text", text: "[CHAT] conversation conv-1: hello" }]), marker);
		assert.deepEqual({ toReplyMs: t!.toReplyMs, modelMs: t!.modelMs, toolMs: t!.toolMs }, { toReplyMs: 8300, modelMs: 9900, toolMs: 1200 });
	});

	test("the next top-level prompt ends the run", () => {
		const extra = [
			{ type: "user", timestamp: at(20000), message: { role: "user", content: "a second prompt" } },
			{ type: "api-request", timestamp: at(20100) },
			asst(29000, "m9", 500, [{ type: "text", text: "later" }]),
		].map((l) => JSON.stringify(l)).join("\n");
		const t = runTimings(fixtureTranscript() + extra + "\n", marker);
		assert.deepEqual({ toReplyMs: t!.toReplyMs, totalMs: t!.totalMs, modelMs: t!.modelMs, outTokens: t!.outTokens }, { toReplyMs: 8300, totalMs: 11450, modelMs: 9900, outTokens: 190 });
	});

	test("no reply written gives null reply time; a global marker gives the same answer twice", () => {
		assert.equal(runTimings(fixtureTranscript(), /never-matches/)!.toReplyMs, null);
		const g = /chat\.mjs reply/g;
		assert.equal(runTimings(fixtureTranscript(), g)!.toReplyMs, 8300);
		assert.equal(runTimings(fixtureTranscript(), g)!.toReplyMs, 8300);
	});

	test("no prompt in the transcript gives null", () => {
		assert.equal(runTimings('{"type":"api-request","timestamp":"2026-01-01T00:00:00Z"}\n', marker), null);
	});
});

// ---- fake docker ----
// Records its argv and selected env, writes a transcript into the sessions
// mount and a file into the data mount, then prints the entrypoint's result line.
function fakeDocker(): { bin: string; seenFile: string } {
	const dir = tmp("bin");
	const seenFile = path.join(dir, "seen.json");
	const transcript = fixtureTranscript();
	const script = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const env = {}; const mounts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-e") { const [k, ...v] = args[i + 1].split("="); env[k] = v.length ? v.join("=") : "(from env) " + (process.env[k] || ""); }
  if (args[i] === "-v") { const parts = args[i + 1].split(":"); mounts[parts[1]] = parts[0]; }
}
let seen = []; try { seen = JSON.parse(fs.readFileSync(${JSON.stringify(seenFile)}, "utf-8")); } catch {}
seen.push({ args, env, mounts, bottomLine: process.env.BOTTOM_LINE_CHANNEL || "" });
fs.writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify(seen));
if (env.AGENT_MODEL === "not-a-model") {
  console.log(JSON.stringify({ session_id: "", is_error: true, result: "API Error: 404 model: not-a-model was not found", tool_calls: 0 }));
  process.exit(1);
}
const sessions = mounts["/home/node/.claude"];
fs.mkdirSync(path.join(sessions, "projects", "-workspace"), { recursive: true });
fs.writeFileSync(path.join(sessions, "projects", "-workspace", "s-fake.jsonl"), ${JSON.stringify(transcript)});
if (mounts["/workspace/data"]) { fs.mkdirSync(path.join(mounts["/workspace/data"], "out"), { recursive: true }); fs.writeFileSync(path.join(mounts["/workspace/data"], "out", "reply.json"), JSON.stringify({ text: "written by " + env.AGENT_MODEL })); }
if (mounts["/workspace/memory"]) fs.writeFileSync(path.join(mounts["/workspace/memory"], "rules.md"), "changed by the run");
// Links a hostile run could plant, pointing outside the sandbox.
const out = mounts["/workspace/data"] && path.join(mounts["/workspace/data"], "out");
if (process.env.PLANT_OUT_LINK) { fs.rmSync(out, { recursive: true, force: true }); fs.symlinkSync(process.env.PLANT_OUT_LINK, out); }
if (process.env.PLANT_FILE_LINK) fs.symlinkSync(process.env.PLANT_FILE_LINK, path.join(out, "linked.txt"));
if (process.env.PLANT_DIR_LINK) fs.symlinkSync(process.env.PLANT_DIR_LINK, path.join(out, "linked-dir"));
if (process.env.PLANT_TRANSCRIPT_LINK) { const w = path.join(sessions, "projects", "-workspace"); fs.rmSync(w, { recursive: true, force: true }); fs.symlinkSync(process.env.PLANT_TRANSCRIPT_LINK, w); }
if (process.env.PLANT_TRANSCRIPT_FILE_LINK) { const f = path.join(sessions, "projects", "-workspace", "s-fake.jsonl"); fs.rmSync(f); fs.symlinkSync(process.env.PLANT_TRANSCRIPT_FILE_LINK, f); }
console.log(JSON.stringify({ session_id: "s-fake", is_error: false, result: "final text", model: env.AGENT_MODEL, tool_calls: 2 }));
`;
	writeFileSync(path.join(dir, "docker"), script, { mode: 0o755 });
	return { bin: dir, seenFile };
}

async function withFakeDocker<T>(bin: string, fn: () => Promise<T>): Promise<T> {
	const saved = { PATH: process.env.PATH, BL: process.env.BOTTOM_LINE_CHANNEL, HOME: process.env.HOME };
	const log = console.log, warn = console.warn, err = console.error, write = process.stderr.write.bind(process.stderr);
	// Only the fake on PATH, so a real docker can never start from a test.
	process.env.PATH = bin;
	process.env.BOTTOM_LINE_CHANNEL = "C-bottom-line";
	// A home with a host Claude login file: a replay must never mount it.
	process.env.HOME = fakeHome();
	console.log = () => {}; console.warn = () => {}; console.error = () => {};
	(process.stderr as any).write = () => true;
	try {
		return await fn();
	} finally {
		console.log = log; console.warn = warn; console.error = err; (process.stderr as any).write = write;
		process.env.PATH = saved.PATH;
		process.env.HOME = saved.HOME;
		if (saved.BL === undefined) delete process.env.BOTTOM_LINE_CHANNEL; else process.env.BOTTOM_LINE_CHANNEL = saved.BL;
	}
}

function fakeHome(): string {
	const home = tmp("home");
	mkdirSync(path.join(home, ".claude"));
	writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "host-login-test" } }));
	return home;
}

const HOST_LOGIN = "/home/node/.claude/.credentials.json";
const TEST_ACCOUNT: ClaudeAccount = { label: "A", envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-test-replay" };
const oneAccount = { accounts: [TEST_ACCOUNT], cooldownFile: path.join(tmp("cool"), "cooldowns.json") };
const noAccounts = { accounts: [], cooldownFile: path.join(tmp("cool"), "cooldowns.json") };

describe("replayOne", () => {
	test("runs one container on the sandbox with the chosen model and effort, no Slack, inbox or tool servers, and reads the timings", async () => {
		const agentDir = fixtureAgent();
		const before = treeHash(agentDir);
		const { bin, seenFile } = fakeDocker();
		const r = await withFakeDocker(bin, () => replayOne(agentWith(agentDir), {
			prompt: "[CHAT] conversation conv-1: hello",
			model: "model-x",
			effort: "medium",
			profile: "chat",
			env: { READONLY_GATE_URL: "http://gate.invalid" },
			keepData: ["keep"],
			replyMarker: /chat\.mjs (reply|handoff)/,
		}, oneAccount));
		try {
			assert.equal(r.ok, true, r.reason);
			assert.equal(r.model, "model-x");
			assert.equal(r.effort, "medium");
			assert.deepEqual({ toReplyMs: r.toReplyMs, totalMs: r.totalMs, modelMs: r.modelMs, toolMs: r.toolMs, outTokens: r.outTokens }, EXPECTED);
			assert.equal(r.result, "final text");

			const [seen] = JSON.parse(readFileSync(seenFile, "utf-8"));
			const argv = seen.args.join("\n");
			assert.equal(seen.env.AGENT_MODEL, "model-x");
			assert.equal(seen.env.AGENT_EFFORT, "medium");
			assert.equal(seen.env.PRELOAD_SKILLS, "skill-a", "the named profile's preloaded skills are kept");
			assert.equal(seen.env.MIDRUN_LINGER_MS, undefined, "no open-run wait in a replay");
			assert.equal(seen.env.MIDRUN_DIR, undefined, "no mid-run inbox");
			assert.equal(seen.env.AGENT_TOOL_SERVERS, undefined, "no tool servers");
			assert.equal(seen.env.WHATSAPP_API_URL, undefined, "no WhatsApp");
			assert.equal(seen.env.BOTTOM_LINE_CHANNEL, undefined, "no bottom-line Slack channel");
			assert.equal(seen.env.READONLY_GATE_URL, "(from env) http://gate.invalid", "caller env passed by name, value in docker's env");
			assert.ok(!argv.includes("http://gate.invalid"), "caller env value not on the command line");
			for (const secret of ["xoxb-test-bot-token", "xapp-test-app-token", "wa-test-token", "crm-test-key"]) {
				assert.ok(!argv.includes(secret), `${secret} on the command line`);
			}
			assert.ok(!argv.includes(agentDir), "nothing mounted from the real agent folder");
			assert.equal(seen.mounts["/home/node/.claude"], path.join(r.sandbox, "sessions"));
			assert.equal(seen.mounts["/workspace/credentials.json"], undefined, "no credentials mounted");
			assert.ok(!seen.args.some((a: string) => a.includes(HOST_LOGIN)), "no host Claude login mounted");
			assert.match(seen.args[seen.args.indexOf("--name") + 1], /^ginnie-replay-agent-a-\d+$/);

			// The sandbox is left for the caller; the run's writes landed there.
			assert.ok(existsSync(path.join(r.sandbox, "data/out/reply.json")));
			assert.equal(readFileSync(path.join(r.sandbox, "memory/rules.md"), "utf-8"), "changed by the run");
			assert.deepEqual(treeHash(agentDir), before, "real folder byte-for-byte unchanged");
		} finally {
			rmSync(r.sandbox, { recursive: true, force: true });
		}
	});

	test("an unknown model reports ok:false with the reason, not a crash", async () => {
		const { bin } = fakeDocker();
		const r = await withFakeDocker(bin, () => replayOne(agentWith(fixtureAgent()), {
			prompt: "hello", model: "not-a-model", replyMarker: /reply/,
		}, oneAccount));
		try {
			assert.equal(r.ok, false);
			assert.match(r.reason || "", /not-a-model/);
			assert.equal(r.model, "not-a-model");
			assert.equal(r.toReplyMs, null);
		} finally { if (r.sandbox) rmSync(r.sandbox, { recursive: true, force: true }); }
	});

	test("no docker at all reports ok:false with the reason", async () => {
		const empty = tmp("empty-bin");
		const r = await withFakeDocker(empty, () => replayOne(agentWith(fixtureAgent()), {
			prompt: "hello", model: "model-x", replyMarker: /reply/,
		}, oneAccount));
		try {
			assert.equal(r.ok, false);
			assert.match(r.reason || "", /ENOENT|spawn/);
		} finally { if (r.sandbox) rmSync(r.sandbox, { recursive: true, force: true }); }
	});

	test("a bad effort, an unknown profile or a reserved env name is refused before any container starts", async () => {
		const { bin, seenFile } = fakeDocker();
		const cases = [
			{ effort: "turbo" },
			{ profile: "no-such-profile" },
			{ env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } },
			{ env: { AGENT_MODEL: "other" } },
			{ env: { "bad name": "x" } },
			{ env: { LD_PRELOAD: "/x.so" } },
			{ env: { LD_LIBRARY_PATH: "/x" } },
			{ env: { NODE_OPTIONS: "--require /x.js" } },
			{ env: { DOCKER_HOST: "tcp://x" } },
			{ env: { PATH: "/x" } },
			{ env: { HOME: "/x" } },
			{ env: { lower_case: "x" } },
			{ model: "has space" },
		];
		for (const extra of cases) {
			const r = await withFakeDocker(bin, () => replayOne(agentWith(fixtureAgent()), {
				prompt: "hello", model: "model-x", replyMarker: /reply/, ...extra,
			} as any, oneAccount));
			assert.equal(r.ok, false, JSON.stringify(extra));
			assert.ok(r.reason, JSON.stringify(extra));
			if (r.sandbox) rmSync(r.sandbox, { recursive: true, force: true });
		}
		assert.ok(!existsSync(seenFile), "docker was never called");
	});
});

describe("replay CLI", () => {
	test("runs every case at every setting, writes results.jsonl with the output folder read in, deletes the sandboxes", async () => {
		const agentDir = fixtureAgent();
		const before = treeHash(agentDir);
		const work = tmp("cli");
		const cases = path.join(work, "cases.jsonl");
		writeFileSync(cases, [
			JSON.stringify({ id: "case-1", prompt: "[CHAT] conversation conv-1: hello" }),
			"",
			JSON.stringify({ id: "case-2", prompt: "[CHAT] conversation conv-2: hi" }),
		].join("\n"));
		const settings = path.join(work, "settings.json");
		writeFileSync(settings, JSON.stringify({
			replyMarker: "chat\\.mjs (reply|handoff)",
			profile: "chat",
			keepData: ["keep"],
			outputDir: "data/out",
			settings: [{ model: "model-x", effort: "low" }, { model: "not-a-model", effort: "medium" }],
		}));
		const out = path.join(work, "results");
		const sandboxRoot = tmp("sandboxes");
		const { bin } = fakeDocker();
		const code = await withFakeDocker(bin, () => runReplayCli(
			["--agent", "agent-a", "--cases", cases, "--settings", settings, "--out", out],
			{ agents: [agentWith(agentDir)], sandboxRoot, ...oneAccount },
		));
		assert.equal(code, 0);
		assert.equal(statSync(out).mode & 0o777, 0o700, "results folder private to this user");
		const rows = readFileSync(path.join(out, "results.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(rows.length, 4);
		assert.deepEqual(rows.map((r) => `${r.case}/${r.model}/${r.effort}/${r.ok}`), [
			"case-1/model-x/low/true", "case-1/not-a-model/medium/false",
			"case-2/model-x/low/true", "case-2/not-a-model/medium/false",
		]);
		assert.deepEqual(rows[0].outputs, { "reply.json": JSON.stringify({ text: "written by model-x" }) });
		assert.equal(rows[0].toReplyMs, 8300);
		assert.match(rows[1].reason, /not-a-model/);
		assert.ok(rows.every((r) => r.sandbox === undefined), "sandbox paths are not kept in results");
		assert.deepEqual(readdirSync(sandboxRoot), [], "every sandbox deleted");
		assert.deepEqual(treeHash(agentDir), before, "real folder unchanged");
	});

	test("an unknown agent or a missing argument exits non-zero without running anything", async () => {
		const { bin, seenFile } = fakeDocker();
		const code1 = await withFakeDocker(bin, () => runReplayCli(["--agent", "nobody", "--cases", "x", "--settings", "y", "--out", "z"], { agents: [], ...oneAccount }));
		const code2 = await withFakeDocker(bin, () => runReplayCli(["--agent", "agent-a"], { agents: [], ...oneAccount }));
		assert.notEqual(code1, 0);
		assert.notEqual(code2, 0);
		assert.ok(!existsSync(seenFile));
	});
});

describe("replay never gets the host Claude login", () => {
	test("a replay with no Claude account is refused before any container starts", async () => {
		const { bin, seenFile } = fakeDocker();
		const r = await withFakeDocker(bin, () => replayOne(agentWith(fixtureAgent()), {
			prompt: "hello", model: "model-x", replyMarker: /reply/,
		}, noAccounts));
		assert.equal(r.ok, false);
		assert.match(r.reason || "", /account/);
		assert.equal(r.sandbox, "");
		assert.ok(!existsSync(seenFile), "docker was never called");
	});

	test("spawnAttempt for a replay never adds the host login mount, even with no account", async () => {
		const { bin, seenFile } = fakeDocker();
		const dir = fixtureAgent();
		const agent = agentWith(dir);
		let err: unknown;
		try {
			await withFakeDocker(bin, () => spawnAttempt(agent, "hello", undefined, "slack", null, false, undefined, undefined, { replay: true }));
		} catch (e) { err = e; }
		const seen = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf-8")) : [];
		for (const run of seen) assert.ok(!run.args.some((a: string) => a.includes(HOST_LOGIN)), "host login mounted for a replay");
		assert.match(String(err), /account/, "a replay with no account is refused");
		assert.equal(seen.length, 0, "docker was never called");
	});

	test("the CLI reads the framework .env for the Claude account, like the listener", async () => {
		const agentDir = fixtureAgent();
		const work = tmp("cli-env");
		const envFile = path.join(work, ".env");
		writeFileSync(envFile, "CLAUDE_CODE_OAUTH_TOKEN=sk-from-env-file\n");
		writeFileSync(path.join(work, "cases.jsonl"), JSON.stringify({ id: "case-1", prompt: "hello" }) + "\n");
		writeFileSync(path.join(work, "settings.json"), JSON.stringify({ replyMarker: "reply", settings: [{ model: "model-x" }] }));
		const { bin, seenFile } = fakeDocker();
		const saved = { t: process.env.CLAUDE_CODE_OAUTH_TOKEN, k: process.env.ANTHROPIC_API_KEY };
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.ANTHROPIC_API_KEY;
		let code: number;
		try {
			code = await withFakeDocker(bin, () => runReplayCli(
				["--agent", "agent-a", "--cases", path.join(work, "cases.jsonl"), "--settings", path.join(work, "settings.json"), "--out", path.join(work, "out"), "--sandbox-root", path.join(work, "sb")],
				{ agents: [agentWith(agentDir)], envFile, cooldownFile: path.join(work, "cool.json") },
			));
		} finally {
			if (saved.t === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.t;
			if (saved.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.k;
		}
		assert.equal(code!, 0);
		const [seen] = JSON.parse(readFileSync(seenFile, "utf-8"));
		assert.equal(seen.env.CLAUDE_CODE_OAUTH_TOKEN, "(from env) sk-from-env-file");
		assert.ok(!seen.args.some((a: string) => a.includes(HOST_LOGIN)));
	});
});

describe("links the run plants are never followed", () => {
	function outside(): string {
		const d = tmp("outside");
		writeFileSync(path.join(d, "secret.txt"), "outside secret");
		writeFileSync(path.join(d, "s-fake.jsonl"), fixtureTranscript());
		return d;
	}

	async function cliWith(env: Record<string, string>) {
		const agentDir = fixtureAgent();
		const work = tmp("cli-link");
		writeFileSync(path.join(work, "cases.jsonl"), JSON.stringify({ id: "case-1", prompt: "hello" }) + "\n");
		writeFileSync(path.join(work, "settings.json"), JSON.stringify({ replyMarker: "chat\\.mjs reply", outputDir: "data/out", env, settings: [{ model: "model-x" }] }));
		const sandboxRoot = path.join(work, "sandboxes");
		const { bin } = fakeDocker();
		const code = await withFakeDocker(bin, () => runReplayCli(
			["--agent", "agent-a", "--cases", path.join(work, "cases.jsonl"), "--settings", path.join(work, "settings.json"), "--out", path.join(work, "out"), "--sandbox-root", sandboxRoot],
			{ agents: [agentWith(agentDir)], ...oneAccount },
		));
		const rows = readFileSync(path.join(work, "out", "results.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
		return { code, rows, sandboxRoot };
	}

	test("an output folder replaced by a link to a folder outside the sandbox is refused, not read", async () => {
		const { code, rows, sandboxRoot } = await cliWith({ PLANT_OUT_LINK: outside() });
		assert.equal(code, 0);
		assert.deepEqual(rows[0].outputs, {});
		assert.match(rows[0].outputsError, /link/);
		assert.ok(!JSON.stringify(rows).includes("outside secret"));
		assert.deepEqual(readdirSync(sandboxRoot), []);
	});

	test("links inside the output folder (to a file or a folder outside) are skipped, the rest is read", async () => {
		const o = outside();
		const { rows } = await cliWith({ PLANT_FILE_LINK: path.join(o, "secret.txt"), PLANT_DIR_LINK: o });
		assert.deepEqual(Object.keys(rows[0].outputs), ["reply.json"]);
		assert.deepEqual(rows[0].outputsSkipped.sort(), ["linked-dir", "linked.txt"]);
		assert.ok(!JSON.stringify(rows).includes("outside secret"));
	});

	test("a transcript folder or file replaced by a link is not read", async () => {
		const o = outside();
		const plants: Record<string, string>[] = [{ PLANT_TRANSCRIPT_LINK: o }, { PLANT_TRANSCRIPT_FILE_LINK: path.join(o, "s-fake.jsonl") }];
		for (const env of plants) {
			const { bin } = fakeDocker();
			const r = await withFakeDocker(bin, () => replayOne(agentWith(fixtureAgent()), {
				prompt: "hello", model: "model-x", replyMarker: /reply/, env,
			}, oneAccount));
			try {
				assert.equal(r.ok, false, JSON.stringify(env));
				assert.match(r.reason || "", /no transcript/);
				assert.equal(r.toReplyMs, null);
			} finally { if (r.sandbox) rmSync(r.sandbox, { recursive: true, force: true }); }
		}
	});

	test("the sandbox copy skips links at any depth", () => {
		const agentDir = fixtureAgent();
		const o = outside();
		symlinkSync(o, path.join(agentDir, "memory", "linked-dir"));
		symlinkSync(path.join(o, "secret.txt"), path.join(agentDir, "data", "keep", "linked.txt"));
		symlinkSync(path.join(o, "secret.txt"), path.join(agentDir, "top-link.md"));
		const sb = makeSandbox(agentDir, { keepData: ["keep"] });
		try {
			for (const rel of ["memory/linked-dir", "data/keep/linked.txt", "top-link.md"]) {
				assert.ok(!existsSync(path.join(sb, rel)), `${rel} copied`);
			}
			assert.equal(readFileSync(path.join(sb, "data/keep/a.txt"), "utf-8"), "kept");
		} finally { rmSync(sb, { recursive: true, force: true }); }
	});
});

describe("sandboxes are always deleted", () => {
	test("a failure after the sandbox is made deletes it and answers ok:false", async () => {
		class Boom extends RegExp { get flags(): string { throw new Error("boom while reading"); } }
		const root = tmp("sb-root");
		const { bin } = fakeDocker();
		const r = await withFakeDocker(bin, () => replayOne(agentWith(fixtureAgent()), {
			prompt: "hello", model: "model-x", replyMarker: new Boom("reply"),
		}, { ...oneAccount, sandboxRoot: root }));
		assert.equal(r.ok, false);
		assert.match(r.reason || "", /boom/);
		assert.equal(r.sandbox, "");
		assert.deepEqual(readdirSync(root), []);
	});

	test("--sandbox-root is created private to this user and left empty", async () => {
		const agentDir = fixtureAgent();
		const work = tmp("cli-root");
		writeFileSync(path.join(work, "cases.jsonl"), JSON.stringify({ id: "case-1", prompt: "hello" }) + "\n");
		writeFileSync(path.join(work, "settings.json"), JSON.stringify({ replyMarker: "reply", settings: [{ model: "model-x" }] }));
		const root = path.join(work, "host-only", "sandboxes");
		const cool = path.join(work, "own-cooldowns.json");
		const { bin } = fakeDocker();
		const code = await withFakeDocker(bin, () => runReplayCli(
			["--agent", "agent-a", "--cases", path.join(work, "cases.jsonl"), "--settings", path.join(work, "settings.json"), "--out", path.join(work, "out"), "--sandbox-root", root, "--cooldown-file", cool],
			{ agents: [agentWith(agentDir)], accounts: [TEST_ACCOUNT] },
		));
		assert.equal(code, 0);
		assert.equal(statSync(root).mode & 0o777, 0o700);
		assert.deepEqual(readdirSync(root), []);
	});
});
