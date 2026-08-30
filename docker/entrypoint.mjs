/**
 * Agent Entrypoint — runs inside the Docker container spawned by the listener.
 * Uses the Claude Agent SDK to execute the agent's task in isolation.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY      — Anthropic API key (console.anthropic.com).
 *                             Per-token billing, fully supported for automation
 *                             and multi-user use. If both this and
 *                             CLAUDE_CODE_OAUTH_TOKEN are set, this wins.
 *   CLAUDE_CODE_OAUTH_TOKEN — Long-lived (~1y) OAuth token from
 *                             `claude setup-token`, tied to a Claude
 *                             subscription. Per Anthropic's usage policy,
 *                             intended for ordinary individual use of Claude
 *                             Code by the subscriber — not for serving other
 *                             users. If neither env var is set, falls back to
 *                             mounted host credentials (8h, non-refreshable).
 *   AGENT_MESSAGE          — The prompt/task for the agent
 *   AGENT_NAME             — Agent name (for logging + system prompt headers)
 *   RESUME_SESSION_ID      — Optional: session ID to resume
 *   MAX_TURNS              — Optional: max agentic turns (default: 50)
 *   ALLOWED_TOOLS          — Optional: comma-separated tool list
 *   TZ                     — Optional: container timezone (default: UTC)
 *   DELIVERY_INSTRUCTION   — Optional: extra system-prompt text appended after
 *                             PROMPT.md, telling the agent how to deliver its
 *                             answer for this turn's origin (e.g. Ginnie
 *                             Studio instead of Slack). Empty/unset for a
 *                             normal Slack turn.
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

// Auth: the SDK reads ANTHROPIC_API_KEY (Option B) or CLAUDE_CODE_OAUTH_TOKEN
// (Option A) from process.env directly. If neither is set, it falls back to
// the mounted host ~/.claude/.credentials.json. The runner injects whichever
// the operator chose; nothing to do here.

// Read system prompt.
//
// Composition order:
//   1. /workspace/.shared/foundation.md        — optional user-supplied foundation
//                                                (company context, sender rules, etc.)
//   2. rendered team directory from            — who's who (humans + agents)
//      /workspace/.shared/known-users.json
//   3. /workspace/SOUL.md                      — agent's backstory, voice, quirks
//   4. /workspace/.framework/skills/           — framework-shipped runtime skills
//      memory-curation/SKILL.md                  (canonical memory model)
//      routines/SKILL.md                         (canonical schedules.json schema)
//   5. /workspace/PROMPT.md                    — agent-specific role & behaviors
//   6. DELIVERY_INSTRUCTION env var (if set)   — how to deliver THIS turn's answer;
//                                                sits right after PROMPT.md so it
//                                                overrides any conflicting rule there
//   7. /workspace/memory/rules.md              — agent's USER-STATED RULES (always loaded)
//   8. /workspace/memory/playbook.md           — agent's SETTLED PATTERNS (always loaded)
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
const routinesSkillPath = "/workspace/.framework/skills/routines/SKILL.md";
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
if (existsSync(routinesSkillPath)) parts.push(readFileSync(routinesSkillPath, "utf-8"));
if (existsSync(promptPath)) parts.push(readFileSync(promptPath, "utf-8"));

// Delivery instruction — MUST come after PROMPT.md so it overrides rather
// than being overridden by any conflicting rule in it (e.g. "always reply by
// posting to the Slack thread"). Empty for a normal Slack turn.
const deliveryInstruction = (process.env.DELIVERY_INSTRUCTION || "").trim();
if (deliveryInstruction) parts.push(deliveryInstruction);

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

// Transient/ambiguous API failures that are worth one or two automatic retries.
// "Could not process image" is nominally a 400, but in practice it's an
// intermittent server-side decode hiccup (verified: the same image + container
// + model succeeds on every re-run), so we treat it as retryable. Genuinely
// deterministic 400s (bad request shape, unsupported param) won't match and
// still fail fast — no infinite loops.
const TRANSIENT_ERROR =
	/could not process image|overloaded|rate.?limit|\b429\b|\b5\d\d\b|internal server error|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up/i;
const MAX_TRANSIENT_RETRIES = 2;

let transientRetries = 0;
let sessionArg = resumeId;
while (true) {
	try {
		await runSession(sessionArg);
		break;
	} catch (err) {
		const msg = String(err);

		// Stale resume → start a fresh session (does not consume retry budget).
		if (sessionArg && msg.includes("No conversation found")) {
			console.error(`[${agentName}] Session ${String(sessionArg).slice(0, 20)}... expired, starting fresh`);
			sessionArg = undefined;
			continue;
		}

		// Transient API error → brief backoff, then retry the same run.
		if (TRANSIENT_ERROR.test(msg) && transientRetries < MAX_TRANSIENT_RETRIES) {
			transientRetries++;
			const delay = 1500 * transientRetries;
			console.error(`[${agentName}] transient error (retry ${transientRetries}/${MAX_TRANSIENT_RETRIES} in ${delay}ms): ${msg.slice(0, 200)}`);
			await new Promise((r) => setTimeout(r, delay));
			continue;
		}

		// Non-transient, or retries exhausted → fail (listener posts a fallback).
		console.error(`[${agentName}] FATAL:`, err);
		console.log(JSON.stringify({ session_id: "", is_error: true, result: String(err) }));
		process.exit(1);
	}
}
