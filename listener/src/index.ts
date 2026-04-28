/**
 * ginnie-agents Listener — multi-app Slack Socket Mode.
 *
 * Each agent has its own Slack app (separate bot identity, separate App-Level
 * Token). We start one @slack/bolt App per agent so events are routed
 * naturally by the platform — an @mention, DM, or button click on agent A's
 * app only reaches agent A's handlers.
 *
 * Sender identity is resolved via shared/known-users.json + Slack users.info
 * and injected into every agent prompt so agents know whether the sender is a
 * known human, another agent, or an unknown user.
 *
 * No public URL needed — each app connects via WebSocket.
 */

import { App } from "@slack/bolt";
import dotenv from "dotenv";
import path from "path";
import { loadStore, getThread, setThread } from "./store";
import { agents, runAgent, resumeAgent, type AgentConfig } from "./runner";
import { loadAgentSchedules, watchAgentSchedules, type ScheduleEntry } from "./scheduler";
import { getSenderInfo, formatSenderLine } from "./users";
import { isWithinWorkHours, offHoursNotice } from "./workhours";

// Load env from repo root. .env is the authoritative source for
// CLAUDE_CODE_OAUTH_TOKEN, TZ, etc. — override any stale values that may
// have leaked from the shell (e.g., an old export in ~/.zshrc).
dotenv.config({
	path: path.join(__dirname, "..", "..", ".env"),
	override: true,
});

// Initialize thread store
loadStore();

// ─── Per-thread message queue ──────────────────────────────
// Prevents race conditions when multiple messages arrive for the same thread
// while the agent is still processing.

interface QueuedMessage {
	agent: AgentConfig;
	channel: string;
	threadTs: string;
	message: string;
	isThreadReply: boolean;
	messageTs: string;
	userId: string;
	senderLine: string;
}

const DEBOUNCE_MS = 20_000; // Wait 20s for additional messages before processing
// Delay before deleting the "Working on it..." status so Slack has time to
// fan out the agent's reply to the user's client. Without this, the delete
// event can race ahead of the reply event and the user sees the status
// disappear before the answer lands.
const STATUS_DELETE_DELAY_MS = 1500;

const activeThreads = new Set<string>(); // threads currently being processed
const messageQueues = new Map<string, QueuedMessage[]>(); // pending messages per thread
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>(); // debounce timers
const threadStatusMsgs = new Map<string, string>(); // thread-key -> active status msg ts

// One Bolt App per agent (keyed by agent name)
const apps = new Map<string, App>();

function threadKey(channel: string, threadTs: string): string {
	return `${channel}:${threadTs}`;
}

function enqueueOrProcess(msg: QueuedMessage): void {
	const key = threadKey(msg.channel, msg.threadTs);

	// Always add to the queue
	const queue = messageQueues.get(key) || [];
	queue.push(msg);
	messageQueues.set(key, queue);

	// Post "Working on it..." immediately on first arrival — before the debounce
	// window closes — so the user sees acknowledgement within ~200ms instead of
	// 20s. Fire-and-forget; processMessage picks up the result via threadStatusMsgs.
	if (queue.length === 1 && !threadStatusMsgs.has(key)) {
		ackMessage(msg.agent, msg.channel, msg.threadTs)
			.then((ts) => { if (ts) threadStatusMsgs.set(key, ts); })
			.catch(() => {});
	}

	if (activeThreads.has(key)) {
		console.log(`[${msg.agent.name}] Queued message for busy thread ${msg.threadTs} (${queue.length} in queue)`);
		return;
	}

	const existingTimer = debounceTimers.get(key);
	if (existingTimer) {
		clearTimeout(existingTimer);
		console.log(`[${msg.agent.name}] Debounce reset for thread ${msg.threadTs} (${queue.length} messages waiting)`);
	}

	const timer = setTimeout(() => {
		debounceTimers.delete(key);
		drainQueue(key).catch((err) => console.error(`[${msg.agent.name}] Queue drain error:`, err));
	}, DEBOUNCE_MS);

	debounceTimers.set(key, timer);
	if (queue.length === 1) {
		console.log(`[${msg.agent.name}] Message received, waiting ${DEBOUNCE_MS / 1000}s for more...`);
	}
}

