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
import { getSenderInfo, formatSenderLine, type SenderInfo } from "./users";
import { isAudioMime, transcribeAudio } from "./transcribe";
import { startButtonSweep } from "./button-sweep";
import { startStudioBridge, DEFAULT_STUDIO_BRIDGE_PORT } from "./studio-bridge";

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
// Delay before clearing the "is thinking…" status so Slack has time to fan out
// the agent's reply to the user's client. Without this, the clear event can race
// ahead of the reply event and the user sees the shimmer disappear before the
// answer lands.
const STATUS_DELETE_DELAY_MS = 1500;
// Slack auto-clears an assistant status ~2min after it was last set. Agent runs
// routinely exceed that, so re-assert the "is thinking…" status on this cadence
// (comfortably under 2min) until the run completes — otherwise the shimmer
// vanishes while the user is still waiting for the reply.
const STATUS_HEARTBEAT_MS = 90_000;

const activeThreads = new Set<string>(); // threads currently being processed
const messageQueues = new Map<string, QueuedMessage[]>(); // pending messages per thread
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>(); // debounce timers
const activeStatusThreads = new Set<string>(); // thread-keys with an active "thinking" shimmer

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

	// Show the "is thinking…" shimmer immediately on first arrival — before the
	// debounce window closes — so the user sees acknowledgement within ~200ms
	// instead of 20s. Optimistically mark active to dedupe concurrent arrivals;
	// the call is idempotent, so a rare double-set is harmless.
	if (queue.length === 1 && !activeStatusThreads.has(key)) {
		activeStatusThreads.add(key);
		setThinking(msg.agent, msg.channel, msg.threadTs)
			.then((ok) => { if (!ok) activeStatusThreads.delete(key); })
			.catch(() => { activeStatusThreads.delete(key); });
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

// Refuse, at dispatch time, to wake a write-capable agent for an
// uncurated sender. role === "external" means Slack returned a real
// user but they're not in known-users.json; "unknown" means the lookup
// failed. Silent drop, not a posted reply — see ARCHITECTURE.md threat
// model for reasoning. Read-only agents and `allow_unverified_senders`
// opt out.
function passesSenderPolicy(agent: AgentConfig, sender: SenderInfo): boolean {
	if (agent.boundaries === "read-only") return true;
	if (agent.allowUnverifiedSenders) return true;
	if (sender.role === "unknown" || sender.role === "external") {
		console.log(
			`[${agent.name}] dispatch refused: unverified sender ${sender.userId || "(no id)"}` +
			` (role: ${sender.role}, name: ${sender.name})`,
		);
		return false;
	}
	return true;
}

// ─── Work hours ────────────────────────────────────────────
//
// work_hours is intentionally NOT enforced on inbound messages. Its purpose is
// to stop an agent from *proactively* bothering the user outside hours — and
// that's already governed by each routine's own cron in schedules.json (some
// agents legitimately schedule routines outside their nominal work hours, e.g.
// a Friday digest on Sun–Thu work-days). Anyone can reach an agent 24/7; the
// agent answers whenever it's spoken to. The `work_hours` config block is kept
// for backwards-compat but no longer gates inbound dispatch.

// ─── Per-agent event wiring ────────────────────────────────
// Each agent gets its own Bolt App. Events from that app's Slack workspace
// are scoped to that agent automatically — no cross-agent routing needed.

function wireAgentApp(agent: AgentConfig, app: App): void {
	// @mention handler
	app.event("app_mention", async ({ event }: any) => {
		const channel = event.channel;
		const threadTs = event.thread_ts || event.ts;
		const isThreadReply = !!event.thread_ts;

		const baseText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
		const hasFiles = !!(event.files && event.files.length > 0);
		// A voice-only @mention has no text after stripping the mention.
		// Drop messages that have neither text nor any attached file.
		if (!baseText && !hasFiles) return;

		const sender = await getSenderInfo(app, event.user, agent);
		if (!passesSenderPolicy(agent, sender)) return;
		const senderLine = formatSenderLine(sender);

		// Post early ack BEFORE transcription so the user sees feedback within
		// the same ~200ms window non-audio messages get.
		if (hasFiles && hasAudioAttachment(event.files)) {
			await postEarlyAudioAck(agent, channel, threadTs);
		}

		const messageText = hasFiles
			? await expandFileAttachments(event.files, agent, baseText)
			: baseText;
		if (!messageText) return;

		console.log(`[@mention] Agent: ${agent.name}, From: ${sender.name} (${sender.role}), Channel: ${channel}, Thread: ${threadTs}`);
		enqueueOrProcess({
			agent, channel, threadTs, message: messageText,
			isThreadReply, messageTs: event.ts, userId: event.user, senderLine,
		});
	});

	// Message handler (DMs + channel thread replies)
	app.event("message", async ({ event }: any) => {
		if (event.bot_id) return;
		// Allow message-with-file subtypes to fall through to the file-attachment
		// handler below. Slack sends file uploads as `subtype: "file_share"`
		// (legacy) or as a regular message with `files: [...]`. Without this,
		// every file upload was silently dropped.
		const ALLOWED_SUBTYPES = new Set(["file_share"]);
		if (event.subtype && !ALLOWED_SUBTYPES.has(event.subtype)) return;

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
			// Post the early ack now (before transcription) for DMs so the user
			// sees the same ~200ms acknowledgement non-audio messages get.
			// Channel-thread replies skip this because the parent-message check
			// downstream may still drop the message — we don't want to leak a
			// dangling status. Sender + within-work-hours gate it so we don't
			// ack messages we'll later silently drop.
			if (event.channel_type === "im" && hasAudioAttachment(event.files)) {
				const sender = await getSenderInfo(app, event.user, agent);
				if (passesSenderPolicy(agent, sender)) {
					const earlyThreadTs = event.thread_ts || event.ts;
					await postEarlyAudioAck(agent, channel, earlyThreadTs);
				}
			}

			messageText = await expandFileAttachments(event.files, agent, messageText);
		}

		if (!messageText) return;

		const sender = await getSenderInfo(app, event.user, agent);
		if (!passesSenderPolicy(agent, sender)) return;
		const senderLine = formatSenderLine(sender);

		// ── DM ──
		if (event.channel_type === "im") {
			const threadTs = event.thread_ts || event.ts;
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
		if (!passesSenderPolicy(agent, sender)) return;
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

		// Immediate visual feedback: rewrite the message to retire ONLY the
		// actions block that was clicked, replacing it in-place with a
		// confirmation context line. Fixes the "no feedback, I clicked it three
		// times" problem — Slack's default click animation is a tiny spinner that
		// doesn't disable the buttons — without wiping sibling actions blocks
		// (e.g. a message carrying two independent proposals: acting on one must
		// leave the other's buttons live).
		try {
			const originalBlocks = body.message?.blocks || [];
			const tz = process.env.TZ || "UTC";
			const time = new Date().toLocaleTimeString("en-GB", {
				hour: "2-digit", minute: "2-digit", timeZone: tz,
			});
			const ackBlock = {
				type: "context",
				elements: [{
					type: "mrkdwn",
					text: `✓ <@${userId}> · *${label}* · ${time} ${tz} · ${agent.name} processing…`,
				}],
			};
			// Slack tells us which block the clicked element lives in. Retire just
			// that one. If block_id is somehow absent, fall back to the old
			// behaviour (strip all actions blocks) so a click never goes silent.
			const clickedBlockId = action.block_id;
			let newBlocks: any[];
			if (clickedBlockId && originalBlocks.some((b: any) => b.type === "actions" && b.block_id === clickedBlockId)) {
				newBlocks = originalBlocks.map((b: any) =>
					(b.type === "actions" && b.block_id === clickedBlockId) ? ackBlock : b,
				);
			} else {
				newBlocks = originalBlocks.filter((b: any) => b.type !== "actions");
				newBlocks.push(ackBlock);
			}
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

// ─── File / audio attachment helpers ───────────────────────

function hasAudioAttachment(files: any[] | undefined): boolean {
	if (!files) return false;
	return files.some((f) =>
		isAudioMime(String(f?.mimetype || "")) &&
		/^https:\/\/files\.slack\.com\//.test(String(f?.url_private || "")),
	);
}

// Show the "is thinking…" status before a slow operation (transcription) so the
// user sees feedback in <200ms. Marked active so the later enqueueOrProcess call
// reuses it instead of re-setting the status.
async function postEarlyAudioAck(agent: AgentConfig, channel: string, threadTs: string): Promise<void> {
	const key = threadKey(channel, threadTs);
	if (activeStatusThreads.has(key)) return;
	activeStatusThreads.add(key);
	const ok = await setThinking(agent, channel, threadTs);
	if (!ok) activeStatusThreads.delete(key);
}

// Expand Slack file attachments into agent-readable text. Audio files are
// transcribed locally via whisper.cpp and the transcript is spliced inline.
// Non-audio files keep the standard "[File: …] Download: curl …" stub the
// agent runs to fetch them inside its container.
async function expandFileAttachments(
	files: any[],
	agent: AgentConfig,
	baseText: string,
): Promise<string> {
	const audioTranscripts: string[] = [];
	const fileDescriptions: string[] = [];

	for (const f of files as any[]) {
		const url = String(f.url_private || "");
		if (!/^https:\/\/files\.slack\.com\//.test(url)) continue;
		const rawName = String(f.name || "file");
		const safeMime = String(f.mimetype || "unknown")
			.replace(/[^A-Za-z0-9._/+-]/g, "_");

		if (isAudioMime(safeMime)) {
			const text = await transcribeAudio(url, agent.slackBotToken);
			if (text) {
				audioTranscripts.push(
					`[Voice message, transcribed locally — original: ${JSON.stringify(rawName)} (${safeMime})]\n${text}`,
				);
				continue;
			}
			// Transcription failed (ffmpeg missing, build failed, etc.) —
			// fall through to the standard download stub so the agent at
			// least knows audio was attached.
		}

		const id = String(f.id || "").replace(/[^A-Za-z0-9_-]/g, "");
		const safeName = (rawName
			.replace(/[^A-Za-z0-9._-]/g, "_")
			.replace(/^\.+/, "")
			.slice(0, 80)) || "file";
		const sizeKB = f.size ? Math.round(f.size / 1024) + "KB" : "unknown size";
		const localPath = `/workspace/uploads/${id || "file"}_${safeName}`;
		fileDescriptions.push(
			`[File: name=${JSON.stringify(rawName)} (mime: ${safeMime}, size: ${sizeKB})]\n` +
			`Saved-as: ${localPath}\n` +
			`Download: mkdir -p /workspace/uploads && curl -fsSL -H "Authorization: Bearer $SLACK_BOT_TOKEN" "${url}" -o "${localPath}"`,
		);
	}

	let result = baseText;
	if (audioTranscripts.length > 0) {
		result = (result ? result + "\n\n" : "") + audioTranscripts.join("\n\n");
	}
	if (fileDescriptions.length > 0) {
		result = (result ? result + "\n\n" : "") + "Attached files:\n" + fileDescriptions.join("\n\n");
	}
	return result;
}

// ─── Status indicators (scoped to agent) ───────────────────
// Slack's native assistant "is thinking…" shimmer (assistant.threads.setStatus).
// It's bound to (channel, thread_ts) — there is no message ts to track or delete.
// In regular channel threads it does NOT auto-clear on reply (only in the
// dedicated Assistant pane), so clearThinking() must be called explicitly.
async function setThinking(agent: AgentConfig, channel: string, threadTs: string): Promise<boolean> {
	const app = apps.get(agent.name);
	if (!app) return false;
	try {
		await app.client.assistant.threads.setStatus({
			token: agent.slackBotToken,
			channel_id: channel,
			thread_ts: threadTs,
			status: "is thinking…",
		});
		return true;
	} catch (_e) {
		return false;
	}
}

// Post a fallback reply when an agent run errored before posting anything of
// its own (container crash, API rejection, etc.). Without this the user sees
// the status spinner vanish and gets no answer at all.
async function postRunFailure(
	agent: AgentConfig,
	channel: string,
	threadTs: string,
	rawError: string,
): Promise<void> {
	const app = apps.get(agent.name);
	if (!app) return;
	const err = String(rawError || "");
	let text = "⚠️ Sorry — I hit an error processing that and couldn't finish a reply. Mind trying again?";
	// Give a useful, specific hint for the most common cause we've seen.
	if (/could not process image|invalid_request_error.*image|image.*invalid/i.test(err)) {
		text = "⚠️ I couldn't read that image — it may be an unsupported shape, format, or size for me to view. A standard screenshot or photo (not an extreme thin/wide crop) usually works. Want to describe what's in it, or resend a different version?";
	}
	try {
		await app.client.chat.postMessage({
			token: agent.slackBotToken,
			channel,
			thread_ts: threadTs,
			text,
		});
		console.log(`[${agent.name}] Posted run-failure fallback to thread ${threadTs}`);
	} catch (e) {
		console.error(`[${agent.name}] Failed to post run-failure fallback:`, e);
	}
}

async function clearThinking(agent: AgentConfig, channel: string, threadTs: string): Promise<void> {
	const app = apps.get(agent.name);
	if (!app) return;
	try {
		await app.client.assistant.threads.setStatus({
			token: agent.slackBotToken,
			channel_id: channel,
			thread_ts: threadTs,
			status: "",
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

	// Re-assert the "is thinking…" shimmer at processing start. setStatus is
	// idempotent, so this is safe whether or not enqueueOrProcess already set it,
	// and it guards against Slack's ~2min status auto-timeout if this message
	// waited in a long debounce/queue window.
	activeStatusThreads.add(key);
	await setThinking(agent, channel, threadTs);
	// Keep the shimmer alive across the whole run — Slack expires it ~2min after
	// the last set, and runs frequently take longer than that.
	const heartbeat = setInterval(() => {
		void setThinking(agent, channel, threadTs);
	}, STATUS_HEARTBEAT_MS);

	try {
		if (isThreadReply) {
			const existing = getThread(channel, threadTs);
			if (existing && existing.agentName === agent.name) {
				console.log(`[${agent.name}] Resuming session for thread ${threadTs}`);
				const agentMessage = `Slack reply (channel: ${channel}, thread: ${threadTs}):\n\n${message}\n\nReply in Slack channel ${channel}, thread ${threadTs}.`;
				const r = await resumeAgent(agent, existing.sessionId, agentMessage);
				if (r.isError) await postRunFailure(agent, channel, threadTs, r.result);
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
		const { sessionId, isError, result } = await runAgent(agent, agentMessage);

		// The agent posts its own reply during the run. If the run errored, it
		// crashed before posting anything — surface a fallback so the user is
		// never left with a vanished spinner and silence.
		if (isError) {
			await postRunFailure(agent, channel, threadTs, result);
		}

		setThread(channel, threadTs, sessionId, agent.name);
		console.log(`[${agent.name}] New session stored for thread ${threadTs}`);
	} finally {
		clearInterval(heartbeat);
		// Let Slack fan the agent's reply out to clients before we clear the
		// shimmer — otherwise the clear can win the race and the user sees it
		// vanish before the answer lands. In channel threads the status does not
		// auto-clear on reply, so this explicit clear is required.
		await new Promise((r) => setTimeout(r, STATUS_DELETE_DELAY_MS));
		await clearThinking(agent, channel, threadTs);
		activeStatusThreads.delete(key);
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

	// Periodically retire stale, never-clicked buttons from agent messages.
	if (started.length) startButtonSweep(apps, agents);

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
	// Ginnie Studio bridge — loopback only, disabled until a key is installed.
	const studioBridgePort = Number(process.env.STUDIO_BRIDGE_PORT || DEFAULT_STUDIO_BRIDGE_PORT);
	try {
		startStudioBridge({ port: studioBridgePort });
		console.log(`   Studio bridge listening on 127.0.0.1:${studioBridgePort}`);
	} catch (err) {
		console.error("[studio-bridge] failed to start:", err instanceof Error ? err.message : err);
	}

	setInterval(() => { /* keep-alive */ }, 60_000);
})();
