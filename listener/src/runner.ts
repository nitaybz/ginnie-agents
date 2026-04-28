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
	model?: string;
}

interface AgentManifest {
	slack_bot_id?: string;
	slack_channel?: string;
	max_turns?: number;
	allowed_tools?: string[];
	boundaries?: AgentBoundaries;
	work_hours?: Partial<AgentWorkHours>;
	model?: string;
}

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
		if (existsSync(credsPath)) {
			try {
				const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
				slackBotToken = creds.slack_bot_token || "";
				slackAppToken = creds.slack_app_token || "";
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
			model: manifest.model,
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
): Promise<string> {
	return spawnContainer(agent, message);
}

/**
 * Resume an existing agent session in a container.
 */
export async function resumeAgent(
	agent: AgentConfig,
	sessionId: string,
	message: string,
): Promise<void> {
	await spawnContainer(agent, message, sessionId);
}

function spawnContainer(
	agent: AgentConfig,
	message: string,
	resumeId?: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const containerName = `ginnie-${agent.name}-${Date.now()}`;

		// Ensure directories exist
		const memoryDir = path.join(agent.dir, "memory");
		const episodesDir = path.join(memoryDir, "episodes");
		const sessionsDir = path.join(agent.dir, "sessions");
		if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
		if (!existsSync(episodesDir)) mkdirSync(episodesDir, { recursive: true });
		if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

		// Auth: prefer the long-lived OAuth token from `claude setup-token`
		// (env var, ~1 year). Falls back to mounting the host's regular
		// ~/.claude/.credentials.json (8h OAuth, can't be refreshed inside the
		// read-only container) only if the long-lived token isn't set.
		const longLivedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";
		if (!longLivedToken && !process.env.HOME) {
			throw new Error(
				"Neither CLAUDE_CODE_OAUTH_TOKEN nor HOME is set; cannot locate Claude credentials.",
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

		if (longLivedToken) {
			dockerArgs.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${longLivedToken}`);
		}

		if (resumeId) {
			dockerArgs.push("-e", `RESUME_SESSION_ID=${resumeId}`);
		}

		if (agent.model) {
			dockerArgs.push("-e", `AGENT_MODEL=${agent.model}`);
		}

		// Mount agent's .claude directory (session persistence, settings).
		// Only overlay host credentials.json when no long-lived token is set —
		// the env var takes precedence and avoids the 8h OAuth refresh problem.
		const claudeDir = path.join(agent.dir, "sessions");
		dockerArgs.push(
			"-v", `${claudeDir}:/home/node/.claude`,
		);
		if (!longLivedToken && existsSync(hostCredentials)) {
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

		console.log(`[${agent.name}] Starting container ${containerName}${resumeId ? " (resume)" : " (new)"}...`);

		const child = spawn("docker", dockerArgs, {
			stdio: ["ignore", "pipe", "pipe"],
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

			// Parse structured output from stdout
			let sessionId = resumeId || `session_${Date.now()}`;
			try {
				const lines = stdout.trim().split("\n");
				for (const line of lines) {
					try {
						const parsed = JSON.parse(line);
						if (parsed.session_id) {
							sessionId = parsed.session_id;
						}
					} catch {}
				}
			} catch {}

			console.log(`[${agent.name}] Container done: ${sessionId.slice(0, 30)}...`);
			resolve(sessionId);
		});

		child.on("error", (err) => {
			console.error(`[${agent.name}] Failed to spawn container:`, err);
			reject(err);
		});
	});
}
