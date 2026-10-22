/**
 * Claude accounts: which subscription a run uses, and what happens when one
 * hits its usage limit.
 *
 * Accounts come from the listener .env, in order:
 *   A  CLAUDE_CODE_OAUTH_TOKEN          (long-lived token from `claude setup-token`)
 *   B  CLAUDE_CODE_OAUTH_TOKEN_2        (same, second subscription; preferred)
 *      or CLAUDE_CODE_OAUTH_TOKEN_2_FILE (path to a Claude Code .credentials.json
 *                                         that another program keeps fresh; the
 *                                         access token is read at spawn time and
 *                                         used only if it has enough life left)
 *   C… _3, _4, … likewise.
 * ANTHROPIC_API_KEY, when set, is the only account (API billing has no
 * subscription limit to rotate around).
 *
 * When a run ends on a usage limit, the account is put in cooldown in
 * data/account-cooldowns.json until the limit resets, and the run is retried
 * once on the next account that is not cooling down: from the start if the
 * first try made no tool calls, else by resuming its session with an
 * instruction not to repeat completed actions. Limit hits are not run
 * failures. Logs carry the account label only, never the token, and the
 * token never goes on a command line (see accountDockerAuth).
 *
 * Cooldown file shape (also fine to write by hand to force a cooldown):
 *   { "A": { "seven_day": "2026-10-25T01:00:00.000Z", "manual": "..." } }
 * Keys are limit windows; "seven_day_opus" / "seven_day_sonnet" only cool
 * agents on that model family, every other key cools the whole account.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { pickErrorLine, recordRunOutcome } from "./run-failures";

export const ACCOUNT_COOLDOWNS_FILE = path.join(__dirname, "..", "..", "data", "account-cooldowns.json");

// A limit with no reset time cools the account for this long, then it is tried again.
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
// No cooldown may hold an account longer than this (a bad reset time must not lock it out for good).
export const MAX_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000;
// A token read from a credentials file must stay valid at least this long, so a run does not outlive it.
export const FILE_TOKEN_MIN_REMAINING_MS = 30 * 60 * 1000;
const MAX_ACCOUNTS = 9;

export interface ClaudeAccount {
	label: string;                                               // "A", "B", … or "api-key"
	envVar: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY";      // how the container receives it
	value: string;
}

export interface LimitInfo {
	type: string | null;     // rate limit window, e.g. "seven_day"
	resetsAt: number | null; // epoch ms
}

type Cooldowns = Record<string, Record<string, string>>;

function labelFor(index: number): string {
	return String.fromCharCode("A".charCodeAt(0) + index);
}

function tokenFromCredentialsFile(file: string, now: number): string | null {
	try {
		const oauth = JSON.parse(readFileSync(file, "utf-8"))?.claudeAiOauth;
		const token = typeof oauth?.accessToken === "string" ? oauth.accessToken : "";
		const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : 0;
		if (!token || expiresAt - now < FILE_TOKEN_MIN_REMAINING_MS) return null;
		return token;
	} catch {
		return null;
	}
}

export function loadClaudeAccounts(env: NodeJS.ProcessEnv, now: number = Date.now()): ClaudeAccount[] {
	if (env.ANTHROPIC_API_KEY) {
		return [{ label: "api-key", envVar: "ANTHROPIC_API_KEY", value: env.ANTHROPIC_API_KEY }];
	}
	const out: ClaudeAccount[] = [];
	for (let i = 1; i <= MAX_ACCOUNTS; i++) {
		const suffix = i === 1 ? "" : `_${i}`;
		let token = (env[`CLAUDE_CODE_OAUTH_TOKEN${suffix}`] || "").trim();
		const file = (env[`CLAUDE_CODE_OAUTH_TOKEN${suffix}_FILE`] || "").trim();
		if (!token && file) token = tokenFromCredentialsFile(file, now) || "";
		if (token) out.push({ label: labelFor(i - 1), envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: token });
	}
	return out;
}

export function modelFamily(model: string | undefined): string | null {
	const m = (model || "").toLowerCase();
	for (const f of ["opus", "sonnet", "haiku"]) if (m.includes(f)) return f;
	return null;
}

// "seven_day_opus" cools only opus runs; account-wide windows return null.
function windowFamily(windowKey: string): string | null {
	const m = /^seven_day_(opus|sonnet|haiku)$/.exec(windowKey);
	return m ? m[1] : null;
}

export function loadCooldowns(file: string = ACCOUNT_COOLDOWNS_FILE): Cooldowns {
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

// Epoch ms until which the account is cooling for this model family, or 0.
function coolingUntil(cooldowns: Cooldowns, label: string, family: string | null, now: number): number {
	let until = 0;
	for (const [key, iso] of Object.entries(cooldowns[label] || {})) {
		const wf = windowFamily(key);
		if (wf && wf !== family) continue;
		const t = Math.min(Date.parse(iso), now + MAX_COOLDOWN_MS);
		if (Number.isFinite(t) && t > now && t > until) until = t;
	}
	return until;
}

/**
 * Accounts to try, in order: those not cooling down, in configured order.
 * When every account is cooling, only the one that resets first (the
 * cooldown is an estimate; trying costs one quick failed start).
 */
