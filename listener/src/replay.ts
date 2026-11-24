/**
 * Replay harness: run an agent once on a throwaway copy of its folder, with a
 * chosen model and effort, and read how long it took from the copy's own
 * transcript. Used to compare settings on past conversations.
 *
 * Safety: the run never sees the real agent folder (a copy, never a mount),
 * gets no credentials unless the caller passes some, no Slack tokens, no
 * mid-run inbox, no tool servers, no WhatsApp, no extra host mounts, no
 * bottom-line channel, and never the host's Claude login file (a replay runs
 * only on an account token). Links are never copied in and never followed
 * when reading what the run left (a run could plant one). The caller reads
 * what the run wrote in the sandbox (readSandboxDir) and then deletes it.
 *
 * Timings follow the baseline rules: a run starts at a top-level user prompt
 * (a string, or an array with a text item; not a tool result, not a meta entry,
 * not text starting with "<") and ends at the next one. Model time is each
 * api-request entry until the last assistant entry it produced; tool time is
 * each tool_use until its tool_result; "reply written" is the first tool_use
 * whose input matches the caller's replyMarker.
 */

import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnAttempt, type AgentConfig, type RunEffort, type RunProfile } from "./runner";
import {
	ACCOUNT_COOLDOWNS_FILE,
	loadClaudeAccounts,
	runWithAccountFallback,
	type AttemptResult,
	type ClaudeAccount,
} from "./claude-accounts";
import { pickErrorLine } from "./run-failures";

export interface RunTimings {
	/** Run start until the first tool call matching replyMarker; null when none. */
	toReplyMs: number | null;
	totalMs: number;
	modelMs: number;
	toolMs: number;
	outTokens: number;
	/** Model and effort the transcript itself records (proof the setting applied). */
	seenModel?: string;
	seenEffort?: string;
}

export interface ReplayCase {
	prompt: string;
	model: string;
	effort?: string;
	/** A key of the agent's run_profiles: its preloaded skills are kept; model and effort come from here. */
	profile?: string;
	/** Extra container env (for example a read-only gate's address). No secrets: those go in credentials. */
	env?: Record<string, string>;
	/** Written as the sandbox's credentials.json; none = no credentials at all. */
	credentials?: object;
	/** data/ subfolders copied into the sandbox; none = an empty data/. */
	keepData?: string[];
	/** Marks "reply written": tested against each tool call's input. */
	replyMarker: RegExp;
	origin?: string;
}

export interface ReplayResult {
	ok: boolean;
	reason?: string;
	model: string;
	effort: string | null;
	toReplyMs: number | null;
	totalMs: number | null;
	modelMs: number | null;
	toolMs: number | null;
	outTokens: number | null;
	seenModel?: string;
	seenEffort?: string;
	/** Final text of the run. */
	result?: string;
	sessionId?: string;
	/** The sandbox folder ("" when refused before one was made). The caller deletes it. */
	sandbox: string;
}

export interface ReplayDeps {
	accounts?: ClaudeAccount[];
	cooldownFile?: string;
	/** Parent folder for sandboxes (default: the system temp folder). */
	sandboxRoot?: string;
}

const RUN_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
const REPLAY_PROFILE = "__replay";
// Top-level names never copied: secrets, run history, logs, version control.
const NEVER_COPY = new Set(["credentials.json", "sessions", "logs", ".git", "data"]);
const DATA_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
// Names the framework, the Claude program or an auth path reads, and names
// that look like a secret: a replay must not override them or carry secrets.
const RESERVED_ENV = /^(AGENT_|MIDRUN_|RESUME_|CLAUDE|ANTHROPIC|WHATSAPP_|SLACK_|NODE_|DOCKER|GINNIE_|STUDIO|LD_)|^(MAX_TURNS|ALLOWED_TOOLS|PRELOAD_SKILLS|DELIVERY_INSTRUCTION|BOTTOM_LINE_CHANNEL|TZ|HOME|PATH|USER|SHELL)$|TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/;

/**
 * Copy an agent folder to a new private temp folder for one replay. Leaves out
 * credentials.json, sessions/, logs/, .git, .env files and every data/
 * subfolder not listed (data/ itself is always there, empty or with the listed
 * ones). Links (and anything that is not a plain file or folder) are skipped
 * at every depth, so nothing in the copy points back at a real file.
 * credentials.json is written only from opts.credentials.
 */
