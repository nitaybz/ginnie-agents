/**
 * Agent Runner — discovers agents from agents/ directory and spawns
 * isolated Docker containers via the Claude Agent SDK.
 *
 * Each agent runs in its own container with:
 *  - Clean Claude Agent SDK (no host plugins/MCPs/settings)
 *  - Only its own credentials, prompt, and memory mounted
 *  - Resource limits (memory, CPU)
 *  - Network access for API calls
 */

import { spawn } from "child_process";
import { readdirSync, readFileSync, existsSync, mkdirSync, realpathSync } from "fs";
import path from "path";
import { deliveryInstruction, type DeliveryOrigin } from "./studio-delivery";
import { RUN_FAILURES_FILE, pickErrorLine, recordRunOutcome } from "./run-failures";
import { bottomLineDockerEnv } from "./bottom-line";
import { parseWhatsAppConfig, whatsappDockerArgs, type WhatsAppConfig } from "./whatsapp-trigger";
import { parseExtraMounts, checkHostPaths, extraMountDockerArgs, type ExtraMount, type HostEnv } from "./extra-mounts";
import { parseBotPolicy, type BotPolicy } from "./bot-allow";
import { parseToolServers, toolServerRefs, toolServersDockerEnv, type ToolServerRef } from "./tool-servers";
import { midrunDockerArgs } from "./midrun-inbox";
import {
	ACCOUNT_COOLDOWNS_FILE,
	accountDockerAuth,
	loadClaudeAccounts,
	recordFinalOutcome,
	runWithAccountFallback,
	type AttemptResult,
	type ClaudeAccount,
} from "./claude-accounts";

const AGENTS_DIR = path.join(__dirname, "..", "..", "agents");
// GINNIE_AGENT_IMAGE: run another image tag (testing a new image beside the live one).
const DOCKER_IMAGE = process.env.GINNIE_AGENT_IMAGE || "ginnie-agent";

// Host facts the extra-mount safety check needs (see extra-mounts.ts).
function extraMountHost(): HostEnv {
	return {
		home: (() => { try { return realpathSync(process.env.HOME || "/root"); } catch { return process.env.HOME || "/root"; } })(),
		agentsDir: realpathSync(AGENTS_DIR),
		frameworkRoot: realpathSync(path.join(__dirname, "..", "..")),
		realpath: (p) => realpathSync(p),
	};
}

export type AgentBoundaries = "read-only" | "write";

export type OffHoursBehavior = "queue" | "ignore" | "deferred_response";

export interface AgentWorkHours {
	enabled: boolean;
	start: string;     // "HH:MM" 24h, in container TZ
	end: string;       // "HH:MM" 24h, in container TZ
	days: string[];    // ["mon","tue","wed","thu","fri"]
	off_hours_behavior: OffHoursBehavior;
}

export interface AgentConfig {
	name: string;
	dir: string;
	slackBotId: string;
	slackBotMsgId: string;
	slackChannel: string;
	slackBotToken: string;
	slackAppToken: string;
	maxTurns: number;
	allowedTools: string[];
	boundaries: AgentBoundaries;
	workHours: AgentWorkHours;
	allowUnverifiedSenders: boolean;
	/** config.json "wake_inbox": true = host jobs may wake the agent via <dir>/data/wake/*.json (wake-inbox.ts). */
	wakeInbox?: boolean;
	/** config.json "midrun_messages": false = a message that arrives while the agent works waits for the run to end (default: handed to the working run, midrun-inbox.ts). */
	midrunMessages?: boolean;
	model?: string;
	buttonTtlHours: number;
	// Optional WhatsApp access + wake-up (config.json "whatsapp"; token in
	// credentials.json "whatsapp_token"). See whatsapp-trigger.ts.
	whatsapp?: WhatsAppConfig;
	whatsappToken?: string;
	// Read-only host paths mounted under /workspace/mounts (config.json
	// "extra_mounts"). See extra-mounts.ts.
	extraMounts?: ExtraMount[];
	// Which other bots may wake this agent (config.json "accept_bots",
	// "handoff_channels", "agent_turn_cap"). Missing or empty = none. See bot-allow.ts.
	botPolicy?: BotPolicy;
	// MCP tool servers this agent may use (config.json "tool_servers"; token
	// in credentials.json under token_key). See tool-servers.ts.
	toolServers?: Record<string, ToolServerRef>;
	// Model, effort, preloaded skills and open-run wait per kind of run
	// (config.json "run_profiles"). A run names its profile; none = agent defaults.
	runProfiles?: Record<string, RunProfile>;
}

