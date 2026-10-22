/**
 * WhatsApp trigger: wakes an agent when a new WhatsApp message arrives in a
 * chat it watches.
 *
 * Optional, per agent. Off unless the agent's config.json has a "whatsapp"
 * block and its credentials.json has "whatsapp_token":
 *
 *   "whatsapp": {
 *     "api_url": "http://172.17.0.1:18091",   // agent API of the WhatsApp gateway (host side)
 *     "container_api_url": "...",             // optional, the same API as seen from the container
 *     "account_id": "office",                 // which WhatsApp account the agent uses
 *     "watch_chats": ["<chat jid>"],          // chats whose new messages wake the agent
 *     "poll_seconds": 10,                     // optional
 *     "debounce_seconds": 15,                 // optional: a burst becomes one run
 *     "context_messages": 15                  // optional: recent history shown with the wake
 *   }
 *
 * The gateway is the agent-access API of a WhatsApp gateway (GET
 * /v1/messages, POST /v1/send, ...; see framework/skills/whatsapp). The
 * listener only reads here; any reply is the agent's own decision, sent by
 * the agent through the same API during its run.
 *
 * Guarantees:
 *  - never wakes on the account's own messages (is_from_me) or reactions;
 *  - the first poll of a chat only records where it stands (no replay of history);
 *  - each message is handed to a run at most once (the cursor advances before
 *    the run, persisted in data/whatsapp-cursors.json), so a crash can lose a
 *    wake but never repeats one;
 *  - one run per chat at a time; messages arriving in the debounce window or
 *    during a run are batched into the next run;
 *  - senders are resolved by phone from known-users ("whatsapp" field); an
 *    unknown sender does not wake a write-capable agent unless
 *    allow_unverified_senders is set (same rule as Slack).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

export const WHATSAPP_CURSORS_FILE = path.join(__dirname, "..", "..", "data", "whatsapp-cursors.json");

export interface WhatsAppConfig {
	apiUrl: string;
	containerApiUrl: string;
	accountId: string;
	watchChats: string[];
	pollSeconds: number;
	debounceSeconds: number;
	contextMessages: number;
}

export interface WaMessage {
	id: string;
	chat_jid: string;
	sender?: string | null;
	sender_phone?: string | null;
	content?: string | null;
	timestamp?: string | null;
	ts?: number | null;
	is_from_me?: boolean | number;
	media_type?: string | null;
	filename?: string | null;
	quoted_message_id?: string | null;
}

export interface Cursor {
	ts: number;
	ids: string[];
}

export interface WaKnownUser {
	name: string;
	short_name?: string;
	role: string;
	whatsapp?: string | string[];
}

export interface WaSender {
	name: string;
	role: string;
	phone: string;
	known: boolean;
}

function num(v: unknown, def: number, min: number, max: number): number {
	return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

/** Parse config.json's "whatsapp" block; undefined when absent or unusable. */
export function parseWhatsAppConfig(raw: unknown): WhatsAppConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const apiUrl = typeof r.api_url === "string" ? r.api_url.trim().replace(/\/+$/, "") : "";
	const accountId = typeof r.account_id === "string" ? r.account_id.trim() : "";
	if (!/^https?:\/\/[^\s/]+$/.test(apiUrl) || !/^[a-z][a-z0-9_-]{0,31}$/.test(accountId)) return undefined;
	const container = typeof r.container_api_url === "string" ? r.container_api_url.trim().replace(/\/+$/, "") : "";
	const watchChats = Array.isArray(r.watch_chats)
		? r.watch_chats.filter((c): c is string => typeof c === "string" && /^[0-9-]+@(g\.us|s\.whatsapp\.net)$/.test(c))
		: [];
	return {
		apiUrl,
		containerApiUrl: /^https?:\/\/[^\s/]+$/.test(container) ? container : apiUrl,
		accountId,
		watchChats,
		pollSeconds: num(r.poll_seconds, 10, 3, 300),
		debounceSeconds: num(r.debounce_seconds, 15, 0, 120),
		contextMessages: num(r.context_messages, 15, 0, 50),
	};
}

