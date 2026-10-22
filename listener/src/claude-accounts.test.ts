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
	type ClaudeAccount,
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

	test("the CLI's limit text is recognized; other errors are not", async () => {
		const { isUsageLimitText } = await mod();
		assert.ok(isUsageLimitText("Error: Claude Code returned an error result: You've hit your limit · resets 4am (Asia/Jerusalem)"));
		assert.ok(isUsageLimitText("Claude AI usage limit reached"));
		assert.ok(!isUsageLimitText("Could not process image"));
		assert.ok(!isUsageLimitText(""));
	});

	test("limitOutcome: only an errored run with a limit signal is a limit hit", async () => {
		const { limitOutcome } = await mod();
		const seen = { type: "five_hour", resetsAt: 123000 };
		assert.deepEqual(limitOutcome(true, "boom", seen), { limit_hit: true, limit_type: "five_hour", resets_at: 123000 });
		assert.deepEqual(limitOutcome(true, "You've hit your limit", null), { limit_hit: true, limit_type: null, resets_at: null });
		assert.equal(limitOutcome(false, "You've hit your limit", seen), null, "a run that succeeded is not a limit hit");
		assert.equal(limitOutcome(true, "boom", null), null);
	});

	test("the image ships limit-detect.mjs next to the entrypoint", () => {
		assert.ok(readFileSync(path.join(repoRoot, "docker", "Dockerfile"), "utf-8").includes("COPY docker/limit-detect.mjs /app/limit-detect.mjs"));
	});
});

describe("runWithAccountFallback", () => {
	const A: ClaudeAccount = { label: "A", envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "a" };
	const B: ClaudeAccount = { label: "B", envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "b" };
	const ok = { sessionId: "s", isError: false, result: "done" };
	const limited = { sessionId: "s", isError: true, result: "You've hit your limit", limit: { type: "seven_day", resetsAt: NOW + 3600_000 } };
	const broken = { sessionId: "s", isError: true, result: "boom" };

	async function run(outcomes: Record<string, any>, accounts = [A, B], file = path.join(tmpDir(), "c.json")) {
		const tried: string[] = [];
		const out = await runWithAccountFallback({
			accounts,
			cooldownFile: file,
			model: "opus",
			now: () => NOW,
			attempt: async (acct) => { tried.push(acct ? acct.label : "none"); return outcomes[acct ? acct.label : "none"]; },
		});
		return { out, tried, file };
	}

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