export type RunEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RunProfile {
	model?: string;
	effort?: RunEffort;
	/** Skill folder names under the agent's skills/ put straight into the system prompt. */
	preloadSkills?: string[];
	/** How long the run stays open for more messages after its answer (the wait itself lives in the entrypoint). */
	lingerMinutes?: number;
	/** How many such open runs the agent may have at once. */
	lingerMaxOpen?: number;
}

const RUN_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
// Same rule the entrypoint applies, so a name can never climb out of skills/.
const SKILL_NAME = /^[a-z0-9-]{1,40}$/;

/**
 * Check config.json "run_profiles". A bad value is dropped (the rest of the
 * profile stays) and each profile with something dropped gets one warning, so
 * a typo shows in the log instead of silently changing how runs behave.
 */
export function parseRunProfiles(raw: unknown, warn: (line: string) => void): Record<string, RunProfile> | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warn(`run_profiles ignored: expected an object of named profiles`);
		return undefined;
	}
	const out: Record<string, RunProfile> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			warn(`run_profiles.${name} ignored: expected an object`);
			continue;
		}
		const v = value as Record<string, unknown>;
		const dropped: string[] = [];
		const p: RunProfile = {};
		if (v.model !== undefined) {
			if (typeof v.model === "string" && /^\S+$/.test(v.model.trim())) p.model = v.model.trim();
			else dropped.push(`model ${JSON.stringify(v.model)}`);
		}
		if (v.effort !== undefined) {
			if (typeof v.effort === "string" && RUN_EFFORTS.includes(v.effort)) p.effort = v.effort as RunEffort;
			else dropped.push(`effort ${JSON.stringify(v.effort)} (allowed: ${RUN_EFFORTS.join(", ")})`);
		}
		if (v.preload_skills !== undefined) {
			if (Array.isArray(v.preload_skills)) {
				const good = v.preload_skills.filter((s): s is string => typeof s === "string" && SKILL_NAME.test(s));
				const bad = v.preload_skills.filter((s) => !(typeof s === "string" && SKILL_NAME.test(s)));
				if (bad.length) dropped.push(`preload_skills ${bad.map((b) => JSON.stringify(b)).join(", ")}`);
				if (good.length) p.preloadSkills = good;
			} else {
				dropped.push(`preload_skills (expected a list of skill names)`);
			}
		}
		if (v.linger_minutes !== undefined) {
			if (typeof v.linger_minutes === "number" && Number.isFinite(v.linger_minutes) && v.linger_minutes > 0) p.lingerMinutes = v.linger_minutes;
			else dropped.push(`linger_minutes ${JSON.stringify(v.linger_minutes)}`);
		}
		if (v.linger_max_open !== undefined) {
			if (typeof v.linger_max_open === "number" && Number.isInteger(v.linger_max_open) && v.linger_max_open > 0) p.lingerMaxOpen = v.linger_max_open;
			else dropped.push(`linger_max_open ${JSON.stringify(v.linger_max_open)}`);
		}
		if (dropped.length) warn(`run_profiles.${name}: dropped ${dropped.join("; ")}`);
		out[name] = p;
	}
	return Object.keys(out).length ? out : undefined;
}

