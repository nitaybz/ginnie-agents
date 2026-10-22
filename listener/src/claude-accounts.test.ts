/**
 * Second Claude subscription: account list, cooldowns after a usage limit,
 * and the order the runner tries accounts in. Also the entrypoint's pure
 * limit detection (docker/limit-detect.mjs).
 *
 * Run: cd listener && npx tsc && node --test dist/claude-accounts.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { recordRunOutcome } from "./run-failures";
import { tmpdir } from "os";
import path from "path";
import {
	loadClaudeAccounts,
	accountAttemptOrder,
	recordLimitCooldown,
	loadCooldowns,
	modelFamily,
	MAX_COOLDOWN_MS,
	DEFAULT_COOLDOWN_MS,
	FILE_TOKEN_MIN_REMAINING_MS,
	runWithAccountFallback,
	accountDockerAuth,
	recordFinalOutcome,
	planLimitRetry,
	CONTINUE_AFTER_LIMIT_MESSAGE,
	type ClaudeAccount,
	type Continuation,
} from "./claude-accounts";

const NOW = Date.parse("2026-10-22T12:00:00Z");

function tmpDir(): string {
	return mkdtempSync(path.join(tmpdir(), "accounts-"));
}

describe("loadClaudeAccounts", () => {
	test("API key wins and is the only account (no rotation)", () => {
		const accts = loadClaudeAccounts({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" }, NOW);
		assert.deepEqual(accts.map((a) => [a.label, a.envVar]), [["api-key", "ANTHROPIC_API_KEY"]]);
	});

	test("first token is A, _2 is B, in order", () => {
		const accts = loadClaudeAccounts({ CLAUDE_CODE_OAUTH_TOKEN: "t1", CLAUDE_CODE_OAUTH_TOKEN_2: "t2" }, NOW);
		assert.deepEqual(accts.map((a) => [a.label, a.value]), [["A", "t1"], ["B", "t2"]]);
		assert.ok(accts.every((a) => a.envVar === "CLAUDE_CODE_OAUTH_TOKEN"));
	});

	test("no auth configured gives an empty list", () => {
		assert.deepEqual(loadClaudeAccounts({}, NOW), []);
	});

	test("_2_FILE reads a fresh access token from a Claude Code credentials file", () => {
		const file = path.join(tmpDir(), "creds.json");
		writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "fromfile", expiresAt: NOW + 3 * 3600_000 } }));
		const accts = loadClaudeAccounts({ CLAUDE_CODE_OAUTH_TOKEN: "t1", CLAUDE_CODE_OAUTH_TOKEN_2_FILE: file }, NOW);
		assert.deepEqual(accts.map((a) => [a.label, a.value]), [["A", "t1"], ["B", "fromfile"]]);
	});

	test("_2_FILE close to expiry, missing, or corrupt leaves B out", () => {
		const dir = tmpDir();
		const soon = path.join(dir, "soon.json");
		writeFileSync(soon, JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: NOW + FILE_TOKEN_MIN_REMAINING_MS - 1 } }));
		const bad = path.join(dir, "bad.json");
		writeFileSync(bad, "{not json");
		for (const f of [soon, bad, path.join(dir, "missing.json")]) {
			const accts = loadClaudeAccounts({ CLAUDE_CODE_OAUTH_TOKEN: "t1", CLAUDE_CODE_OAUTH_TOKEN_2_FILE: f }, NOW);
			assert.deepEqual(accts.map((a) => a.label), ["A"], f);
		}
	});

	test("a plain _2 token wins over _2_FILE", () => {
		const accts = loadClaudeAccounts(
			{ CLAUDE_CODE_OAUTH_TOKEN: "t1", CLAUDE_CODE_OAUTH_TOKEN_2: "t2", CLAUDE_CODE_OAUTH_TOKEN_2_FILE: "/nope" },
			NOW,
		);
		assert.equal(accts[1].value, "t2");
	});

	test("labels never contain the token", () => {
		const accts = loadClaudeAccounts({ CLAUDE_CODE_OAUTH_TOKEN: "secret-a", CLAUDE_CODE_OAUTH_TOKEN_2: "secret-b" }, NOW);
		for (const a of accts) assert.doesNotMatch(a.label, /secret/);
	});
});

describe("modelFamily", () => {
	test("aliases and full ids map to a family", () => {
		assert.equal(modelFamily("opus"), "opus");
		assert.equal(modelFamily("claude-opus-4-7"), "opus");
		assert.equal(modelFamily("sonnet"), "sonnet");
		assert.equal(modelFamily(undefined), null);
	});
});

describe("cooldowns", () => {
	const A: ClaudeAccount = { label: "A", envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "a" };
	const B: ClaudeAccount = { label: "B", envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "b" };

	test("no cooldowns: configured order", () => {
		const file = path.join(tmpDir(), "c.json");
		assert.deepEqual(accountAttemptOrder([A, B], loadCooldowns(file), "opus", NOW).map((a) => a.label), ["A", "B"]);
	});

	test("a usage limit puts the account in cooldown until resetsAt; B goes first", () => {
		const file = path.join(tmpDir(), "c.json");
		recordLimitCooldown(file, "A", { type: "seven_day", resetsAt: NOW + 3600_000 }, NOW);
		const saved = JSON.parse(readFileSync(file, "utf-8"));
		assert.equal(saved.A.seven_day, new Date(NOW + 3600_000).toISOString());
		assert.deepEqual(accountAttemptOrder([A, B], loadCooldowns(file), "opus", NOW).map((a) => a.label), ["B"]);
		// After the reset, A is back first.
		assert.deepEqual(accountAttemptOrder([A, B], loadCooldowns(file), "opus", NOW + 3600_001).map((a) => a.label), ["A", "B"]);
	});

	test("unknown reset time uses the default cooldown; far-future reset is capped", () => {
		const file = path.join(tmpDir(), "c.json");
		recordLimitCooldown(file, "A", { type: null, resetsAt: null }, NOW);
		recordLimitCooldown(file, "B", { type: "five_hour", resetsAt: NOW + 365 * 86400_000 }, NOW);
		const saved = JSON.parse(readFileSync(file, "utf-8"));
		assert.equal(saved.A.unknown, new Date(NOW + DEFAULT_COOLDOWN_MS).toISOString());
		assert.equal(saved.B.five_hour, new Date(NOW + MAX_COOLDOWN_MS).toISOString());
	});

	test("a per-model weekly limit only cools that model family", () => {
		const file = path.join(tmpDir(), "c.json");
		recordLimitCooldown(file, "A", { type: "seven_day_opus", resetsAt: NOW + 3600_000 }, NOW);
		const cd = loadCooldowns(file);
		assert.deepEqual(accountAttemptOrder([A, B], cd, "opus", NOW).map((a) => a.label), ["B"]);
		assert.deepEqual(accountAttemptOrder([A, B], cd, "sonnet", NOW).map((a) => a.label), ["A", "B"]);
	});

	test("a cooldown written by hand (any key) is honored", () => {
		const file = path.join(tmpDir(), "c.json");
		writeFileSync(file, JSON.stringify({ A: { manual: "2026-10-23T00:00:00Z" } }));
		assert.deepEqual(accountAttemptOrder([A, B], loadCooldowns(file), "opus", NOW).map((a) => a.label), ["B"]);
	});

	test("every account cooling: try only the one that resets first", () => {
		const file = path.join(tmpDir(), "c.json");
		recordLimitCooldown(file, "A", { type: "seven_day", resetsAt: NOW + 7200_000 }, NOW);
		recordLimitCooldown(file, "B", { type: "five_hour", resetsAt: NOW + 3600_000 }, NOW);
		assert.deepEqual(accountAttemptOrder([A, B], loadCooldowns(file), "opus", NOW).map((a) => a.label), ["B"]);
	});

	test("missing or corrupt cooldown file means no cooldowns", () => {
		const dir = tmpDir();
		const bad = path.join(dir, "bad.json");
		writeFileSync(bad, "nope");
		assert.deepEqual(loadCooldowns(bad), {});
		assert.deepEqual(loadCooldowns(path.join(dir, "missing.json")), {});
	});
});

describe("entrypoint limit detection (docker/limit-detect.mjs)", () => {
	const repoRoot = path.join(__dirname, "..", "..");
	const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
	const mod = () => esmImport(require("node:url").pathToFileURL(path.join(repoRoot, "docker", "limit-detect.mjs")).href);

	test("a rejected rate_limit_event is a limit, with reset in ms", async () => {
		const { limitFromEvent } = await mod();
		const ev = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1792700000 } };
		assert.deepEqual(limitFromEvent(ev), { type: "seven_day", resetsAt: 1792700000 * 1000 });
		assert.equal(limitFromEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }), null);
		assert.equal(limitFromEvent({ type: "result" }), null);
	});

	test("the CLI's limit text is recognized; other errors and quoted text are not", async () => {
		const { isUsageLimitText } = await mod();
		assert.ok(isUsageLimitText("Error: Claude Code returned an error result: You've hit your limit · resets 4am (Asia/Jerusalem)"));
		assert.ok(isUsageLimitText("You've hit your limit · resets 4am"));
		assert.ok(isUsageLimitText("Claude AI usage limit reached"));
		assert.ok(!isUsageLimitText("Could not process image"));
		assert.ok(!isUsageLimitText(""));
		assert.ok(!isUsageLimitText("Error: Bash failed: API usage limit exceeded for key"), "a tool's own 'usage limit' is not ours");
		assert.ok(!isUsageLimitText("Supplier says: You've hit your limit on this card"), "quoted text mid-message is not ours");
	});

	const rejected = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 123 } };
	const turn = (blocks: any[], extra: any = {}) => ({ type: "assistant", message: { content: blocks }, ...extra });
	const toolUse = { type: "tool_use", id: "t1", name: "Bash", input: {} };

	test("tracker: rejected event that ends the run is a limit", async () => {
		const t = (await mod()).createLimitTracker();
		t.observe(turn([toolUse]));
		t.observe({ type: "user", message: { content: [] } });
		t.observe(rejected);
		t.observe(turn([{ type: "text", text: "You've hit your limit" }], { error: "rate_limit" }));
		assert.deepEqual(t.outcome(true, ""), { limit_hit: true, limit_type: "five_hour", resets_at: 123000 });
		assert.equal(t.toolCalls, 1);
	});

	test("tracker: a limit signal, then the run goes on and fails on max turns, is a counted failure", async () => {
		const t = (await mod()).createLimitTracker();
		t.observe(rejected);
		t.observe(turn([toolUse]));
		t.observe({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
		assert.equal(t.outcome(true, ""), null, "error_max_turns after a cleared limit is not a limit");
		assert.equal(t.outcome(true, "Error: Claude Code returned an error result: Reached maximum number of turns (5)"), null);
	});

	test("tracker: tool output mentioning 'usage limit' is not a limit", async () => {
		const t = (await mod()).createLimitTracker();
		t.observe(turn([toolUse]));
		t.observe({ type: "user", message: { content: [{ type: "tool_result", content: "429: usage limit exceeded" }] } });
		assert.equal(t.outcome(true, "Tool failed: 429: usage limit exceeded"), null);
	});

	test("tracker: terminal limit text without an event is a limit; a successful run never is", async () => {
		const t = (await mod()).createLimitTracker();
		assert.deepEqual(t.outcome(true, "You've hit your limit · resets 4am"), { limit_hit: true, limit_type: null, resets_at: null });
		t.observe(rejected);
		assert.equal(t.outcome(false, "done"), null);
		assert.equal(t.toolCalls, 0);
	});

	test("entrypoint reports the session id and tool calls on the limit exit path", () => {
		const src = readFileSync(path.join(repoRoot, "docker", "entrypoint.mjs"), "utf-8");
		const limitExit = src.slice(src.indexOf("const limitFields = tracker.outcome(true, msg);"));
		assert.match(limitExit.slice(0, 600), /session_id: sessionId,/);
		assert.match(limitExit.slice(0, 600), /tool_calls: tracker\.toolCalls/);
		assert.doesNotMatch(src, /session_id: ""/);
	});

	test("the image ships limit-detect.mjs next to the entrypoint", () => {
		assert.ok(readFileSync(path.join(repoRoot, "docker", "Dockerfile"), "utf-8").includes("COPY docker/limit-detect.mjs /app/limit-detect.mjs"));
	});
});

describe("runWithAccountFallback", () => {
	const A: ClaudeAccount = { label: "A", envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "a" };
	const B: ClaudeAccount = { label: "B", envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "b" };
	const ok = { sessionId: "s", isError: false, result: "done" };
	const limited = { sessionId: "s", isError: true, result: "You've hit your limit", toolCalls: 0, limit: { type: "seven_day", resetsAt: NOW + 3600_000 } };
	const broken = { sessionId: "s", isError: true, result: "boom" };

	async function run(outcomes: Record<string, any>, accounts = [A, B], file = path.join(tmpDir(), "c.json")) {
		const tried: string[] = [];
		const conts: (Continuation | null)[] = [];
		const out = await runWithAccountFallback({
			accounts,
			cooldownFile: file,
			model: "opus",
			now: () => NOW,
			attempt: async (acct, cont) => {
				tried.push(acct ? acct.label : "none");
				conts.push(cont);
				return outcomes[acct ? acct.label : "none"];
			},
		});
		return { out, tried, conts, file };
	}

	test("limit with no tool calls yet: retry on B from the start (original request)", async () => {
		const { tried, conts } = await run({ A: limited, B: ok });
		assert.deepEqual(tried, ["A", "B"]);
		assert.deepEqual(conts, [null, null]);
	});

	test("limit after tool calls: resume A's session on B with a do-not-repeat instruction", async () => {
		const midway = { ...limited, toolCalls: 3, reportedSessionId: "sess-A" };
		const { out, tried, conts } = await run({ A: midway, B: ok });
		assert.deepEqual(tried, ["A", "B"]);
		assert.equal(conts[1]?.sessionId, "sess-A");
		assert.equal(conts[1]?.message, CONTINUE_AFTER_LIMIT_MESSAGE);
		assert.match(CONTINUE_AFTER_LIMIT_MESSAGE, /Do NOT repeat/);
		assert.equal(out.isError, false);
	});

	test("limit after tool calls with no session to resume: no retry, reported as a limit", async () => {
		const { out, tried } = await run({ A: { ...limited, toolCalls: 2 }, B: ok });
		assert.deepEqual(tried, ["A"]);
		assert.ok(out.limitHit);
	});

	test("unknown tool-call count is treated as 'something may have happened': resume, never restart", async () => {
		const { toolCalls, ...noCount } = limited;
		const { conts } = await run({ A: { ...noCount, reportedSessionId: "sess-A" }, B: ok });
		assert.equal(conts[1]?.sessionId, "sess-A");
	});

	test("limit on A: cooldown recorded, one retry on B, which succeeds", async () => {
		const { out, tried, file } = await run({ A: limited, B: ok });
		assert.deepEqual(tried, ["A", "B"]);
		assert.equal(out.isError, false);
		assert.equal(out.account, "B");
		assert.ok(JSON.parse(readFileSync(file, "utf-8")).A.seven_day);
	});

	test("A already cooling: goes straight to B", async () => {
		const file = path.join(tmpDir(), "c.json");
		writeFileSync(file, JSON.stringify({ A: { manual: "2026-10-23T00:00:00Z" } }));
		const { out, tried } = await run({ A: ok, B: ok }, [A, B], file);
		assert.deepEqual(tried, ["B"]);
		assert.equal(out.account, "B");
	});

	test("limit on both: retried once only, reported as a limit hit", async () => {
		const { out, tried, file } = await run({ A: limited, B: limited });
		assert.deepEqual(tried, ["A", "B"]);
		assert.equal(out.isError, true);
		assert.ok(out.limitHit);
		const saved = JSON.parse(readFileSync(file, "utf-8"));
		assert.ok(saved.A && saved.B);
	});

	test("a non-limit error is not retried on another account", async () => {
		const { out, tried } = await run({ A: broken, B: ok });
		assert.deepEqual(tried, ["A"]);
		assert.equal(out.isError, true);
		assert.ok(!out.limitHit);
	});

	test("no accounts configured: one attempt with no account (host credentials)", async () => {
		const { out, tried } = await run({ none: ok }, []);
		assert.deepEqual(tried, ["none"]);
		assert.equal(out.account, null);
	});
});

describe("token never on a command line", () => {
	const B: ClaudeAccount = { label: "B", envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-test-token-B-123" };

	test("accountDockerAuth passes the name in args and the value in env", () => {
		const auth = accountDockerAuth(B);
		assert.deepEqual(auth.args, ["-e", "CLAUDE_CODE_OAUTH_TOKEN"]);
		assert.deepEqual(auth.env, { CLAUDE_CODE_OAUTH_TOKEN: "sk-test-token-B-123" });
		assert.deepEqual(accountDockerAuth(null), { args: [], env: {} });
	});

	function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
		const saved = process.env.PATH;
		process.env.PATH = dir;
		return fn().finally(() => { process.env.PATH = saved; });
	}

	function captureConsole() {
		const lines: string[] = [];
		const orig = { log: console.log, error: console.error, write: process.stderr.write.bind(process.stderr) };
		console.log = (...a: any[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : require("util").inspect(x))).join(" ")); };
		console.error = console.log;
		(process.stderr as any).write = (chunk: any) => { lines.push(String(chunk)); return true; };
		return { lines, restore: () => { console.log = orig.log; console.error = orig.error; (process.stderr as any).write = orig.write; } };
	}

	const agent: any = { name: "tokcheck", dir: "", maxTurns: 1, allowedTools: ["Read"], model: "opus" };

	test("a launch failure (no docker binary) mentions neither token A nor B", async () => {
		const { spawnAttempt } = require("./runner");
		const dir = tmpDir();
		agent.dir = dir;
		writeFileSync(path.join(dir, "PROMPT.md"), "# t");
		const A: ClaudeAccount = { label: "A", envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-test-token-A-999" };
		for (const acct of [A, B]) {
			const cap = captureConsole();
			let err: any;
			try {
				await withPath(path.join(dir, "empty-bin"), () => spawnAttempt(agent, "hi", undefined, "slack", acct));
			} catch (e) { err = e; } finally { cap.restore(); }
			assert.ok(err, "spawn must fail without docker");
			const everything = [String(err), JSON.stringify(err), require("util").inspect(err), ...cap.lines].join("\n");
			assert.ok(everything.includes("ENOENT"), "the failure itself is reported");
			assert.ok(!everything.includes(acct.value), `token ${acct.label} leaked into the launch failure`);
		}
	});

	test("docker gets the token via env only, never in argv", async () => {
		const { spawnAttempt } = require("./runner");
		const dir = tmpDir();
		agent.dir = dir;
		writeFileSync(path.join(dir, "PROMPT.md"), "# t");
		const bin = path.join(dir, "bin");
		require("fs").mkdirSync(bin);
		const out = path.join(dir, "seen.txt");
		writeFileSync(path.join(bin, "docker"),
			`#!/bin/sh\nprintf 'ARGS:%s\\n' "$*" > "${out}"\nprintf 'ENV:%s\\n' "$CLAUDE_CODE_OAUTH_TOKEN" >> "${out}"\n` +
			`echo '{"session_id":"s9","is_error":false,"result":"OK","tool_calls":0}'\n`, { mode: 0o755 });
		const cap = captureConsole();
		let r: any;
		try {
			r = await withPath(`${bin}:/usr/bin:/bin`, () => spawnAttempt(agent, "hi", undefined, "slack", B));
		} finally { cap.restore(); }
		const seen = readFileSync(out, "utf-8");
		assert.match(seen, /ARGS:.*-e CLAUDE_CODE_OAUTH_TOKEN /);
		assert.ok(!seen.split("\n")[0].includes(B.value), "token in argv");
		assert.ok(seen.includes(`ENV:${B.value}`), "token missing from docker's env");
		assert.ok(!cap.lines.join("\n").includes(B.value), "token in listener log");
		assert.equal(r.reportedSessionId, "s9");
		assert.equal(r.toolCalls, 0);
	});
});

describe("runner failure bookkeeping (recordFinalOutcome)", () => {
	const base = { sessionId: "s", result: "", account: "A" };

	test("a run that stopped on a usage limit is not counted as a failure", () => {
		const file = path.join(tmpDir(), "run-failures.json");
		recordRunOutcome(file, "omer", true, "earlier real failure", NOW);
		const recorded = recordFinalOutcome(file, "omer", { ...base, isError: true, result: "You've hit your limit", limitHit: true });
		assert.equal(recorded, false);
		const data = JSON.parse(readFileSync(file, "utf-8"));
		assert.equal(data.omer.count, 1, "streak neither extended nor cleared by a limit");
		assert.equal(data.omer.lastError, "earlier real failure");
	});

	test("a non-limit error is counted; a success clears", () => {
		const file = path.join(tmpDir(), "run-failures.json");
		assert.equal(recordFinalOutcome(file, "omer", { ...base, isError: true, result: "boom", limitHit: false }), true);
		assert.equal(JSON.parse(readFileSync(file, "utf-8")).omer.count, 1);
		recordFinalOutcome(file, "omer", { ...base, isError: false, result: "ok", limitHit: false });
		assert.equal(JSON.parse(readFileSync(file, "utf-8")).omer, undefined);
	});
});

describe("planLimitRetry", () => {
	test("fresh only with zero tool calls", () => {
		assert.deepEqual(planLimitRetry({ sessionId: "x", isError: true, result: "", toolCalls: 0 }), { kind: "fresh" });
		assert.deepEqual(planLimitRetry({ sessionId: "x", isError: true, result: "", toolCalls: 1, reportedSessionId: "x" }), { kind: "resume", sessionId: "x" });
		assert.deepEqual(planLimitRetry({ sessionId: "session_1", isError: true, result: "", toolCalls: 1 }), { kind: "none" });
	});
});
