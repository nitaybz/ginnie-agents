/**
 * Agent Entrypoint — runs inside the Docker container spawned by the listener.
 * Uses the Claude Agent SDK to execute the agent's task in isolation.
 *
 * Environment variables:
 *   CLAUDE_CODE_OAUTH_TOKEN — Long-lived (1y) token from `claude setup-token`.
 *                             Recommended. Falls back to mounted host credentials.
 *   AGENT_MESSAGE          — The prompt/task for the agent
 *   AGENT_NAME             — Agent name (for logging + system prompt headers)
 *   RESUME_SESSION_ID      — Optional: session ID to resume
 *   MAX_TURNS              — Optional: max agentic turns (default: 50)
 *   ALLOWED_TOOLS          — Optional: comma-separated tool list
 *   TZ                     — Optional: container timezone (default: UTC)
 */

import { createRequire } from "module";
const require = createRequire("/app/");
const { query } = require("@anthropic-ai/claude-agent-sdk");
import { readFileSync, existsSync } from "fs";

const message = process.env.AGENT_MESSAGE;
const agentName = process.env.AGENT_NAME || "agent";
const resumeId = process.env.RESUME_SESSION_ID || undefined;
const maxTurns = parseInt(process.env.MAX_TURNS || "50", 10);

// Parse allowed tools (default: full set for autonomous agents)
const defaultTools = [
	"Bash", "Read", "Write", "Edit", "Glob", "Grep",
	"WebSearch", "WebFetch",
];
const allowedTools = process.env.ALLOWED_TOOLS
	? process.env.ALLOWED_TOOLS.split(",").map((t) => t.trim())
	: defaultTools;

if (!message) {
	console.error(`[${agentName}] ERROR: AGENT_MESSAGE not set`);
	process.exit(1);
}

// Auth: uses Max subscription via mounted ~/.claude/.credentials.json
// Falls back to ANTHROPIC_API_KEY env var if set

// Read system prompt.
//
// Composition order:
//   1. /workspace/.shared/foundation.md        — optional user-supplied foundation
//                                                (company context, sender rules, etc.)
//   2. rendered team directory from            — who's who (humans + agents)
//      /workspace/.shared/known-users.json
//   3. /workspace/SOUL.md                      — agent's backstory, voice, quirks
//   4. /workspace/.framework/skills/           — canonical memory model (framework-shipped)
//      memory-curation/SKILL.md
//   5. /workspace/PROMPT.md                    — agent-specific role & behaviors
//   6. /workspace/memory/rules.md              — agent's USER-STATED RULES (always loaded)
//   7. /workspace/memory/playbook.md           — agent's SETTLED PATTERNS (always loaded)
//
// Episodes (/workspace/memory/episodes/*.md) are NOT auto-loaded. The agent
// greps them on demand. This keeps the system prompt bounded regardless of
// how long the agent has been running.
//
// The .shared and .framework mounts are read-only. Agents don't need to (and
// shouldn't) reference these files from PROMPT.md — they're already prepended.

function loadUsers(filePath) {
	if (!existsSync(filePath)) return {};
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8"));
		return data.users || {};
	} catch (e) {
		console.error(`[${agentName}] Warning: failed to read ${filePath}:`, e);
		return {};
	}
}

function mergeUsers(sharedUsers, localUsers) {
	// shared ∪ local with per-entry override: same key in both → local wins
	// for that key only. Never whole-file replacement.
	const merged = { ...sharedUsers };
	for (const [slackId, u] of Object.entries(localUsers)) {
		if (merged[slackId]) {
			console.error(
				`[${agentName}] Notice: known-user \`${slackId}\` defined in both shared and local; local wins.`,
			);
		}
		merged[slackId] = u;
	}
	return merged;
}