/** docker run args for an agent with WhatsApp configured (none otherwise). */
export function whatsappDockerArgs(cfg: WhatsAppConfig | undefined): string[] {
	if (!cfg) return [];
	return [
		"--add-host=host.docker.internal:host-gateway",
		"-e", `WHATSAPP_API_URL=${cfg.containerApiUrl}`,
		"-e", `WHATSAPP_ACCOUNT_ID=${cfg.accountId}`,
	];
}

function sortKey(m: WaMessage): [number, string] {
	return [typeof m.ts === "number" ? m.ts : 0, String(m.id)];
}

function byTime(a: WaMessage, b: WaMessage): number {
	const [ta, ia] = sortKey(a);
	const [tb, ib] = sortKey(b);
	return ta - tb || (ia < ib ? -1 : ia > ib ? 1 : 0);
}

/**
 * Messages after the cursor (oldest first) and the advanced cursor.
 * Without a cursor nothing is new: it starts at the latest message.
 */
export function newSince(messages: WaMessage[], cursor: Cursor | undefined): { fresh: WaMessage[]; cursor: Cursor | undefined } {
	const sorted = messages.filter((m) => m && typeof m.id === "string" && typeof m.ts === "number").sort(byTime);
	if (!sorted.length) return { fresh: [], cursor };
	const latest = sorted[sorted.length - 1].ts as number;
	const atLatest = sorted.filter((m) => m.ts === latest).map((m) => m.id);
	if (!cursor) return { fresh: [], cursor: { ts: latest, ids: atLatest } };
	const fresh = sorted.filter((m) => (m.ts as number) > cursor.ts || (m.ts === cursor.ts && !cursor.ids.includes(m.id)));
	if (!fresh.length) return { fresh, cursor };
	if (latest > cursor.ts) return { fresh, cursor: { ts: latest, ids: atLatest } };
	return { fresh, cursor: { ts: cursor.ts, ids: [...new Set([...cursor.ids, ...atLatest])] } };
}

/** A message that may wake the agent: someone else's text or media, not a reaction. */
export function isWakeable(m: WaMessage): boolean {
	if (m.is_from_me === true || m.is_from_me === 1) return false;
	if (m.media_type === "reaction") return false;
	if (!m.sender_phone || !/^\d{5,20}$/.test(m.sender_phone)) return false;
	return !!((m.content || "").trim() || m.media_type);
}

function digits(v: unknown): string {
	return String(v ?? "").replace(/\D/g, "");
}

export function resolveWhatsAppSender(users: Record<string, WaKnownUser>, phone: string): WaSender {
	const p = digits(phone);
	for (const u of Object.values(users || {})) {
		const list = Array.isArray(u.whatsapp) ? u.whatsapp : u.whatsapp ? [u.whatsapp] : [];
		if (p && list.some((x) => digits(x) === p)) {
			return { name: u.short_name || u.name, role: u.role, phone: p, known: true };
		}
	}
	return { name: "unknown", role: "external", phone: p, known: false };
}

/** Same idea as the Slack sender line, with the WhatsApp ids the agent needs to reply. */
export function formatWhatsAppSenderLine(s: WaSender, m: WaMessage): string {
	const parts = [
		`From: ${s.name}`,
		`role: ${s.role}`,
		"channel: whatsapp",
		`chat: ${m.chat_jid}`,
		`msg_id: ${m.id}`,
		`quoted: ${m.quoted_message_id || "none"}`,
	];
	if (!s.known) parts.push(`phone: ${s.phone}`);
	return parts.join(" | ") + (s.known ? "" : " (unverified)");
}

function messageText(m: WaMessage): string {
	const text = (m.content || "").trim();
	if (!m.media_type) return text;
	const media = `[media: ${m.media_type}${m.filename ? ` ${JSON.stringify(m.filename)}` : ""}; msg_id ${m.id}]`;
	return text ? `${text}\n${media}` : media;
}

function clock(m: WaMessage, tz: string): string {
	if (typeof m.ts !== "number") return "--:--";
	return new Date(m.ts * 1000).toLocaleString("en-GB", {
		timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
	});
}

