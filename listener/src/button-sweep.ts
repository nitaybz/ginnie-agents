/**
 * Button expiration sweep.
 *
 * Agents post interactive messages (Block Kit `actions` blocks) directly from
 * inside their containers — the listener never sees those posts go out. So to
 * retire stale, never-clicked buttons we periodically scan each agent's channel
 * history and strip `actions` blocks from the agent's own messages once they're
 * older than that agent's TTL (`button_ttl_hours`, default 48). The buttons are
 * replaced in-place with a small "expired" context line so the message keeps its
 * content but stops inviting an action nobody will take.
 *
 * Scope (v1): the agent's primary channel only, top-level messages. Buttons that
 * live in thread replies (not broadcast to the channel) are not visible to
 * conversations.history and are left to the agent's own resolved-removal flow.
 * This is intentional — it covers the channel-clutter case the sweep is for
 * without paginating every thread on every tick.
 *
 * Idempotent: once an actions block is stripped the message no longer matches,
 * so it is never touched again.
 */
import type { App } from "@slack/bolt";
import type { AgentConfig } from "./runner";

const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // every 30 min
const FIRST_SWEEP_DELAY_MS = 60 * 1000; // 1 min after boot
const HISTORY_LIMIT = 200; // recent messages scanned per channel per tick

function hasActionsBlock(blocks: any[] | undefined): boolean {
	return Array.isArray(blocks) && blocks.some((b) => b?.type === "actions");
}

async function sweepAgent(agent: AgentConfig, app: App): Promise<number> {
	const channel = agent.slackChannel;
	if (!channel) return 0;

	const ttlMs = agent.buttonTtlHours * 60 * 60 * 1000;
	const cutoffSec = (Date.now() - ttlMs) / 1000; // Slack ts is epoch seconds

	let history: any;
	try {
		history = await app.client.conversations.history({
			token: agent.slackBotToken,
			channel,
			limit: HISTORY_LIMIT,
		});
	} catch (e) {
		console.error(`[button-sweep] ${agent.name}: history fetch failed:`, (e as Error)?.message || e);
		return 0;
	}

	const messages: any[] = history?.messages || [];
	let retired = 0;

	for (const msg of messages) {
		// Only the agent's own button messages, with buttons still live.
		if (!msg?.ts || msg.bot_id !== agent.slackBotMsgId) continue;
		if (!hasActionsBlock(msg.blocks)) continue;
		// Still within its TTL — leave it alone.
		if (parseFloat(msg.ts) >= cutoffSec) continue;

		const kept = (msg.blocks as any[]).filter((b) => b?.type !== "actions");
		kept.push({
			type: "context",
			elements: [{
				type: "mrkdwn",
				text: `⌛ Options expired — no response within ${agent.buttonTtlHours}h. Reply in thread if you still need this.`,
			}],
		});

		try {
			await app.client.chat.update({
				token: agent.slackBotToken,
				channel,
				ts: msg.ts,
				text: msg.text || "Options expired",
				blocks: kept,
			});
			retired++;
		} catch (e) {
			console.error(`[button-sweep] ${agent.name}: update ${msg.ts} failed:`, (e as Error)?.message || e);
		}
	}

	if (retired > 0) {
		console.log(`[button-sweep] ${agent.name}: retired ${retired} stale button message(s) (>${agent.buttonTtlHours}h)`);
	}
	return retired;
}

async function runSweep(apps: Map<string, App>, agents: AgentConfig[]): Promise<void> {
	for (const agent of agents) {
		const app = apps.get(agent.name);
		if (!app) continue;
		try {
			await sweepAgent(agent, app);
		} catch (e) {
			console.error(`[button-sweep] ${agent.name}: sweep error:`, (e as Error)?.message || e);
		}
	}
}

export function startButtonSweep(apps: Map<string, App>, agents: AgentConfig[]): void {
	console.log(
		`[button-sweep] enabled — every ${SWEEP_INTERVAL_MS / 60000}min; TTLs: ` +
		agents.map((a) => `${a.name}=${a.buttonTtlHours}h`).join(", "),
	);
	setTimeout(() => {
		void runSweep(apps, agents);
		setInterval(() => void runSweep(apps, agents), SWEEP_INTERVAL_MS);
	}, FIRST_SWEEP_DELAY_MS);
}