/** The model a run uses: its profile's, else the agent's. */
export function profileModel(agent: AgentConfig, profile?: string): string | undefined {
	const p = profile ? agent.runProfiles?.[profile] : undefined;
	return p?.model || agent.model;
}

/**
 * Docker `-e` args for a run's profile. An unknown or missing profile gives the
 * agent defaults: its model only, default effort, nothing preloaded, no wait.
 */
export function profileEnv(agent: AgentConfig, profile?: string): string[] {
	const p = profile ? agent.runProfiles?.[profile] : undefined;
	const args: string[] = [];
	const model = profileModel(agent, profile);
	if (model) args.push("-e", `AGENT_MODEL=${model}`);
	if (p?.effort) args.push("-e", `AGENT_EFFORT=${p.effort}`);
	if (p?.preloadSkills?.length) args.push("-e", `PRELOAD_SKILLS=${p.preloadSkills.join(",")}`);
	if (p?.lingerMinutes) args.push("-e", `MIDRUN_LINGER_MS=${Math.round(p.lingerMinutes * 60_000)}`);
	return args;
}

interface AgentManifest {
	slack_bot_id?: string;
	slack_channel?: string;
	max_turns?: number;
	allowed_tools?: string[];
	boundaries?: AgentBoundaries;
	work_hours?: Partial<AgentWorkHours>;
	allow_unverified_senders?: boolean;
	wake_inbox?: boolean;
	midrun_messages?: boolean;
	model?: string;
	button_ttl_hours?: number;
	whatsapp?: unknown;
	extra_mounts?: unknown;
	accept_bots?: unknown;
	handoff_channels?: unknown;
	agent_turn_cap?: unknown;
	tool_servers?: unknown;
	run_profiles?: unknown;
}

// How long an interactive (actions) block stays live before the listener's
// sweep retires it. Per-agent override via config.json `button_ttl_hours`.
const DEFAULT_BUTTON_TTL_HOURS = 48;

// Read-only agents are restricted to a tool set that cannot mutate the
// container filesystem or invoke shell-level write operations. The runner
// enforces this by overriding allowed_tools at spawn time, regardless of
// what the agent's config.json declares.
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];

function applyBoundaries(
	declaredTools: string[],
	boundaries: AgentBoundaries,
): string[] {
	if (boundaries === "read-only") {
		// Intersect declared with allowlist — never expand beyond READ_ONLY_TOOLS.
		const allowSet = new Set(READ_ONLY_TOOLS);
		const restricted = declaredTools.filter((t) => allowSet.has(t));
		// If config declared an empty/unhelpful set, fall back to the full
		// read-only allowlist so the agent isn't crippled.
		return restricted.length ? restricted : READ_ONLY_TOOLS;
	}
	return declaredTools;
}

