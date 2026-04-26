/**
 * Watcher — ginnie-agents framework watchdog.
 *
 * Long-running Slack Socket Mode bot that:
 *  - Periodically runs deterministic health checks (token age, framework update,
 *    PM2 listener health, disk, memory caps)
 *  - DMs the operator only when a check fires
 *  - Posts interactive buttons on actionable alerts (update now, ack, restart)
 *  - Responds to /watcher slash commands for on-demand status / pause / doctor
 *
 * Not an AI agent. No Claude tokens consumed. Pure Node + Bolt + shell-out.
 *
 * Required env (loaded from .env via dotenv with override):
 *   WATCHER_BOT_TOKEN   — xoxb-... (write-only Slack app, see setup-watcher skill)
 *   WATCHER_APP_TOKEN   — xapp-... (App-Level Token with connections:write)
 *   OPERATOR_SLACK_ID   — U0XXXXXXXXX (the human to DM)
 *
 * Optional:
 *   WATCHER_CHECK_INTERVAL_MIN — minutes between automatic checks (default 60)
 */

import { App, type SlackAction } from "@slack/bolt";
import dotenv from "dotenv";
import path from "path";
import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { runAllChecks, type CheckResult, type CheckAction } from "./watcher-checks";

dotenv.config({
	path: path.join(__dirname, "..", "..", ".env"),
	override: true,
});

const BOT_TOKEN = process.env.WATCHER_BOT_TOKEN || "";
const APP_TOKEN = process.env.WATCHER_APP_TOKEN || "";
const OPERATOR = process.env.OPERATOR_SLACK_ID || "";
const CHECK_INTERVAL_MIN = parseInt(
	process.env.WATCHER_CHECK_INTERVAL_MIN || "60",
	10,
);
const REPO = path.resolve(__dirname, "..", "..");
const STATE_FILE = path.join(REPO, "data", "watcher-state.json");

if (!BOT_TOKEN || !APP_TOKEN || !OPERATOR) {
	console.error(
		"[watcher] missing WATCHER_BOT_TOKEN, WATCHER_APP_TOKEN, or OPERATOR_SLACK_ID in .env — exiting",
	);
	process.exit(1);
}

// ─── State (cooldowns, acks, paused-until, posted message refs) ─────
interface State {
	cooldowns: Record<string, number>; // key → epoch_ms when can fire again
	posted: Record<string, { channel: string; ts: string }>; // key → message ref (for editing)
	pausedUntil?: number;
}

function loadState(): State {
	if (!existsSync(STATE_FILE)) return { cooldowns: {}, posted: {} };
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
	} catch {
		return { cooldowns: {}, posted: {} };
	}
}