export function makeSandbox(agentDir: string, opts: { credentials?: object; keepData?: string[]; root?: string }): string {
	const keep = opts.keepData ?? [];
	for (const name of keep) {
		if (typeof name !== "string" || !DATA_NAME.test(name) || name === "." || name === "..") {
			throw new Error(`keepData: ${JSON.stringify(name)} is not a plain data/ subfolder name`);
		}
	}
	const src = path.resolve(agentDir);
	if (!lstatSync(src).isDirectory()) throw new Error(`not a folder: ${agentDir}`);
	const sb = mkdtempSync(path.join(opts.root ?? tmpdir(), `replay-${path.basename(src).replace(/[^A-Za-z0-9_-]/g, "_")}-`));
	try {
		for (const entry of readdirSync(src)) {
			if (NEVER_COPY.has(entry) || entry === ".env" || entry.startsWith(".env.")) continue;
			copyTree(path.join(src, entry), path.join(sb, entry));
		}
		// Always a data/ folder, so what the run writes there lands in the sandbox.
		mkdirSync(path.join(sb, "data"));
		const dataDir = path.join(src, "data");
		if (lstatOrNull(dataDir)?.isDirectory()) {
			for (const name of keep) copyTree(path.join(dataDir, name), path.join(sb, "data", name));
		}
		if (opts.credentials !== undefined) {
			writeFileSync(path.join(sb, "credentials.json"), JSON.stringify(opts.credentials, null, 2), { mode: 0o600 });
		}
	} catch (err) {
		rmSync(sb, { recursive: true, force: true });
		throw err;
	}
	return sb;
}

function lstatOrNull(p: string) {
	try { return lstatSync(p); } catch { return null; }
}

// Plain files and folders only; a link or anything else is skipped (missing is fine).
function copyTree(from: string, to: string): void {
	const st = lstatOrNull(from);
	if (!st) return;
	if (st.isDirectory()) {
		mkdirSync(to, { mode: st.mode & 0o777 });
		for (const entry of readdirSync(from)) copyTree(path.join(from, entry), path.join(to, entry));
	} else if (st.isFile()) {
		copyFileSync(from, to);
		chmodSync(to, st.mode & 0o777);
	}
}

/**
 * The real path of rel inside the sandbox, or an error when rel is not a
 * plain relative path, any part of it is a link, or it leaves the sandbox.
 * null when it does not exist.
 */
export function sandboxPath(sandbox: string, rel: string): string | null {
	const parts = rel.split(/[\\/]+/).filter(Boolean);
	if (path.isAbsolute(rel) || !parts.length || parts.some((p) => p === ".." || p === ".")) {
		throw new Error(`${JSON.stringify(rel)} is not a plain relative path`);
	}
	const root = realpathSync(sandbox);
	let cur = root;
	for (const part of parts) {
		cur = path.join(cur, part);
		const st = lstatOrNull(cur);
		if (!st) return null;
		if (st.isSymbolicLink()) throw new Error(`${JSON.stringify(rel)} is or passes through a link`);
	}
	const real = realpathSync(cur);
	if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`${JSON.stringify(rel)} leaves the sandbox`);
	return real;
}

/**
 * Read every plain file under a folder inside the sandbox ("a/b" keys, text up
 * to maxBytes each). Links are never followed: a link folder is refused
 * (throws), links inside it are listed in skipped.
 */
export function readSandboxDir(sandbox: string, rel: string, maxBytes = 256 * 1024): { files: Record<string, string>; skipped: string[] } {
	const files: Record<string, string> = {};
	const skipped: string[] = [];
	const dir = sandboxPath(sandbox, rel);
	if (!dir) return { files, skipped };
	if (!lstatSync(dir).isDirectory()) throw new Error(`${JSON.stringify(rel)} is not a folder`);
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = path.join(d, name);
			const key = path.relative(dir, p).split(path.sep).join("/");
			const st = lstatSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.isFile()) files[key] = st.size > maxBytes ? `(${st.size} bytes, not read)` : readFileSync(p, "utf-8");
			else skipped.push(key);
		}
	};
	walk(dir);
	return { files, skipped };
}

// ---- timings ----

function parseLines(text: string): any[] {
	const out: any[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { out.push(JSON.parse(line)); } catch {}
	}
	return out;
}

function promptText(e: any): string | null {
	if (!e || e.type !== "user" || e.isMeta) return null;
	const c = e.message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c) || c.some((x: any) => x?.type === "tool_result")) return null;
	const t = c.find((x: any) => x?.type === "text");
	return t ? String(t.text ?? "") : null;
}