// ─── Auto-discover agents from agents/ directory ───────────
export function loadAgents(): AgentConfig[] {
	const discovered: AgentConfig[] = [];

	if (!existsSync(AGENTS_DIR)) return discovered;

	for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;

		const agentDir = path.join(AGENTS_DIR, entry.name);
		const promptPath = path.join(agentDir, "PROMPT.md");
		const slackPath = path.join(agentDir, "slack.json");
		const configPath = path.join(agentDir, "config.json");
		const credsPath = path.join(agentDir, "credentials.json");

		if (!existsSync(promptPath)) continue;

		let slackBotId = "";
		let slackBotMsgId = "";
		let slackChannel = "";
		if (existsSync(slackPath)) {
			try {
				const slack = JSON.parse(readFileSync(slackPath, "utf-8"));
				slackBotId = slack.bot_user_id || "";
				slackBotMsgId = slack.bot_id || "";
				slackChannel = slack.channel?.id || "";
			} catch {}
		}

		// Load agent config
		let manifest: AgentManifest = {};
		if (existsSync(configPath)) {
			try {
				manifest = JSON.parse(readFileSync(configPath, "utf-8"));
			} catch {}
		}

		// Pull per-agent Slack tokens from credentials.json (preferred).
		// Falls back to root .env for the single-agent case.
		let slackBotToken = "";
		let slackAppToken = "";
		let whatsappToken = "";
		let creds: Record<string, unknown> | null = null;
		if (existsSync(credsPath)) {
			try {
				creds = JSON.parse(readFileSync(credsPath, "utf-8"));
				const c = (creds || {}) as Record<string, any>;
				slackBotToken = c.slack_bot_token || "";
				slackAppToken = c.slack_app_token || "";
				whatsappToken = typeof c.whatsapp_token === "string" ? c.whatsapp_token.trim() : "";
			} catch {}
		}
		if (!slackBotToken) slackBotToken = process.env.SLACK_BOT_TOKEN || "";
		if (!slackAppToken) slackAppToken = process.env.SLACK_APP_TOKEN || "";

		const boundaries: AgentBoundaries = manifest.boundaries === "read-only"
			? "read-only"
			: "write";
		const declaredTools = manifest.allowed_tools || [
			"Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch",
		];
		const bots = parseBotPolicy(manifest);
		for (const w of bots.warnings) console.warn(`[${entry.name}] ${w}`);
		const tools = parseToolServers(manifest, creds && typeof creds === "object" ? creds : null);
		for (const e of tools.errors) console.warn(`[${entry.name}] ${e}`);
		const toolServerNames = Object.keys(tools.servers);
		if (toolServerNames.length) console.log(`[${entry.name}] Tool servers: ${toolServerNames.join(", ")}`);
		const wh = manifest.work_hours || {};
		const workHours: AgentWorkHours = {
			enabled: wh.enabled === true,
			start: wh.start || "09:00",
			end: wh.end || "18:00",
			days: wh.days || ["mon", "tue", "wed", "thu", "fri"],
			off_hours_behavior: wh.off_hours_behavior || "queue",
		};
		discovered.push({
			name: entry.name,
			dir: agentDir,
			slackBotId: manifest.slack_bot_id || slackBotId,
			slackBotMsgId: slackBotMsgId,
			slackChannel: manifest.slack_channel || slackChannel,
			slackBotToken,
			slackAppToken,
			maxTurns: manifest.max_turns || 50,
			allowedTools: applyBoundaries(declaredTools, boundaries),
			boundaries,
			workHours,
			allowUnverifiedSenders: manifest.allow_unverified_senders === true,
			wakeInbox: manifest.wake_inbox === true,
			midrunMessages: manifest.midrun_messages !== false,
			model: manifest.model,
			buttonTtlHours: typeof manifest.button_ttl_hours === "number" && manifest.button_ttl_hours > 0
				? manifest.button_ttl_hours
				: DEFAULT_BUTTON_TTL_HOURS,
			whatsapp: parseWhatsAppConfig(manifest.whatsapp),
			whatsappToken,
			extraMounts: checkHostPaths(
				entry.name,
				parseExtraMounts(manifest.extra_mounts, (line) => console.warn(`[${entry.name}] ${line}`)),
				extraMountHost(),
				(line) => console.warn(`[${entry.name}] ${line}`),
			),
			botPolicy: bots.policy,
			toolServers: toolServerNames.length ? toolServerRefs(manifest, tools.servers) : undefined,
			runProfiles: parseRunProfiles(manifest.run_profiles, (line) => console.warn(`[${entry.name}] ${line}`)),
		});
	}

	return discovered;
}

export let agents: AgentConfig[] = loadAgents();

/**
 * Run a new agent session in an isolated Docker container.
 * Returns the session ID for thread tracking.
 */
export async function runAgent(
	agent: AgentConfig,
	message: string,
	origin: DeliveryOrigin = "slack",
	// Inbox folder for messages that arrive while this run works (midrun-inbox.ts).
	midrunDir?: string,
	// Kind of run (a key of config.json "run_profiles"); none = agent defaults.
	profile?: string,
): Promise<AgentRunResult> {
	return spawnContainer(agent, message, undefined, origin, midrunDir, profile);
}

