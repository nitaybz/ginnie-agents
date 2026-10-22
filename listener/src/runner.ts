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
import { readdirSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { deliveryInstruction, type DeliveryOrigin } from "./studio-delivery";
import { RUN_FAILURES_FILE, pickErrorLine, recordRunOutcome } from "./run-failures";
import { bottomLineDockerEnv } from "./bottom-line";
import { parseWhatsAppConfig, whatsappDockerArgs, type WhatsAppConfig } from "./whatsapp-trigger";
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
const DOCKER_IMAGE = "ginnie-agent";

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
	model?: string;
	buttonTtlHours: number;
	// Optional WhatsApp access + wake-up (config.json "whatsapp"; token in
	// credentials.json "whatsapp_token"). See whatsapp-trigger.ts.
	whatsapp?: WhatsAppConfig;
	whatsappToken?: string;
}

interface AgentManifest {
	slack_bot_id?: string;
	slack_channel?: string;
	max_turns?: number;
	allowed_tools?: string[];
	boundaries?: AgentBoundaries;
	work_hours?: Partial<AgentWorkHours>;
	allow_unverified_senders?: boolean;
	model?: string;
	button_ttl_hours?: number;
	whatsapp?: unknown;
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
		if (existsSync(credsPath)) {
			try {
				const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
				slackBotToken = creds.slack_bot_token || "";
				slackAppToken = creds.slack_app_token || "";
				whatsappToken = typeof creds.whatsapp_token === "string" ? creds.whatsapp_token.trim() : "";
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
			model: manifest.model,
			buttonTtlHours: typeof manifest.button_ttl_hours === "number" && manifest.button_ttl_hours > 0
				? manifest.button_ttl_hours
				: DEFAULT_BUTTON_TTL_HOURS,
			whatsapp: parseWhatsAppConfig(manifest.whatsapp),
			whatsappToken,
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
): Promise<AgentRunResult> {
	return spawnContainer(agent, message, undefined, origin);
}

/**
 * Resume an existing agent session in a container.
 */
export async function resumeAgent(
	agent: AgentConfig,
	sessionId: string,
	message: string,
	origin: DeliveryOrigin = "slack",
): Promise<AgentRunResult> {
	return spawnContainer(agent, message, sessionId, origin);
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
): Promise<AgentRunResult> {
	let out;
	try {
		out = await runWithAccountFallback({
			accounts: loadClaudeAccounts(process.env),
			cooldownFile: ACCOUNT_COOLDOWNS_FILE,
			model: agent.model,
			// A continuation resumes the limited try's session on the next
			// account instead of replaying the original request.
			attempt: (account, cont) =>
				spawnAttempt(agent, cont ? cont.message : message, cont ? cont.sessionId : resumeId, origin, account, !!cont),
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

export function spawnAttempt(
	agent: AgentConfig,
	message: string,
	resumeId: string | undefined,
	origin: DeliveryOrigin,
	account: ClaudeAccount | null,
	// A continuation after a usage limit: if its session is gone the run must
	// fail, never start over (that would repeat completed actions).
	strictResume = false,
): Promise<AttemptResult> {
	return new Promise((resolve, reject) => {
		const containerName = `ginnie-${agent.name}-${Date.now()}`;

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

		if (agent.model) {
			dockerArgs.push("-e", `AGENT_MODEL=${agent.model}`);
		}

		// Bottom-line channel (framework/skills/bottom-line). Off when unset.
		dockerArgs.push(...bottomLineDockerEnv(process.env));

		// WhatsApp gateway agent API (framework/skills/whatsapp). The token is
		// not passed here; the agent reads it from its credentials.json mount.
		dockerArgs.push(...whatsappDockerArgs(agent.whatsapp));

		// Mount agent's .claude directory (session persistence, settings).
		// Only overlay host credentials.json when neither auth env var is set —
		// the env vars take precedence and avoid the 8h OAuth refresh problem.
		const claudeDir = path.join(agent.dir, "sessions");
		dockerArgs.push(
			"-v", `${claudeDir}:/home/node/.claude`,
		);
		if (!account && existsSync(hostCredentials)) {
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

		// Docker image
		dockerArgs.push(DOCKER_IMAGE);

		// Account label and requested model only; never the token.
		console.log(
			`[${agent.name}] Starting container ${containerName}${resumeId ? " (resume)" : " (new)"} ` +
			`account=${account ? account.label : "host-credentials"} model=${agent.model || "default"}...`,
		);

		const child = spawn("docker", dockerArgs, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...auth.env },
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

			// Parse structured output from stdout. The entrypoint emits one JSON
			// line per result: { session_id, is_error, result, ... }.
			let sessionId = resumeId || `session_${Date.now()}`;
			let isError = code !== 0; // non-zero exit always counts as an error
			let result = "";
			let model = "";
			let limit: AttemptResult["limit"] = null;
			let toolCalls: number | undefined;
			let reportedSessionId = "";
			try {
				const lines = stdout.trim().split("\n");
				for (const line of lines) {
					try {
						const parsed = JSON.parse(line);
						if (parsed.session_id) sessionId = reportedSessionId = parsed.session_id;
						if (typeof parsed.tool_calls === "number") toolCalls = parsed.tool_calls;
						if (parsed.is_error) isError = true;
						if (typeof parsed.result === "string") result = parsed.result;
						if (typeof parsed.model === "string" && parsed.model) model = parsed.model;
						if (parsed.limit_hit) {
							limit = {
								type: typeof parsed.limit_type === "string" ? parsed.limit_type : null,
								resetsAt: typeof parsed.resets_at === "number" ? parsed.resets_at : null,
							};
						}
					} catch {}
				}
			} catch {}

			console.log(
				`[${agent.name}] Container done: ${sessionId.slice(0, 30)}... ` +
				`model=${model || "unknown"} account=${account ? account.label : "host-credentials"}` +
				`${limit ? " (USAGE LIMIT)" : isError ? " (ERROR)" : ""}`,
			);
			resolve({
				sessionId,
				isError,
				result,
				model: model || undefined,
				limit: isError ? limit : null,
				stderr,
				toolCalls,
				reportedSessionId: reportedSessionId || undefined,
			});
		});

		child.on("error", (err) => {
			console.error(`[${agent.name}] Failed to spawn container:`, err);
			reject(err);
		});
	});
}