/** Timings of the first run in a transcript (see the header for the rules); null when it has no prompt. */
export function runTimings(jsonl: string, replyMarker: RegExp): RunTimings | null {
	// A copy without g/y, so test() keeps no state between calls.
	const marker = new RegExp(replyMarker.source, replyMarker.flags.replace(/[gy]/g, ""));
	let started = false;
	let start = 0, end = 0, modelMs = 0, toolMs = 0;
	let writeAt: number | null = null;
	let seenModel: string | undefined, seenEffort: string | undefined;
	let req: { at: number; last: number | null } | null = null;
	const pending = new Map<string, number>();
	const tokens = new Map<string, number>();
	const closeReq = () => {
		if (req && req.last != null) modelMs += req.last - req.at;
		req = null;
	};
	for (const e of parseLines(jsonl)) {
		const p = promptText(e);
		if (p != null && !p.startsWith("<")) {
			if (started) break;
			const t = Date.parse(e.timestamp);
			if (!t) continue;
			started = true;
			start = end = t;
			continue;
		}
		if (!started) continue;
		const t = Date.parse(e?.timestamp);
		if (!t) continue;
		end = Math.max(end, t);
		if (e.type === "api-request") { closeReq(); req = { at: t, last: null }; continue; }
		const content: any[] = Array.isArray(e.message?.content) ? e.message.content : [];
		if (e.type === "assistant") {
			if (req) req.last = t;
			if (seenModel === undefined && typeof e.message?.model === "string") seenModel = e.message.model;
			if (seenEffort === undefined && typeof e.effort === "string") seenEffort = e.effort;
			const id = String(e.message?.id ?? `entry-${tokens.size}`);
			const out = Number(e.message?.usage?.output_tokens) || 0;
			tokens.set(id, Math.max(tokens.get(id) ?? 0, out));
			for (const c of content) {
				if (c?.type !== "tool_use") continue;
				pending.set(String(c.id), t);
				if (writeAt == null && marker.test(JSON.stringify(c.input ?? {}))) writeAt = t;
			}
		}
		if (e.type === "user") {
			for (const c of content) {
				if (c?.type !== "tool_result") continue;
				const from = pending.get(String(c.tool_use_id));
				if (from != null) { toolMs += t - from; pending.delete(String(c.tool_use_id)); }
			}
		}
	}
	if (!started) return null;
	closeReq();
	let outTokens = 0;
	for (const v of tokens.values()) outTokens += v;
	return { toReplyMs: writeAt != null ? writeAt - start : null, totalMs: end - start, modelMs, toolMs, outTokens, seenModel, seenEffort };
}

// ---- one replay ----

function refuse(c: Pick<ReplayCase, "model" | "effort">, reason: string, sandbox = ""): ReplayResult {
	return {
		ok: false, reason, model: c.model, effort: c.effort ?? null,
		toReplyMs: null, totalMs: null, modelMs: null, toolMs: null, outTokens: null, sandbox,
	};
}

// The run's transcript: the reported session's file, else the newest one.
// Never through a link: the run could plant one pointing anywhere.
function findTranscript(sandbox: string, sessionId: string | undefined): string | null {
	const projects = sandboxPath(sandbox, "sessions/projects");
	if (!projects || !lstatSync(projects).isDirectory()) return null;
	const files: { file: string; mtime: number }[] = [];
	for (const d of readdirSync(projects)) {
		const full = path.join(projects, d);
		if (!lstatSync(full).isDirectory()) continue;
		for (const f of readdirSync(full)) {
			const st = lstatSync(path.join(full, f));
			if (f.endsWith(".jsonl") && st.isFile()) files.push({ file: path.join(full, f), mtime: st.mtimeMs });
		}
	}
	const own = sessionId ? files.find((f) => path.basename(f.file) === `${sessionId}.jsonl`) : undefined;
	if (own) return own.file;
	files.sort((a, b) => b.mtime - a.mtime);
	return files[0]?.file ?? null;
}

/**
 * Run the agent once on a sandbox copy with the chosen model and effort.
 * Never throws for a bad setting or a failed run: it answers ok:false with the
 * reason. The sandbox is left for the caller to read and delete.
 */