/** The message a WhatsApp wake starts the agent with. */
export function buildWakePrompt(opts: {
	cfg: WhatsAppConfig;
	chat: string;
	batch: { message: WaMessage; sender: WaSender }[];
	history: WaMessage[];
	users: Record<string, WaKnownUser>;
	tz?: string;
}): string {
	const tz = opts.tz || process.env.TZ || "UTC";
	const batchIds = new Set(opts.batch.map((b) => b.message.id));
	const earlier = opts.history
		.filter((m) => !batchIds.has(m.id) && m.media_type !== "reaction")
		.sort(byTime)
		.slice(-opts.cfg.contextMessages);
	const lines: string[] = [];
	lines.push(`WhatsApp (account: ${opts.cfg.accountId}, chat: ${opts.chat}): ${opts.batch.length} new message${opts.batch.length > 1 ? "s" : ""}.`);
	if (earlier.length) {
		lines.push("", "Recent messages in this chat, oldest first, for context. \"(You)\" = sent by this account:");
		for (const m of earlier) {
			const mine = m.is_from_me === true || m.is_from_me === 1;
			const who = mine ? "(You)" : resolveWhatsAppSender(opts.users, m.sender_phone || "").known
				? resolveWhatsAppSender(opts.users, m.sender_phone || "").name
				: (m.sender_phone || "unknown");
			const text = messageText(m).replace(/\s+/g, " ").slice(0, 300);
			lines.push(`[${clock(m, tz)}] ${who} (msg_id ${m.id}${m.quoted_message_id ? `, quoting ${m.quoted_message_id}` : ""}): ${text}`);
		}
	}
	lines.push("", "New:");
	opts.batch.forEach((b, i) => {
		if (i) lines.push("", "---");
		lines.push(formatWhatsAppSenderLine(b.sender, b.message), messageText(b.message));
	});
	lines.push(
		"",
		"Decide first whether this is for you (follow the WhatsApp skill and your PROMPT). If it is, answer in this " +
		"WhatsApp chat through the gateway, quoting the message you answer. If it is not for you, send nothing.",
	);
	return lines.join("\n");
}

// ─── Cursor file ───────────────────────────────────────────

export function loadCursors(file: string): Record<string, Cursor> {
	if (!existsSync(file)) return {};
	try {
		const v = JSON.parse(readFileSync(file, "utf-8"));
		return v && typeof v === "object" && !Array.isArray(v) ? v : {};
	} catch {
		return {};
	}
}

export function saveCursors(file: string, all: Record<string, Cursor>): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(all, null, 2));
	renameSync(tmp, file);
}

// ─── Poller ────────────────────────────────────────────────

export interface TriggerDeps {
	agentName: string;
	cfg: WhatsAppConfig;
	token: string;
	cursorFile: string;
	// Whether a sender may wake this agent (unknown senders for write agents: no).
	allowSender: (s: WaSender) => boolean;
	knownUsers: () => Record<string, WaKnownUser>;
	dispatch: (prompt: string, chat: string) => Promise<void>;
	fetchJson?: (url: string, token: string) => Promise<unknown>;
	setTimer?: (fn: () => void, ms: number) => unknown;
	log?: (line: string) => void;
}

async function defaultFetchJson(url: string, token: string): Promise<unknown> {
	const r = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
}

interface ChatQueue {
	pending: { message: WaMessage; sender: WaSender }[];
	history: WaMessage[];
	timer: unknown;
	active: boolean;
}

export class WhatsAppTrigger {
	private queues = new Map<string, ChatQueue>();
	private failures = 0;
	private stopped = false;
	private readonly fetchJson: (url: string, token: string) => Promise<unknown>;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly log: (line: string) => void;

	constructor(private deps: TriggerDeps) {
		this.fetchJson = deps.fetchJson || defaultFetchJson;
		this.setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
		this.log = deps.log || ((l) => console.log(l));
	}

	private key(chat: string): string {
		return `${this.deps.agentName}:${this.deps.cfg.accountId}:${chat}`;
	}