export function accountAttemptOrder(
	accounts: ClaudeAccount[],
	cooldowns: Cooldowns,
	model: string | undefined,
	now: number = Date.now(),
): ClaudeAccount[] {
	const family = modelFamily(model);
	const free = accounts.filter((a) => coolingUntil(cooldowns, a.label, family, now) === 0);
	if (free.length || !accounts.length) return free;
	const soonest = [...accounts].sort(
		(x, y) => coolingUntil(cooldowns, x.label, family, now) - coolingUntil(cooldowns, y.label, family, now),
	)[0];
	return [soonest];
}

export function recordLimitCooldown(
	file: string,
	label: string,
	limit: LimitInfo,
	now: number = Date.now(),
): string {
	const all = loadCooldowns(file);
	const key = limit.type || "unknown";
	const resetsAt = limit.resetsAt && limit.resetsAt > now ? limit.resetsAt : now + DEFAULT_COOLDOWN_MS;
	const until = new Date(Math.min(resetsAt, now + MAX_COOLDOWN_MS)).toISOString();
	all[label] = { ...(all[label] || {}), [key]: until };
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(all, null, 2));
	} catch (err) {
		console.error(`[runner] failed to write ${file}:`, err);
	}
	return until;
}

/**
 * How a container receives the account: docker gets only `-e NAME`, and the
 * value travels in the docker client's own environment. The token is never
 * on a command line, so it cannot show in `ps` or in a launch-error message.
 */
export function accountDockerAuth(account: ClaudeAccount | null): { args: string[]; env: Record<string, string> } {
	if (!account) return { args: [], env: {} };
	return { args: ["-e", account.envVar], env: { [account.envVar]: account.value } };
}

export interface AttemptResult {
	sessionId: string;
	isError: boolean;
	result: string;
	limit?: LimitInfo | null;
	model?: string;
	stderr?: string;
	// Tool calls the run made; undefined when the container did not say.
	toolCalls?: number;
	// Session id the container itself reported (resumable), if any.
	reportedSessionId?: string;
}

export interface FallbackResult extends AttemptResult {
	account: string | null;
	limitHit: boolean;
}

// A retry after a limit that must not start over: resume the first try's session.
export interface Continuation {
	sessionId: string;
	message: string;
}

export const CONTINUE_AFTER_LIMIT_MESSAGE =
	"Your previous attempt at this task stopped partway because of a Claude usage limit; it now continues on " +
	"another account. Continue from where it stopped. Do NOT repeat any action already completed above " +
	"(messages or posts sent, files or records written, payments or documents issued). If you are unsure " +
	"whether an action went through, check its result first instead of doing it again.";