export async function replayOne(agent: AgentConfig, c: ReplayCase, deps: ReplayDeps = {}): Promise<ReplayResult> {
	if (typeof c.model !== "string" || !/^\S+$/.test(c.model)) return refuse(c, `model ${JSON.stringify(c.model)} is not a model name`);
	if (c.effort !== undefined && !RUN_EFFORTS.includes(c.effort)) return refuse(c, `effort ${JSON.stringify(c.effort)} is not one of ${RUN_EFFORTS.join(", ")}`);
	if (!(c.replyMarker instanceof RegExp)) return refuse(c, "replyMarker must be a regular expression");
	const base: RunProfile | undefined = c.profile ? agent.runProfiles?.[c.profile] : undefined;
	if (c.profile && !base) return refuse(c, `profile ${JSON.stringify(c.profile)} is not in the agent's run_profiles`);
	for (const name of Object.keys(c.env ?? {})) {
		if (!ENV_NAME.test(name) || RESERVED_ENV.test(name)) return refuse(c, `env name ${JSON.stringify(name)} is not allowed in a replay`);
		if (typeof c.env![name] !== "string") return refuse(c, `env ${name} must be a string`);
	}
	const effort = (c.effort ?? base?.effort ?? null) as RunEffort | null;
	const accounts = deps.accounts ?? loadClaudeAccounts(process.env);
	if (!accounts.length) {
		return refuse(c, "no Claude account token (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY); a replay never uses the host login file");
	}

	let sandbox: string;
	try {
		sandbox = makeSandbox(agent.dir, { credentials: c.credentials, keepData: c.keepData, root: deps.sandboxRoot });
	} catch (err) {
		return refuse(c, `sandbox: ${String((err as Error)?.message ?? err)}`);
	}

	// Everything after the sandbox exists: on any unexpected failure it is
	// deleted here, so a sandbox is only ever handed back to the caller.
	try {
		return await runOnSandbox(agent, c, effort, base, accounts, deps, sandbox);
	} catch (err) {
		rmSync(sandbox, { recursive: true, force: true });
		return refuse({ model: c.model, effort: effort ?? undefined }, `replay: ${String((err as Error)?.message ?? err)}`);
	}
}

async function runOnSandbox(
	agent: AgentConfig,
	c: ReplayCase,
	effort: RunEffort | null,
	base: RunProfile | undefined,
	accounts: ClaudeAccount[],
	deps: ReplayDeps,
	sandbox: string,
): Promise<ReplayResult> {
	// The agent as it runs in the replay: everything points at the sandbox,
	// and every way out (Slack, WhatsApp, tool servers, host mounts, inbox) is off.
	const replayAgent: AgentConfig = {
		...agent,
		dir: sandbox,
		slackBotToken: "",
		slackAppToken: "",
		whatsapp: undefined,
		whatsappToken: "",
		toolServers: undefined,
		extraMounts: [],
		wakeInbox: false,
		midrunMessages: false,
		model: c.model,
		runProfiles: { [REPLAY_PROFILE]: { model: c.model, ...(effort ? { effort } : {}), ...(base?.preloadSkills ? { preloadSkills: base.preloadSkills } : {}) } },
	};
	const failed = (result: string): Promise<AttemptResult> => Promise.resolve({ sessionId: "", isError: true, result, limit: null });

	let out: AttemptResult;
	try {
		out = await runWithAccountFallback({
			accounts,
			cooldownFile: deps.cooldownFile ?? ACCOUNT_COOLDOWNS_FILE,
			model: c.model,
			attempt: (account, cont) => {
				// Every account cooling down: no host-login fallback for a replay.
				if (!account) return failed("no Claude account available right now (all cooling down after usage limits)");
				// A retry after a usage limit that would resume partway is not a
				// clean replay (its times mix two runs): report it instead.
				if (cont) return failed("stopped on a usage limit partway; a replay is not continued on another account");
				return spawnAttempt(replayAgent, c.prompt, undefined, c.origin ?? "slack", account, false, undefined, REPLAY_PROFILE, { replay: true, env: c.env });
			},
			log: (line) => console.log(`[${agent.name} replay] ${line}`),
		});
	} catch (err) {
		return refuse({ model: c.model, effort: effort ?? undefined }, `run: ${String((err as Error)?.message ?? err)}`, sandbox);
	}

	const file = findTranscript(sandbox, out.reportedSessionId);
	const timings = file ? runTimings(readFileSync(file, "utf-8"), c.replyMarker) : null;
	const reason = out.isError
		? pickErrorLine(out.result || "", out.stderr || "").slice(0, 2000)
		: !timings ? "the run left no transcript in the sandbox" : undefined;
	return {
		ok: !out.isError && !!timings,
		...(reason ? { reason } : {}),
		model: c.model,
		effort,
		toReplyMs: timings?.toReplyMs ?? null,
		totalMs: timings?.totalMs ?? null,
		modelMs: timings?.modelMs ?? null,
		toolMs: timings?.toolMs ?? null,
		outTokens: timings?.outTokens ?? null,
		seenModel: timings?.seenModel,
		seenEffort: timings?.seenEffort,
		result: out.result,
		sessionId: out.reportedSessionId,
		sandbox,
	};
}