	/** Fetch every watched chat once and queue what is new. */
	async pollOnce(): Promise<void> {
		const { cfg } = this.deps;
		let ok = true;
		for (const chat of cfg.watchChats) {
			let rows: WaMessage[];
			try {
				const url = `${cfg.apiUrl}/v1/messages?account_id=${encodeURIComponent(cfg.accountId)}` +
					`&chat_jid=${encodeURIComponent(chat)}&limit=50`;
				const body = await this.fetchJson(url, this.deps.token);
				if (!Array.isArray(body)) throw new Error("unexpected response");
				rows = body as WaMessage[];
			} catch (err) {
				ok = false;
				this.failures++;
				if (this.failures === 1 || this.failures % 30 === 0) {
					this.log(`[${this.deps.agentName}] whatsapp poll failed (${this.failures}x): ${err instanceof Error ? err.message : String(err)}`);
				}
				continue;
			}
			const all = loadCursors(this.deps.cursorFile);
			const { fresh, cursor } = newSince(rows, all[this.key(chat)]);
			if (cursor && JSON.stringify(cursor) !== JSON.stringify(all[this.key(chat)])) {
				all[this.key(chat)] = cursor;
				saveCursors(this.deps.cursorFile, all);
			}
			const users = this.deps.knownUsers();
			const wake: { message: WaMessage; sender: WaSender }[] = [];
			for (const m of fresh) {
				if (!isWakeable(m)) continue;
				const sender = resolveWhatsAppSender(users, m.sender_phone || "");
				if (!this.deps.allowSender(sender)) {
					this.log(`[${this.deps.agentName}] whatsapp: not waking for unverified sender in ${chat} (msg ${m.id})`);
					continue;
				}
				wake.push({ message: m, sender });
			}
			const q = this.queue(chat);
			q.history = rows;
			if (wake.length) this.enqueue(chat, wake);
		}
		if (ok && this.failures) {
			this.log(`[${this.deps.agentName}] whatsapp poll recovered after ${this.failures} failures`);
			this.failures = 0;
		}
	}

	private queue(chat: string): ChatQueue {
		let q = this.queues.get(chat);
		if (!q) {
			q = { pending: [], history: [], timer: null, active: false };
			this.queues.set(chat, q);
		}
		return q;
	}

	private enqueue(chat: string, items: { message: WaMessage; sender: WaSender }[]): void {
		const q = this.queue(chat);
		q.pending.push(...items);
		this.log(`[${this.deps.agentName}] whatsapp: ${items.length} new message(s) in ${chat}${q.active ? " (run in progress, queued)" : ""}`);
		if (q.active || q.timer) return;
		q.timer = this.setTimer(() => {
			q.timer = null;
			void this.flush(chat);
		}, this.deps.cfg.debounceSeconds * 1000);
	}

	/** Run the agent once for everything pending in this chat. */
	async flush(chat: string): Promise<void> {
		const q = this.queue(chat);
		if (q.active || !q.pending.length) return;
		const batch = q.pending.splice(0);
		q.active = true;
		try {
			const prompt = buildWakePrompt({
				cfg: this.deps.cfg, chat, batch, history: q.history, users: this.deps.knownUsers(),
			});
			await this.deps.dispatch(prompt, chat);
		} catch (err) {
			this.log(`[${this.deps.agentName}] whatsapp wake failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			q.active = false;
		}
		if (q.pending.length && !q.timer) {
			q.timer = this.setTimer(() => {
				q.timer = null;
				void this.flush(chat);
			}, this.deps.cfg.debounceSeconds * 1000);
		}
	}

	/** Poll forever; slower while the gateway is unreachable. */
	start(): void {
		const loop = async () => {
			if (this.stopped) return;
			try {
				await this.pollOnce();
			} catch (err) {
				this.log(`[${this.deps.agentName}] whatsapp poll error: ${err instanceof Error ? err.message : String(err)}`);
			}
			const wait = this.failures ? Math.max(60, this.deps.cfg.pollSeconds) : this.deps.cfg.pollSeconds;
			this.setTimer(() => void loop(), wait * 1000);
		};
		void loop();
	}

	stop(): void {
		this.stopped = true;
	}
}