async function drainQueue(key: string): Promise<void> {
	const queue = messageQueues.get(key);
	if (!queue || queue.length === 0) return;

	const messages = [...queue];
	messageQueues.delete(key);

	const firstMsg = messages[0];
	// Preserve each message's sender line so the agent can tell who said what
	const combinedText = messages.length === 1
		? `${messages[0].senderLine}\n${messages[0].message}`
		: messages.map((m) => `${m.senderLine}\n${m.message}`).join("\n\n---\n\n");

	const combined: QueuedMessage = {
		...firstMsg,
		message: combinedText,
		senderLine: messages[messages.length - 1].senderLine, // latest sender
		messageTs: messages[messages.length - 1].messageTs,
		userId: messages[messages.length - 1].userId,
		isThreadReply: firstMsg.isThreadReply || messages.length > 1,
	};

	if (messages.length > 1) {
		console.log(`[${firstMsg.agent.name}] Batched ${messages.length} messages for thread ${firstMsg.threadTs}`);
	}

	activeThreads.add(key);
	try {
		await processMessage(combined);
	} finally {
		activeThreads.delete(key);

		const newQueue = messageQueues.get(key);
		if (newQueue && newQueue.length > 0) {
			console.log(`[${firstMsg.agent.name}] ${newQueue.length} messages arrived during processing, draining...`);
			await drainQueue(key);
		}
	}
}

// ─── Off-hours guard ───────────────────────────────────────
//
// Scheduled routines always fire (the schedule itself decides timing).
// Inbound user messages, however, respect the agent's work_hours config.
// Returns true if the message should proceed; false if the listener handled it.
async function passesWorkHours(
	agent: AgentConfig,
	app: App,
	channel: string,
	threadTs: string,
): Promise<boolean> {
	if (isWithinWorkHours(agent.workHours)) return true;
	const behavior = agent.workHours.off_hours_behavior;
	if (behavior === "ignore") {
		console.log(`[${agent.name}] off-hours: ignoring inbound message`);
		return false;
	}
	// "queue" and "deferred_response" both fall through to a posted notice.
	// True deferred queueing across PM2 restarts is a v0.2 concern.
	try {
		await app.client.chat.postMessage({
			token: agent.slackBotToken,
			channel,
			thread_ts: threadTs,
			text: offHoursNotice(agent.workHours),
		});
	} catch (err) {
		console.error(`[${agent.name}] off-hours notice failed:`, err);
	}
	return false;
}

// ─── Per-agent event wiring ────────────────────────────────
// Each agent gets its own Bolt App. Events from that app's Slack workspace
// are scoped to that agent automatically — no cross-agent routing needed.

