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
 *   RESUME_STRICT          — Optional: "1" when the resume continues an
 *                             interrupted run (after a usage limit). If that
 *                             session is gone the run fails instead of
 *                             starting over, so no action is repeated.
 *   WHATSAPP_API_URL       — Optional: the WhatsApp gateway's agent API as
 *   WHATSAPP_ACCOUNT_ID       seen from the container; loads the whatsapp
 *                             framework skill. The token stays in
 *                             credentials.json (whatsapp_token).
 *   MAX_TURNS              — Optional: max agentic turns (default: 50)
 *   ALLOWED_TOOLS          — Optional: comma-separated tool list
 *   AGENT_MODEL            — Optional: model or alias (e.g. "opus"). The model
 *                             the SDK actually resolved is logged at session
 *                             start and returned as `model` in the result JSON.
 *   TZ                     — Optional: container timezone (default: UTC)
 *   DELIVERY_INSTRUCTION   — Optional: extra system-prompt text appended after
 *                             PROMPT.md, telling the agent how to deliver its
 *                             answer for this turn's origin (e.g. Ginnie
 *                             Studio instead of Slack). Empty/unset for a
 *                             normal Slack turn.
 */

import { createRequire } from "module";
import { bottomLineSkill, whatsappSkill } from "./prompt-skills.mjs";
import { createLimitTracker } from "./limit-detect.mjs";
import { CONTINUE_AFTER_ERROR_MESSAGE, nextStep } from "./run-policy.mjs";
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
//      bottom-line/SKILL.md                      (routine summary post; only when
//                                                BOTTOM_LINE_CHANNEL is set, with the
//                                                channel filled in)
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
const bottomLineSkillPath = "/workspace/.framework/skills/bottom-line/SKILL.md";
const whatsappSkillPath = "/workspace/.framework/skills/whatsapp/SKILL.md";
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
const bottomLine = bottomLineSkill(
	existsSync(bottomLineSkillPath) ? readFileSync(bottomLineSkillPath, "utf-8") : null,
	process.env.BOTTOM_LINE_CHANNEL,
);
if (bottomLine) parts.push(bottomLine);
const whatsapp = whatsappSkill(
	existsSync(whatsappSkillPath) ? readFileSync(whatsappSkillPath, "utf-8") : null,
	process.env.WHATSAPP_API_URL,
	process.env.WHATSAPP_ACCOUNT_ID,
);
if (whatsapp) parts.push(whatsapp);
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

// Usage-limit detection and tool-call count for this run. On a limit the
// listener cools this subscription and retries on another one: from scratch
// when no tool ran yet, else by resuming this session (so actions already
// taken are not repeated). See listener/src/claude-accounts.ts.
const tracker = createLimitTracker();
let resolvedModel = "";
// Latest known session id; also reported on the failure paths so the
// listener can resume it.
let sessionId = resumeId || "";

async function runSession(resumeSessionId, prompt) {
	sessionId = resumeSessionId || sessionId;

	for await (const msg of query({
		prompt,
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
		if (msg.type === "system" && msg.subtype === "init") {
			if (msg.session_id) sessionId = msg.session_id;
			if (msg.model && msg.model !== resolvedModel) {
				resolvedModel = msg.model;
				console.error(`[${agentName}] Model: ${resolvedModel}${process.env.AGENT_MODEL ? ` (requested: ${process.env.AGENT_MODEL})` : ""}`);
			}
		}

		tracker.observe(msg);

		if (msg.type === "result") {
			const output = {
				session_id: sessionId || msg.session_id,
				result: msg.result || "",
				is_error: msg.is_error || false,
				num_turns: msg.num_turns || 0,
				cost_usd: msg.total_cost_usd || 0,
				model: resolvedModel || undefined,
				tool_calls: tracker.toolCalls,
				...tracker.outcome(msg.is_error || false, msg.result || ""),
			};
			console.log(JSON.stringify(output));
			console.error(`[${agentName}] Done — ${msg.num_turns} turns, $${(msg.total_cost_usd || 0).toFixed(4)}`);
		}
	}
}

// Retry rules (docker/run-policy.mjs): after any tool call the original
// request is never replayed; the run continues its own session or fails.
let transientRetries = 0;
let sessionArg = resumeId;
let prompt = message;
let strictResume = !!resumeId && process.env.RESUME_STRICT === "1";
while (true) {
	try {
		await runSession(sessionArg, prompt);
		break;
	} catch (err) {
		const msg = String(err);

		// Usage limit -> never retry here (it will not clear in seconds). The
		// listener cools this subscription and retries on another one.
		const limitFields = tracker.outcome(true, msg);
		if (limitFields) {
			console.error(`[${agentName}] usage limit hit${limitFields.limit_type ? ` (${limitFields.limit_type})` : ""}: ${msg.slice(0, 200)}`);
			console.log(JSON.stringify({
				session_id: sessionId,
				is_error: true,
				result: msg,
				model: resolvedModel || undefined,
				tool_calls: tracker.toolCalls,
				...limitFields,
			}));
			process.exit(1);
		}

		const step = nextStep({
			error: msg,
			sessionArg,
			strictResume,
			toolCalls: tracker.toolCalls,
			sessionId,
			transientRetries,
		});

		if (step.action === "fresh") {
			// Stale thread session and nothing done yet (does not consume retry budget).
			console.error(`[${agentName}] Session ${String(sessionArg).slice(0, 20)}... not found, starting a new session (no tool calls yet)`);
			sessionArg = undefined;
			sessionId = "";
			continue;
		}

		if (step.action === "retry" || step.action === "continue") {
			transientRetries++;
			const delay = 1500 * transientRetries;
			if (step.action === "continue") {
				// Tool calls already ran: resume this run's own session and ask it to
				// continue, never re-send the original request.
				sessionArg = step.sessionId;
				prompt = CONTINUE_AFTER_ERROR_MESSAGE;
				strictResume = true;
			}
			console.error(`[${agentName}] transient error (${step.action} ${transientRetries} in ${delay}ms): ${msg.slice(0, 200)}`);
			await new Promise((r) => setTimeout(r, delay));
			continue;
		}

		// Non-transient, retries exhausted, or a continuation that cannot resume.
		console.error(`[${agentName}] FATAL${step.reason ? ` (${step.reason})` : ""}:`, err);
		console.log(JSON.stringify({ session_id: sessionId, is_error: true, result: step.reason ? `${step.reason}: ${msg}` : String(err), tool_calls: tracker.toolCalls }));
		process.exit(1);
	}
}