/**
 * How to retry on another account after a limit:
 *  - no tool call yet: start over with the original request (nothing happened);
 *  - tool calls made (or unknown): resume the first try's session and continue;
 *  - tool calls made but no session to resume: do not retry (repeating could
 *    resend messages or money actions).
 */
export function planLimitRetry(r: AttemptResult): { kind: "fresh" } | { kind: "resume"; sessionId: string } | { kind: "none" } {
	if (r.toolCalls === 0) return { kind: "fresh" };
	if (r.reportedSessionId) return { kind: "resume", sessionId: r.reportedSessionId };
	return { kind: "none" };
}

/**
 * Run once on the first usable account; on a usage limit, record the
 * cooldown and retry once on the next usable account (see planLimitRetry).
 * With no accounts configured, run once with none (host credentials fallback).
 */
export async function runWithAccountFallback(opts: {
	accounts: ClaudeAccount[];
	cooldownFile: string;
	model: string | undefined;
	attempt: (account: ClaudeAccount | null, cont: Continuation | null) => Promise<AttemptResult>;
	now?: () => number;
	log?: (line: string) => void;
}): Promise<FallbackResult> {
	const now = opts.now || Date.now;
	const log = opts.log || (() => {});
	const order = accountAttemptOrder(opts.accounts, loadCooldowns(opts.cooldownFile), opts.model, now());
	if (!order.length) {
		const r = await opts.attempt(null, null);
		return { ...r, account: null, limitHit: !!(r.isError && r.limit) };
	}

	const first = order[0];
	const r1 = await opts.attempt(first, null);
	if (!(r1.isError && r1.limit)) return { ...r1, account: first.label, limitHit: false };

	const until1 = recordLimitCooldown(opts.cooldownFile, first.label, r1.limit, now());
	const what = `usage limit on account ${first.label} (${r1.limit.type || "unknown"}), cooling until ${until1}`;
	// Re-read after recording, so a per-family limit still excludes the account it just hit.
	const next = accountAttemptOrder(opts.accounts, loadCooldowns(opts.cooldownFile), opts.model, now())
		.find((a) => a.label !== first.label);
	if (!next) {
		log(`${what}; no other account available`);
		return { ...r1, account: first.label, limitHit: true };
	}
	const plan = planLimitRetry(r1);
	if (plan.kind === "none") {
		log(`${what}; not retrying: ${r1.toolCalls ?? "unknown"} tool calls already made and no session to resume`);
		return { ...r1, account: first.label, limitHit: true };
	}
	const cont = plan.kind === "resume" ? { sessionId: plan.sessionId, message: CONTINUE_AFTER_LIMIT_MESSAGE } : null;
	log(`${what}; retrying on account ${next.label} (${cont ? `resuming after ${r1.toolCalls ?? "unknown"} tool calls` : "from the start, no tool calls yet"})`);

	const r2 = await opts.attempt(next, cont);
	if (r2.isError && r2.limit) {
		const until2 = recordLimitCooldown(opts.cooldownFile, next.label, r2.limit, now());
		log(`usage limit on account ${next.label} (${r2.limit.type || "unknown"}), cooling until ${until2}`);
		return { ...r2, account: next.label, limitHit: true };
	}
	return { ...r2, account: next.label, limitHit: false };
}

/**
 * Failure bookkeeping for the watcher after the final attempt: a run that
 * stopped on a usage limit is not a broken agent and leaves the streak alone;
 * anything else is recorded (success clears, error extends).
 * Returns whether the outcome was recorded.
 */
export function recordFinalOutcome(file: string, agentName: string, out: FallbackResult): boolean {
	if (out.limitHit) return false;
	recordRunOutcome(file, agentName, out.isError, out.isError ? pickErrorLine(out.result, out.stderr || "") : "");
	return true;
}