/**
 * Resume an existing agent session in a container.
 */
export async function resumeAgent(
	agent: AgentConfig,
	sessionId: string,
	message: string,
	origin: DeliveryOrigin = "slack",
	midrunDir?: string,
	profile?: string,
): Promise<AgentRunResult> {
	return spawnContainer(agent, message, sessionId, origin, midrunDir, profile);
}

/**
 * Outcome of a single container run. `isError` is true when the container
 * exited non-zero OR the entrypoint emitted `is_error` (e.g. an API rejection
 * like "Could not process image") — in that case the agent did NOT post a
 * reply and the caller must surface something to the user.
 */
export interface AgentRunResult {
	sessionId: string;
	isError: boolean;
	result: string;
	// True when the run ended on a Claude usage limit on every account tried.
	// Not counted as a run failure.
	limitHit?: boolean;
	// Label of the Claude account the final attempt ran on ("A", "B", ...).
	account?: string | null;
	// Model the SDK reported for the run.
	model?: string;
}

/**
 * Run on the first Claude account not cooling down; on a usage limit, cool
 * that account and retry once on the next (see claude-accounts.ts).
 */
async function spawnContainer(
	agent: AgentConfig,
	message: string,
	resumeId?: string,
	origin: DeliveryOrigin = "slack",
	midrunDir?: string,
	profile?: string,
): Promise<AgentRunResult> {
	if (profile && !agent.runProfiles?.[profile]) {
		console.warn(`[${agent.name}] Run profile "${profile}" is not in config.json run_profiles; using the agent defaults`);
	}
	let out;
	try {
		out = await runWithAccountFallback({
			accounts: loadClaudeAccounts(process.env),
			cooldownFile: ACCOUNT_COOLDOWNS_FILE,
			// The run's own model, so a limit on one model family cools only that family.
			model: profileModel(agent, profile),
			// A continuation resumes the limited try's session on the next
			// account instead of replaying the original request.
			attempt: (account, cont) =>
				spawnAttempt(agent, cont ? cont.message : message, cont ? cont.sessionId : resumeId, origin, account, !!cont, midrunDir, profile),
			log: (line) => console.log(`[${agent.name}] ${line}`),
		});
	} catch (err) {
		recordRunOutcome(RUN_FAILURES_FILE, agent.name, true, `Failed to spawn container: ${String(err)}`);
		throw err;
	}
	// Feeds the watcher's "N failed runs in a row" alert; a usage limit is not
	// a broken agent and leaves the streak alone.
	if (!recordFinalOutcome(RUN_FAILURES_FILE, agent.name, out)) {
		console.log(`[${agent.name}] Run stopped on a usage limit (account ${out.account ?? "none"}); not counted as a failure`);
	}
	return {
		sessionId: out.sessionId,
		isError: out.isError,
		result: out.result,
		limitHit: out.limitHit,
		account: out.account,
		model: out.model,
	};
}

/**
 * What a container's stdout says about its run. The entrypoint prints one JSON
 * line per result, and a run that takes in a mid-run message can have more
 * than one. The LAST one decides: a run that hit an error, then answered a
 * message it had been handed, ended well. A non-zero exit is always an error.
 */