function wireAgentApp(agent: AgentConfig, app: App): void {
	// @mention handler
	app.event("app_mention", async ({ event }: any) => {
		const channel = event.channel;
		const threadTs = event.thread_ts || event.ts;
		const isThreadReply = !!event.thread_ts;

		const messageText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
		if (!messageText) return;

		if (!(await passesWorkHours(agent, app, channel, threadTs))) return;

		const sender = await getSenderInfo(app, event.user, agent);
		const senderLine = formatSenderLine(sender);

		console.log(`[@mention] Agent: ${agent.name}, From: ${sender.name} (${sender.role}), Channel: ${channel}, Thread: ${threadTs}`);
		enqueueOrProcess({
			agent, channel, threadTs, message: messageText,
			isThreadReply, messageTs: event.ts, userId: event.user, senderLine,
		});
	});

	// Message handler (DMs + channel thread replies)
	app.event("message", async ({ event }: any) => {
		if (event.bot_id || event.subtype) return;

		const channel = event.channel;
		let messageText = event.text || "";

		// Handle file attachments.
		//
		// SECURITY: filenames in Slack file uploads are user-controlled. Earlier
		// versions of this code interpolated `f.name` raw into both the agent's
		// prompt and into a curl shell command the agent then executed. That
		// allowed (a) shell injection via crafted filenames and (b) prompt
		// injection via filename text. We now:
		//   - reject any file whose `url_private` doesn't come from
		//     files.slack.com (defends against spoofed events)
		//   - sanitize the local filename used in the shell command to a safe
		//     allowlist (alphanumerics, dot, underscore, hyphen)
		//   - JSON-stringify the original filename when it appears in the
		//     prompt body, so prompt-injection-shaped filenames render as
		//     escaped string literals rather than freestanding text
		if (event.files && event.files.length > 0) {
			const fileDescriptions = event.files.flatMap((f: any) => {
				const url = String(f.url_private || "");
				if (!/^https:\/\/files\.slack\.com\//.test(url)) return [];
				const id = String(f.id || "").replace(/[^A-Za-z0-9_-]/g, "");
				const rawName = String(f.name || "file");
				const safeName = (rawName
					.replace(/[^A-Za-z0-9._-]/g, "_")
					.replace(/^\.+/, "")
					.slice(0, 80)) || "file";
				const safeMime = String(f.mimetype || "unknown")
					.replace(/[^A-Za-z0-9._/+-]/g, "_");
				const sizeKB = f.size ? Math.round(f.size / 1024) + "KB" : "unknown size";
				const localPath = `/workspace/uploads/${id || "file"}_${safeName}`;
				return [
					`[File: name=${JSON.stringify(rawName)} (mime: ${safeMime}, size: ${sizeKB})]\n` +
					`Saved-as: ${localPath}\n` +
					`Download: mkdir -p /workspace/uploads && curl -fsSL -H "Authorization: Bearer $SLACK_BOT_TOKEN" "${url}" -o "${localPath}"`,
				];
			});
			if (fileDescriptions.length > 0) {
				messageText = (messageText ? messageText + "\n\n" : "") + "Attached files:\n" + fileDescriptions.join("\n\n");
			}
		}

		if (!messageText) return;

		const sender = await getSenderInfo(app, event.user, agent);
		const senderLine = formatSenderLine(sender);

		// ── DM ──
		if (event.channel_type === "im") {
			const threadTs = event.thread_ts || event.ts;
			if (!(await passesWorkHours(agent, app, channel, threadTs))) return;
			console.log(`[DM] Agent: ${agent.name}, From: ${sender.name} (${sender.role}), Thread: ${threadTs}`);
			enqueueOrProcess({
				agent, channel, threadTs, message: messageText,
				isThreadReply: !!event.thread_ts, messageTs: event.ts, userId: event.user, senderLine,
			});
			return;
		}

		// ── Channel thread reply (without @mention) ──
		if (event.thread_ts && (event.channel_type === "channel" || event.channel_type === "group")) {
			// Check tracked sessions first
			const existing = getThread(channel, event.thread_ts);
			if (existing && existing.agentName === agent.name) {
				console.log(`[thread-reply] Agent: ${agent.name}, From: ${sender.name}, Channel: ${channel}, Thread: ${event.thread_ts} (tracked)`);
				enqueueOrProcess({
					agent, channel, threadTs: event.thread_ts, message: messageText,
					isThreadReply: true, messageTs: event.ts, userId: event.user, senderLine,
				});
				return;
			}

			// Check if parent message was posted by this agent
			try {
				const parentResult = await app.client.conversations.replies({
					token: agent.slackBotToken,
					channel,
					ts: event.thread_ts,
					limit: 1,
					inclusive: true,
				});
				const parentMsg = parentResult.messages?.[0];
				if (parentMsg?.bot_id && parentMsg.bot_id === agent.slackBotMsgId) {
					console.log(`[thread-reply] Agent: ${agent.name}, From: ${sender.name}, Channel: ${channel}, Thread: ${event.thread_ts} (bot_id match)`);
					enqueueOrProcess({
						agent, channel, threadTs: event.thread_ts, message: messageText,
						isThreadReply: true, messageTs: event.ts, userId: event.user, senderLine,
					});
					return;
				}
			} catch (_e) {
				// Failed to fetch parent — ignore
			}
		}
	});

	// Interactive message handler (buttons, selects, radios, overflow, checkboxes)
	app.action(/.*/, async ({ action, body, ack }: any) => {
		await ack();

		const channel = body.channel?.id;
		const threadTs = body.message?.thread_ts || body.message?.ts;
		const messageTs = body.message?.ts;
		const userId = body.user?.id;
		const botId = body.message?.bot_id;

		if (!channel || !threadTs) return;

		// Only handle if this agent posted the message
		if (botId && botId !== agent.slackBotMsgId) return;

		const sender = await getSenderInfo(app, userId, agent);
		const senderLine = formatSenderLine(sender);

		// Pull the human-readable label of what was clicked
		let label = "";
		if (action.type === "button") {
			label = action.text?.text || action.value || action.action_id;
		} else if (action.type === "static_select" || action.type === "external_select" || action.type === "radio_buttons" || action.type === "overflow") {
			label = action.selected_option?.text?.text || action.selected_option?.value || "";
		} else if (action.type === "checkboxes") {
			label = (action.selected_options || []).map((o: any) => o.text?.text || o.value).join(", ");
		} else {
			label = String(action.value || action.action_id || action.type);
		}

		// Immediate visual feedback: rewrite the message to remove the actions
		// block and append a confirmation context line. Fixes the "no feedback,
		// I clicked it three times" problem — Slack's default click animation
		// is a tiny spinner that doesn't disable the buttons.
		try {
			const originalBlocks = body.message?.blocks || [];
			const newBlocks = originalBlocks.filter((b: any) => b.type !== "actions");
			const tz = process.env.TZ || "UTC";
			const time = new Date().toLocaleTimeString("en-GB", {
				hour: "2-digit", minute: "2-digit", timeZone: tz,
			});
			newBlocks.push({
				type: "context",
				elements: [{
					type: "mrkdwn",
					text: `✓ <@${userId}> · *${label}* · ${time} ${tz} · ${agent.name} processing…`,
				}],
			});
			await app.client.chat.update({
				token: agent.slackBotToken,
				channel,
				ts: messageTs,
				text: body.message?.text || "Acknowledged",
				blocks: newBlocks,
			});
		} catch (_e) {
			// Non-fatal — the agent will still process the click. Logged below.
		}

		// Build the message the agent sees (preserves existing format)
		const verb = (action.type === "button") ? "clicked button"
			: (action.type === "checkboxes") ? "selected"
			: (action.type === "static_select" || action.type === "external_select") ? "selected option"
			: "chose";
		let actionText = `User ${verb}: "${label}"`;
		if (action.action_id) actionText += ` (action: ${action.action_id})`;

		console.log(`[interaction] Agent: ${agent.name}, From: ${sender.name}, Channel: ${channel}, Thread: ${threadTs}, Action: ${actionText}`);

		enqueueOrProcess({
			agent, channel, threadTs, message: actionText,
			isThreadReply: true, messageTs: messageTs || "",
			userId: userId || "", senderLine,
		});
	});
}

// ─── Status indicators (scoped to agent) ───────────────────
async function ackMessage(agent: AgentConfig, channel: string, ts: string): Promise<string | null> {
	const app = apps.get(agent.name);
	if (!app) return null;
	try {
		const result = await app.client.chat.postMessage({
			token: agent.slackBotToken,
			channel,
			thread_ts: ts,
			text: "⏳ Working on it...",
		});
		return (result.ts as string) || null;
	} catch (_e) {
		return null;
	}
}

async function markDone(agent: AgentConfig, channel: string, statusMsgTs?: string | null): Promise<void> {
	if (!statusMsgTs) return;
	const app = apps.get(agent.name);
	if (!app) return;
	try {
		await app.client.chat.delete({
			token: agent.slackBotToken,
			channel,
			ts: statusMsgTs,
		});
	} catch (_e) {}
}

// ─── Fetch thread history from Slack ───────────────────────
async function getThreadContext(agent: AgentConfig, channel: string, threadTs: string): Promise<string> {
	const app = apps.get(agent.name);
	if (!app) return "";
	try {
		const result = await app.client.conversations.replies({
			token: agent.slackBotToken,
			channel,
			ts: threadTs,
			limit: 30,
		});

		if (!result.messages || result.messages.length <= 1) return "";

		const lines: string[] = [];
		for (const msg of result.messages) {
			const who = msg.bot_id === agent.slackBotMsgId ? "(You)" : msg.bot_id ? "(Other agent)" : "(User)";
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
			if (text) lines.push(`${who}: ${text}`);
		}

		if (lines.length === 0) return "";
		return `\n\nThread history (for context — your previous messages are marked "(You)"):\n${lines.join("\n")}\n\n`;
	} catch (_e) {
		return "";
	}
}

// ─── Core message processor ────────────────────────────────
async function processMessage(msg: QueuedMessage): Promise<void> {
	const { agent, channel, threadTs, message, isThreadReply } = msg;
	const key = threadKey(channel, threadTs);

	// Resolve the status message that was posted up-front in enqueueOrProcess.
	// If the ack post is still in-flight, wait briefly. If it never shows
	// (API error on first try, or we're re-draining a second cycle where the
	// previous status was already deleted), post a fresh one here.
	let statusMsgTs: string | null = threadStatusMsgs.get(key) || null;
	if (!statusMsgTs) {
		for (let i = 0; i < 30 && !threadStatusMsgs.has(key); i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		statusMsgTs = threadStatusMsgs.get(key) || null;
	}
	if (!statusMsgTs) {
		statusMsgTs = await ackMessage(agent, channel, threadTs);
		if (statusMsgTs) threadStatusMsgs.set(key, statusMsgTs);
	}

	try {
		if (isThreadReply) {
			const existing = getThread(channel, threadTs);
			if (existing && existing.agentName === agent.name) {
				console.log(`[${agent.name}] Resuming session for thread ${threadTs}`);
				const agentMessage = `Slack reply (channel: ${channel}, thread: ${threadTs}):\n\n${message}\n\nReply in Slack channel ${channel}, thread ${threadTs}.`;
				await resumeAgent(agent, existing.sessionId, agentMessage);
				return;
			}
		}

		let threadContext = "";
		if (isThreadReply) {
			threadContext = await getThreadContext(agent, channel, threadTs);
			if (threadContext) {
				console.log(`[${agent.name}] Loaded thread history for context`);
			}
		}

		const agentMessage = `Slack message (channel: ${channel}, thread: ${threadTs}):${threadContext}\n\n${message}\n\nReply in Slack channel ${channel}, thread ${threadTs}.`;
		const sessionId = await runAgent(agent, agentMessage);

		setThread(channel, threadTs, sessionId, agent.name);
		console.log(`[${agent.name}] New session stored for thread ${threadTs}`);
	} finally {
		if (statusMsgTs) {
			// Let Slack fan the agent's reply out to clients before we delete
			// the status — otherwise the delete event can win the race and the
			// user sees the spinner vanish before the answer lands.
			await new Promise((r) => setTimeout(r, STATUS_DELETE_DELAY_MS));
			await markDone(agent, channel, statusMsgTs);
			threadStatusMsgs.delete(key);
		}
	}
}

// ─── Schedule fire handler ─────────────────────────────────
function onScheduleFire(agent: AgentConfig, entry: ScheduleEntry): void {
	const channel = agent.slackChannel;
	if (!channel) {
		console.error(`[scheduler] ${agent.name}: no slack_channel configured — cannot fire ${entry.id}`);
		return;
	}

	const threadTs = `scheduled_${entry.id}_${Date.now()}`;

	enqueueOrProcess({
		agent,
		channel,
		threadTs,
		message: entry.message,
		isThreadReply: false,
		messageTs: threadTs,
		userId: "",
		senderLine: `From: scheduler | role: system | schedule_id: ${entry.id}`,
	});
}

// ─── Start ─────────────────────────────────────────────────
(async () => {
	const started: string[] = [];
	const skipped: string[] = [];

	for (const agent of agents) {
		if (!agent.slackBotToken || !agent.slackAppToken) {
			skipped.push(`${agent.name} (missing slack tokens)`);
			continue;
		}
		const app = new App({
			token: agent.slackBotToken,
			appToken: agent.slackAppToken,
			socketMode: true,
		});
		wireAgentApp(agent, app);
		apps.set(agent.name, app);
		try {
			await app.start();
			started.push(`${agent.name} (bot: ${agent.slackBotId || "NOT SET"}, channel: ${agent.slackChannel || "NOT SET"})`);
		} catch (err) {
			skipped.push(`${agent.name} (start failed: ${err instanceof Error ? err.message : err})`);
		}
	}

	console.log("⚡ ginnie-agents listener running (Socket Mode, multi-app)");
	console.log(`   Started: ${started.length ? started.join(", ") : "none"}`);
	if (skipped.length) console.log(`   Skipped: ${skipped.join(", ")}`);

	// Load and watch each agent's schedules
	for (const agent of agents) {
		loadAgentSchedules(agent, onScheduleFire);
		watchAgentSchedules(agent, onScheduleFire);
	}

	// Keep the event loop alive even with zero agents. Without this, a fresh
	// install (no agents, no Bolt apps, no schedules) would let the loop drain
	// and Node would exit — PM2 sees that as a crash and restart-loops. The
	// heartbeat is a no-op; running Bolt apps and schedules already keep the
	// loop alive on their own, so this only matters in the empty-state case.
	if (started.length === 0 && skipped.length === 0) {
		console.log(
			"   No agents configured yet. Listener idle — create your first agent" +
			" with the create-agent skill, then `pm2 restart ginnie-agents-listener`.",
		);
	}
	setInterval(() => { /* keep-alive */ }, 60_000);
})();