function renderTeamDirectory(sharedKnownUsersPath, localKnownUsersPath) {
	const shared = loadUsers(sharedKnownUsersPath);
	const local = loadUsers(localKnownUsersPath);
	const users = mergeUsers(shared, local);
	if (!Object.keys(users).length) return "";
	const lines = ["## Team Directory (generated)", ""];
	const humans = [];
	const agents = [];
	for (const [slackId, u] of Object.entries(users)) {
		if (u.kind === "human") humans.push([slackId, u]);
		else if (u.kind === "agent") agents.push([slackId, u]);
	}
	if (humans.length) {
		lines.push("### Humans");
		for (const [slackId, u] of humans) {
			lines.push(`- **${u.short_name || u.name}** (${u.title || u.role}) — slack \`${slackId}\`${u.email ? `, email \`${u.email}\`` : ""}${u.supabase_id ? `, supabase \`${u.supabase_id}\`` : ""}`);
			if (u.responsibilities) lines.push(`  - ${u.responsibilities}`);
			if (u.authority) lines.push(`  - **Authority:** ${u.authority}`);
			if (u.tone) lines.push(`  - **Tone:** ${u.tone}`);
		}
		lines.push("");
	}
	if (agents.length) {
		lines.push("### Agents");
		for (const [slackId, u] of agents) {
			lines.push(`- **${u.short_name || u.name}** (${u.title || u.role}) — slack \`${slackId}\`${u.channel ? `, channel ${u.channel}` : ""}`);
			if (u.responsibilities) lines.push(`  - ${u.responsibilities}`);
			if (u.authority) lines.push(`  - **Authority:** ${u.authority}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

let systemPrompt = undefined;
const foundationPath = "/workspace/.shared/foundation.md";
const sharedKnownUsersPath = "/workspace/.shared/known-users.json";
const localKnownUsersPath = "/workspace/known-users.json";
const soulPath = "/workspace/SOUL.md";
const memorySkillPath = "/workspace/.framework/skills/memory-curation/SKILL.md";
const promptPath = "/workspace/PROMPT.md";
const rulesPath = "/workspace/memory/rules.md";
const playbookPath = "/workspace/memory/playbook.md";

const parts = [];
if (existsSync(foundationPath)) parts.push(readFileSync(foundationPath, "utf-8"));
const teamDir = renderTeamDirectory(sharedKnownUsersPath, localKnownUsersPath);
if (teamDir) parts.push(teamDir);

// Soul — who the agent is (backstory, voice, quirks). Sits between the team
// directory and the operational layer so identity is formed before job. The
// agent should *speak from* this, never quote it back at users.
if (existsSync(soulPath)) {
	const body = readFileSync(soulPath, "utf-8").trim();
	if (body) {
		parts.push(
			`# ${agentName} — Soul\n\n` +
			`This is who you are. Speak from it — your voice, your quirks, your background. Don't recite it back to users; let it color how you write. If something here ever feels wrong about you, say so.\n\n` +
			body
		);
	}
}

if (existsSync(memorySkillPath)) parts.push(readFileSync(memorySkillPath, "utf-8"));
if (existsSync(promptPath)) parts.push(readFileSync(promptPath, "utf-8"));

// Always-loaded memory tiers. Rules and playbook are injected here — the
// agent MUST NOT re-read them. Episodes are lazy (grep on demand).
if (existsSync(rulesPath)) {
	const body = readFileSync(rulesPath, "utf-8").trim();
	parts.push(
		`# ${agentName} — Rules (user-stated, always in effect)\n\n` +
		`These are direct user requirements, corrections, and preferences. Follow them literally. To amend or add, edit \`./memory/rules.md\` in place (see memory-curation skill).\n\n` +
		(body || "_(no rules yet)_")
	);
}
if (existsSync(playbookPath)) {
	const body = readFileSync(playbookPath, "utf-8").trim();
	parts.push(
		`# ${agentName} — Playbook (settled patterns)\n\n` +
		`Validated patterns promoted from past episodes by the nightly consolidation routine. Treat as working knowledge; do not edit during live sessions.\n\n` +
		(body || "_(no playbook entries yet)_")
	);
}

if (parts.length) systemPrompt = parts.join("\n\n---\n\n");

console.error(`[${agentName}] Starting session${resumeId ? ` (resume: ${resumeId.slice(0, 20)}...)` : " (new)"}...`);
console.error(`[${agentName}] Tools: ${allowedTools.join(", ")}`);
console.error(`[${agentName}] Max turns: ${maxTurns}`);

async function runSession(resumeSessionId) {
	let sessionId = resumeSessionId || "";

	for await (const msg of query({
		prompt: message,
		options: {
			systemPrompt,
			allowedTools,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			maxTurns,
			cwd: "/workspace",
			resume: resumeSessionId,
			persistSession: true,
			model: process.env.AGENT_MODEL || undefined,
		},
	})) {
		if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
			sessionId = msg.session_id;
		}

		if (msg.type === "result") {
			const output = {
				session_id: sessionId || msg.session_id,
				result: msg.result || "",
				is_error: msg.is_error || false,
				num_turns: msg.num_turns || 0,
				cost_usd: msg.total_cost_usd || 0,
			};
			console.log(JSON.stringify(output));
			console.error(`[${agentName}] Done — ${msg.num_turns} turns, $${(msg.total_cost_usd || 0).toFixed(4)}`);
		}
	}
}

try {
	await runSession(resumeId);
} catch (err) {
	// If resume failed (stale session), retry as a new session
	if (resumeId && String(err).includes("No conversation found")) {
		console.error(`[${agentName}] Session ${resumeId.slice(0, 20)}... expired, starting fresh`);
		try {
			await runSession(undefined);
		} catch (retryErr) {
			console.error(`[${agentName}] FATAL:`, retryErr);
			console.log(JSON.stringify({ session_id: "", is_error: true, result: String(retryErr) }));
			process.exit(1);
		}
	} else {
		console.error(`[${agentName}] FATAL:`, err);
		console.log(JSON.stringify({ session_id: "", is_error: true, result: String(err) }));
		process.exit(1);
	}
}