export function parseRunOutput(stdout: string, exitCode: number | null, resumeId?: string): Omit<AttemptResult, "stderr"> {
	let sessionId = resumeId || `session_${Date.now()}`;
	let lastIsError = false;
	let result = "";
	let model = "";
	let limit: AttemptResult["limit"] = null;
	let toolCalls: number | undefined;
	let reportedSessionId = "";
	for (const line of stdout.trim().split("\n")) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.session_id) sessionId = reportedSessionId = parsed.session_id;
			if (typeof parsed.tool_calls === "number") toolCalls = parsed.tool_calls;
			if ("is_error" in parsed) lastIsError = !!parsed.is_error;
			if (typeof parsed.result === "string") result = parsed.result;
			if (typeof parsed.model === "string" && parsed.model) model = parsed.model;
			if (parsed.limit_hit) {
				limit = {
					type: typeof parsed.limit_type === "string" ? parsed.limit_type : null,
					resetsAt: typeof parsed.resets_at === "number" ? parsed.resets_at : null,
				};
			} else if ("is_error" in parsed) {
				limit = null;
			}
		} catch {}
	}
	const isError = exitCode !== 0 || lastIsError;
	return {
		sessionId,
		isError,
		result,
		model: model || undefined,
		limit: isError ? limit : null,
		toolCalls,
		reportedSessionId: reportedSessionId || undefined,
	};
}

export interface AttemptExtras {
	/** Marks a replay run (see replay.ts). */
	replay?: boolean;
	/** Extra container env; the caller has checked the names. */
	env?: Record<string, string>;
}