function saveState(s: State): void {
	mkdirSync(path.dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ─── Action ID encoding ───────────────────────────────────
// Slack action_ids must be stable strings; we encode the alert key + action type
// so the handler can look up state.
function actionId(checkKey: string, action: CheckAction): string {
	return `watcher::${action.type}::${checkKey}::${action.value || ""}`;
}

function decodeActionId(id: string): { type: string; key: string; value: string } {
	const [, type = "", key = "", value = ""] = id.split("::");
	return { type, key, value };
}

// ─── Bolt setup ────────────────────────────────────────────
const app = new App({
	token: BOT_TOKEN,
	appToken: APP_TOKEN,
	socketMode: true,
});

function buildBlocks(check: CheckResult): any[] {
	const blocks: any[] = [
		{
			type: "section",
			text: { type: "mrkdwn", text: check.message },
		},
	];
	if (check.actions && check.actions.length > 0) {
		blocks.push({
			type: "actions",
			elements: check.actions.map((a) => ({
				type: "button",
				action_id: actionId(check.key, a),
				text: { type: "plain_text", text: a.label },
				...(a.style ? { style: a.style } : {}),
			})),
		});
	}
	return blocks;
}

async function postAlert(check: CheckResult, state: State): Promise<void> {
	const fallback = check.message.replace(/\*/g, "").slice(0, 280);
	try {
		const result = await app.client.chat.postMessage({
			token: BOT_TOKEN,
			channel: OPERATOR,
			text: fallback,
			blocks: buildBlocks(check),
		});
		if (result.channel && result.ts) {
			state.posted[check.key] = { channel: result.channel, ts: result.ts };
		}
	} catch (err) {
		console.error(`[watcher] failed to post alert ${check.key}:`, err);
	}
}

// ─── Periodic check loop ──────────────────────────────────
async function runChecks(): Promise<void> {
	const state = loadState();
	const now = Date.now();

	if (state.pausedUntil && now < state.pausedUntil) {
		console.log(`[watcher] paused until ${new Date(state.pausedUntil).toISOString()}`);
		return;
	}

	let posted = 0;
	for (const check of runAllChecks()) {
		const cooldownUntil = state.cooldowns[check.key] || 0;
		if (now < cooldownUntil) continue;
		await postAlert(check, state);
		// Default cooldown: 24h. Acks (via buttons) extend it.
		state.cooldowns[check.key] = now + 24 * 60 * 60 * 1000;
		posted++;
	}
	saveState(state);
	console.log(`[watcher] check pass — ${posted} alert(s) posted`);
}

// ─── Action handlers ──────────────────────────────────────
app.action(/^watcher::/, async ({ ack, body, action, client }: any) => {
	await ack();
	const id = action.action_id as string;
	const { type, key, value } = decodeActionId(id);
	const messageTs = body.message?.ts;
	const channel = body.channel?.id || OPERATOR;
	const state = loadState();

	const replaceMessage = async (text: string, includeButtons: boolean = false) => {
		try {
			await client.chat.update({
				token: BOT_TOKEN,
				channel,
				ts: messageTs,
				text: text.replace(/\*/g, "").slice(0, 280),
				blocks: includeButtons
					? body.message?.blocks
					: [{ type: "section", text: { type: "mrkdwn", text } }],
			});
		} catch (err) {
			console.error(`[watcher] failed to update message:`, err);
		}
	};

	if (type === "ack_24h") {
		state.cooldowns[key] = Date.now() + 24 * 60 * 60 * 1000;
		saveState(state);
		await replaceMessage("☑️ Acknowledged for 24h.");
		return;
	}

	if (type === "ack_7d") {
		state.cooldowns[key] = Date.now() + 7 * 24 * 60 * 60 * 1000;
		saveState(state);
		await replaceMessage("☑️ Acknowledged for 7 days.");
		return;
	}

	if (type === "restart_listener") {
		await replaceMessage("⏳ Restarting listener…");
		try {
			const out = await runShell("pm2 restart ginnie-agents-listener --update-env");
			await replaceMessage(`✅ Listener restarted.\n\`\`\`\n${out.slice(-400)}\n\`\`\``);
		} catch (err: any) {
			await replaceMessage(`❌ Restart failed: ${err?.message || err}`);
		}
		return;
	}

	if (type === "view_logs") {
		try {
			const out = await runShell(
				"pm2 logs ginnie-agents-listener --lines 30 --nostream",
			);
			await replaceMessage(
				`📜 Last 30 lines:\n\`\`\`\n${out.split("\n").slice(-30).join("\n").slice(-2800)}\n\`\`\``,
			);
		} catch (err: any) {
			await replaceMessage(`❌ Could not read logs: ${err?.message || err}`);
		}
		return;
	}

	if (type === "update_framework") {
		await replaceMessage("⏳ Updating framework…");
		try {
			const out = await runShell(`bash "${path.join(REPO, "scripts", "update-framework.sh")}"`);
			const tail = out.split("\n").slice(-15).join("\n").slice(-2800);
			await replaceMessage(`✅ Framework updated.\n\`\`\`\n${tail}\n\`\`\``);
			// Reset framework-update cooldown so next pass re-evaluates clean
			state.cooldowns[key] = 0;
			saveState(state);
		} catch (err: any) {
			await replaceMessage(`❌ Update failed: ${err?.message || err}`);
		}
		return;
	}

	console.warn(`[watcher] unhandled action type: ${type}`);
});

// ─── Slash command: /watcher ──────────────────────────────
app.command("/watcher", async ({ command, ack, respond }) => {
	await ack();
	const args = (command.text || "").trim().split(/\s+/).filter(Boolean);
	const sub = args[0] || "help";
	const state = loadState();
	const now = Date.now();

	if (sub === "help" || sub === "") {
		await respond({
			response_type: "ephemeral",
			text:
				"*Watcher commands*\n" +
				"`/watcher status` — last check, current cooldowns, paused-until\n" +
				"`/watcher check` — run all checks now and post any new alerts\n" +
				"`/watcher pause [hours]` — mute alerts (default 1h)\n" +
				"`/watcher resume` — clear pause\n" +
				"`/watcher doctor` — run scripts/doctor.sh and post the result",
		});
		return;
	}

	if (sub === "status") {
		const lines: string[] = ["*Watcher status*"];
		if (state.pausedUntil && now < state.pausedUntil) {
			const mins = Math.ceil((state.pausedUntil - now) / 60000);
			lines.push(`⏸ paused for ${mins} more minute(s)`);
		} else {
			lines.push("▶ active");
		}
		const active = Object.entries(state.cooldowns).filter(([, t]) => t > now);
		if (active.length === 0) {
			lines.push("no alerts on cooldown");
		} else {
			lines.push("alerts on cooldown:");
			for (const [k, t] of active) {
				const hrs = Math.ceil((t - now) / 3600_000);
				lines.push(`  • \`${k}\` — ${hrs}h remaining`);
			}
		}
		await respond({ response_type: "ephemeral", text: lines.join("\n") });
		return;
	}

	if (sub === "check") {
		await respond({ response_type: "ephemeral", text: "⏳ running checks…" });
		await runChecks();
		await respond({ response_type: "ephemeral", text: "✅ check pass complete (any alerts posted via DM)" });
		return;
	}

	if (sub === "pause") {
		const hours = Math.max(1, Math.min(168, parseInt(args[1] || "1", 10) || 1));
		state.pausedUntil = now + hours * 60 * 60 * 1000;
		saveState(state);
		await respond({
			response_type: "ephemeral",
			text: `⏸ paused for ${hours} hour(s).`,
		});
		return;
	}

	if (sub === "resume") {
		delete state.pausedUntil;
		saveState(state);
		await respond({ response_type: "ephemeral", text: "▶ resumed." });
		return;
	}

	if (sub === "doctor") {
		await respond({ response_type: "ephemeral", text: "⏳ running doctor…" });
		try {
			const out = await runShell(`bash "${path.join(REPO, "scripts", "doctor.sh")}"`, {
				allowNonZero: true,
			});
			const trimmed = out
				.replace(/\x1b\[[0-9;]*m/g, "")
				.split("\n")
				.slice(-50)
				.join("\n")
				.slice(-2800);
			await respond({
				response_type: "ephemeral",
				text: "```\n" + trimmed + "\n```",
			});
		} catch (err: any) {
			await respond({
				response_type: "ephemeral",
				text: `❌ doctor failed: ${err?.message || err}`,
			});
		}
		return;
	}

	await respond({
		response_type: "ephemeral",
		text: `unknown subcommand \`${sub}\`. try \`/watcher help\``,
	});
});

// ─── Shell helper ─────────────────────────────────────────
function runShell(
	cmd: string,
	opts: { allowNonZero?: boolean } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", cmd], { cwd: REPO });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("close", (code) => {
			if (code === 0 || opts.allowNonZero) resolve(out);
			else reject(new Error(`exit ${code}: ${out.slice(-500)}`));
		});
		child.on("error", reject);
	});
}

// ─── Boot ──────────────────────────────────────────────────
(async () => {
	await app.start();
	console.log("⚡ ginnie-agents Watcher running (Socket Mode)");
	console.log(`   Operator: ${OPERATOR}`);
	console.log(`   Check interval: every ${CHECK_INTERVAL_MIN} minutes`);
	// Initial check after a short warmup
	setTimeout(() => {
		runChecks().catch((e) => console.error("[watcher] initial check error:", e));
	}, 30_000);
	setInterval(() => {
		runChecks().catch((e) => console.error("[watcher] check error:", e));
	}, CHECK_INTERVAL_MIN * 60 * 1000);
})();