export function spawnAttempt(
	agent: AgentConfig,
	message: string,
	resumeId: string | undefined,
	origin: DeliveryOrigin,
	account: ClaudeAccount | null,
	// A continuation after a usage limit: if its session is gone the run must
	// fail, never start over (that would repeat completed actions).
	strictResume = false,
	midrunDir?: string,
	profile?: string,
	// A replay run (replay.ts): its own container name, no bottom-line
	// channel, and extra env passed by name (values in docker's own env).
	extras?: AttemptExtras,
): Promise<AttemptResult> {
	return new Promise((resolve, reject) => {
		// A replay runs only on an account token: never on the host's own
		// Claude login file (it holds more than this run should see).
		if (extras?.replay && !account) {
			throw new Error("a replay needs a Claude account token (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY); it never uses the host login file");
		}
		const containerName = `ginnie-${extras?.replay ? "replay-" : ""}${agent.name}-${Date.now()}`;

		// Ensure directories exist
		const memoryDir = path.join(agent.dir, "memory");
		const episodesDir = path.join(memoryDir, "episodes");
		const sessionsDir = path.join(agent.dir, "sessions");
		if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
		if (!existsSync(episodesDir)) mkdirSync(episodesDir, { recursive: true });
		if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

		// Auth: two supported modes, resolved into `account` by
		// claude-accounts.ts (loadClaudeAccounts).
		//
		// Option A — Long-lived OAuth token (CLAUDE_CODE_OAUTH_TOKEN) from
		//   `claude setup-token`. ~1y, tied to a Claude subscription. Per
		//   Anthropic's usage policy this is for ordinary individual use of
		//   Claude Code by the subscriber — not for serving other users.
		//   Optional further subscriptions (CLAUDE_CODE_OAUTH_TOKEN_2, ...) are
		//   used only while an earlier one is in a usage-limit cooldown.
		// Option B — Anthropic API key (ANTHROPIC_API_KEY) from
		//   console.anthropic.com. Per-token billing, fully supported for
		//   automation and multi-user scenarios.
		//
		// If both are set, ANTHROPIC_API_KEY wins (explicit > inherited).
		// If neither is set, fall back to mounting the host's
		// ~/.claude/.credentials.json (8h OAuth, can't refresh inside the
		// read-only container — last resort).
		if (!account && !process.env.HOME) {
			throw new Error(
				"No auth available: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, " +
				"or ensure HOME is set so host credentials can be mounted.",
			);
		}
		const hostCredentials = path.join(
			process.env.HOME || "",
			".claude", ".credentials.json",
		);

		const dockerArgs = [
			"run",
			"--rm",
			"--name", containerName,
			// Resource limits
			"--memory", "1g",
			"--cpus", "2",
			"--pids-limit", "512",
			// Network access for API calls
			"--network", "bridge",
			// Hardening: drop all Linux capabilities + block new privileges.
			// The agent runs as the unprivileged `node` user inside the
			// container; these two flags prevent capability-based escape and
			// privilege escalation via setuid binaries even if a payload makes
			// it past the SDK's allowed-tools filter. --read-only of the root
			// filesystem is a separate (deeper) change that needs explicit
			// tmpfs + per-mount review and is on the v0.2.x roadmap.
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			// Timezone — defaults to UTC, override via TZ env var
			"-e", `TZ=${process.env.TZ || "UTC"}`,
			"-e", `AGENT_MESSAGE=${message}`,
			"-e", `AGENT_NAME=${agent.name}`,
			"-e", `MAX_TURNS=${agent.maxTurns}`,
			"-e", `ALLOWED_TOOLS=${agent.allowedTools.join(",")}`,
		];

		const deliveryText = deliveryInstruction(origin);
		if (deliveryText) {
			dockerArgs.push("-e", `DELIVERY_INSTRUCTION=${deliveryText}`);
		}

		// Token by name only; its value rides in the docker client's env.
		const auth = accountDockerAuth(account);
		dockerArgs.push(...auth.args);

		if (resumeId) {
			dockerArgs.push("-e", `RESUME_SESSION_ID=${resumeId}`);
			if (strictResume) dockerArgs.push("-e", "RESUME_STRICT=1");
		}

		// Model, effort, preloaded skills and open-run wait for this kind of run.
		dockerArgs.push(...profileEnv(agent, profile));

		// Caller env for a replay: the name here, the value in docker's env.
		for (const name of Object.keys(extras?.env ?? {})) dockerArgs.push("-e", name);

		// Bottom-line channel (framework/skills/bottom-line). Off when unset, and in a replay.
		if (!extras?.replay) dockerArgs.push(...bottomLineDockerEnv(process.env));

		// WhatsApp gateway agent API (framework/skills/whatsapp). The token is
		// not passed here; the agent reads it from its credentials.json mount.
		dockerArgs.push(...whatsappDockerArgs(agent.whatsapp));

		// MCP tool servers (config.json "tool_servers"): url + token_key only;
		// the entrypoint reads the token from the credentials.json mount.
		dockerArgs.push(...toolServersDockerEnv(agent.toolServers));

		// Mount agent's .claude directory (session persistence, settings).
		// Only overlay host credentials.json when neither auth env var is set —
		// the env vars take precedence and avoid the 8h OAuth refresh problem.
		const claudeDir = path.join(agent.dir, "sessions");
		dockerArgs.push(
			"-v", `${claudeDir}:/home/node/.claude`,
		);
		if (!account && !extras?.replay && existsSync(hostCredentials)) {
			dockerArgs.push("-v", `${hostCredentials}:/home/node/.claude/.credentials.json:ro`);
		}

		// Mount agent files
		dockerArgs.push(
			// System prompt (read-only)
			"-v", `${agent.dir}/PROMPT.md:/workspace/PROMPT.md:ro`,
			// Memory (read-write — agent updates it)
			"-v", `${memoryDir}:/workspace/memory`,
		);

		// Soul — backstory, voice, quirks. Read-only. Auto-injected by entrypoint
		// between the team directory and the memory-curation skill, so the agent
		// forms identity before learning the operational layer. NOT in prompt.md.
		const soulPath = path.join(agent.dir, "SOUL.md");
		if (existsSync(soulPath)) {
			dockerArgs.push("-v", `${soulPath}:/workspace/SOUL.md:ro`);
		}

		// Agent credentials for external APIs (read-only, if exists)
		const credsPath = path.join(agent.dir, "credentials.json");
		if (existsSync(credsPath)) {
			dockerArgs.push("-v", `${credsPath}:/workspace/credentials.json:ro`);
		}

		// Schedules (read-write — agent can view and modify own schedules)
		const schedulesPath = path.join(agent.dir, "schedules.json");
		if (existsSync(schedulesPath)) {
			dockerArgs.push("-v", `${schedulesPath}:/workspace/schedules.json`);
		}

		// Per-agent persistent data directory — cursors, CRM, scratch state,
		// any cross-session machine state the agent owns. Read-write, mounted
		// at /workspace/data. Generic primitive; the framework imposes no
		// schema or filename. Agents that don't need it just skip the dir.
		const dataDir = path.join(agent.dir, "data");
		if (existsSync(dataDir)) {
			dockerArgs.push("-v", `${dataDir}:/workspace/data`);
		}

		// Skills directory (read-only, if exists)
		const skillsDir = path.join(agent.dir, "skills");
		if (existsSync(skillsDir)) {
			dockerArgs.push("-v", `${skillsDir}:/workspace/skills:ro`);
		}

		// Per-agent known-users (read-only, if exists). The entrypoint merges
		// this with /workspace/.shared/known-users.json — same key in both,
		// local wins for that entry; otherwise union.
		const localKnownUsersPath = path.join(agent.dir, "known-users.json");
		if (existsSync(localKnownUsersPath)) {
			dockerArgs.push("-v", `${localKnownUsersPath}:/workspace/known-users.json:ro`);
		}

		// Shared platform context (team directory, optional foundation, user-defined
		// shared skills). Entrypoint auto-prepends foundation + team directory to
		// the system prompt — every agent inherits.
		const sharedDir = path.join(__dirname, "..", "..", "shared");
		if (existsSync(sharedDir)) {
			dockerArgs.push("-v", `${sharedDir}:/workspace/.shared:ro`);
		}

		// Framework-internal skills (memory-curation, etc.) — auto-mounted into
		// every agent. These ship with the framework and update via `git pull`.
		const frameworkSkillsDir = path.join(__dirname, "..", "..", "framework", "skills");
		if (existsSync(frameworkSkillsDir)) {
			dockerArgs.push("-v", `${frameworkSkillsDir}:/workspace/.framework/skills:ro`);
		}

		// Read-only extra mounts from config.json (under /workspace/mounts).
		dockerArgs.push(...extraMountDockerArgs(agent.name, agent.extraMounts ?? [], extraMountHost(), (line) => console.warn(`[${agent.name}] ${line}`)));

		// Inbox for messages that arrive while the run works; none = one prompt, as before.
		dockerArgs.push(...midrunDockerArgs(midrunDir));

		// Docker image
		dockerArgs.push(DOCKER_IMAGE);

		// Account label and requested model only; never the token.
		console.log(
			`[${agent.name}] Starting container ${containerName}${resumeId ? " (resume)" : " (new)"} ` +
			`account=${account ? account.label : "host-credentials"} model=${profileModel(agent, profile) || "default"}` +
			`${profile ? ` profile=${profile}` : ""}...`,
		);

		const child = spawn("docker", dockerArgs, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...(extras?.env ?? {}), ...auth.env },
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		child.stderr.on("data", (data: Buffer) => {
			const line = data.toString();
			stderr += line;
			// Stream agent's stderr to listener's console for real-time visibility
			process.stderr.write(`[${agent.name}] ${line}`);
		});

		child.on("close", (code) => {
			if (code !== 0) {
				console.error(`[${agent.name}] Container exited with code ${code}`);
			}

			const out = parseRunOutput(stdout, code, resumeId);
			console.log(
				`[${agent.name}] Container done: ${out.sessionId.slice(0, 30)}... ` +
				`model=${out.model || "unknown"} account=${account ? account.label : "host-credentials"}` +
				`${out.limit ? " (USAGE LIMIT)" : out.isError ? " (ERROR)" : ""}`,
			);
			resolve({ ...out, stderr });
		});

		child.on("error", (err) => {
			console.error(`[${agent.name}] Failed to spawn container:`, err);
			reject(err);
		});
	});
}
