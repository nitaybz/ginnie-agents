// Shared Ginnie Studio link for Omer (skills/studio-tasks) and Sally (skills/studio-bugs).
//
// ONE implementation, two byte-identical copies: each agent container only sees its own
// skills folder, so this file lives in both. The tests fail if the copies differ. Edit one,
// then copy it over the other:
//   cp omer/skills/studio-tasks/studio-core.mjs sally/skills/studio-bugs/studio-core.mjs
// Everything agent-specific (wording, title prefix, idempotency prefix, state file) is in the
// agent's own studio.mjs, passed in as a "profile".
//
// Studio is reached only through the Studio MCP HTTP API (create_chat, send_to_chat,
// read_inbox, search_chat_history, read_chat_history), never through Studio's files on disk.
//
// Follow-up loop (Nitay 2026-11-01): the agent tells Nitay when it opens a chat, then stays on
// it. `check` is deterministic (no LLM): it reads the agent's Studio inbox (replies Studio sent
// back to this agent) from a saved cursor, and queues every new reply on its bug as a pending
// item. A pending item stays pending until the agent handles it with exactly one of:
//   tell  (one plain Hebrew sentence to Nitay through Adam), ask (a question for Nitay),
//   reply (answer Studio in its chat), skip (nothing worth telling).
// So every Studio reply is reported at most once, and is never lost if a run dies midway.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

export const DEFAULT_MCP_URL = "https://ginnie-dev.ayu-cirius.ts.net/mcp";
export const NITAY_SLACK_ID = "U09TE8Y3S10"; // a bot post to a user id lands in that user's DM with the bot
export const ADAM_SLACK_ID = "U0CB7AFPCJZ"; // Adam relays "for Nitay:" hand-off lines to Nitay's WhatsApp
export const BASELINE_WINDOW_MS = 24 * 3600 * 1000;
const MAX_INBOX_PAGES = 20;
const INBOX_PAGE = 100;
const MAX_ITEM_CHARS = 3000;
const STATUS_RE = /^[\s*_`>-]*STUDIO-STATUS\s*:\s*[*_`]*\s*(FIXED|WONTFIX)\b/im;

export function parseStatus(text) {
	const m = STATUS_RE.exec(String(text || ""));
	return m ? m[1].toLowerCase() : null;
}

export function loadState(file) {
	if (!existsSync(file)) return { bugs: [] };
	const data = JSON.parse(readFileSync(file, "utf8"));
	const out = { bugs: Array.isArray(data.bugs) ? data.bugs : [], lastAlert: data.lastAlert || null };
	if (data.inboxCursor) out.inboxCursor = data.inboxCursor;
	if (data.inboxBaselineAt) out.inboxBaselineAt = data.inboxBaselineAt;
	return out;
}

function saveState(file, state) {
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}

// Studio's history tools return plain text (see sally/skills/studio-bugs/fixtures/studio-history.json):
//   search: one line per hit, "[this conversation, turn N, ASSISTANT] <snippet, newlines collapsed>",
//           or "No matches for: <query>"; problem/notice lines are "[...]".
//   read:   "# This conversation: <title> (<engine>)\nTurns A-B of T....\n\n[N] ASSISTANT\n<text>"
// Anything else is an unexpected format and must fail loudly, never read as "not fixed yet".
export class StudioFormatError extends Error {}
const HIT_RE = /^\[([^\]]*?), turn (\d+), ([^\]]+)\] /;
const NOTICE_RE = /^\[[^\]]*\]$/;

export function parseSearchHits(text) {
	if (typeof text !== "string") throw new StudioFormatError("unexpected Studio search reply (no text)");
	const t = text.trim();
	if (/^No matches for: /.test(t)) return [];
	const hits = [];
	for (const line of t.split("\n")) {
		if (!line.trim()) continue;
		const m = HIT_RE.exec(line);
		if (m) hits.push({ where: m[1], turn: Number(m[2]), label: m[3] });
		else if (!NOTICE_RE.test(line.trim())) throw new StudioFormatError(`unexpected Studio search line: ${line.slice(0, 80)}`);
	}
	if (!hits.length) throw new StudioFormatError("unexpected Studio search reply (no hits, no 'No matches')");
	return hits;
}

export function parseTurn(text, turn) {
	if (typeof text !== "string" || !/^# .+\nTurns \d+-\d+ of \d+\./.test(text)) {
		throw new StudioFormatError(`unexpected Studio read reply for turn ${turn}`);
	}
	const head = `\n[${turn}] `;
	const at = text.indexOf(head);
	if (at === -1) throw new StudioFormatError(`unexpected Studio read reply: turn ${turn} not in the page`);
	const rest = text.slice(at + head.length);
	const nl = rest.indexOf("\n");
	const label = nl === -1 ? rest : rest.slice(0, nl);
	let body = nl === -1 ? "" : rest.slice(nl + 1);
	const next = body.search(/\n\n\[\d+\] /);
	if (next !== -1) body = body.slice(0, next);
	return { label: label.trim(), body };
}

/** Studio's final word on a bug chat: "fixed", "wontfix" or null. Throws StudioFormatError on a format it does not know. */
export async function studioStatus(cfg, chatId, fetchFn = fetch) {
	const hit = await mcpCall(cfg, "search_chat_history", { chatId, query: "STUDIO-STATUS", limit: 10 }, fetchFn);
	const turns = parseSearchHits(hit.text).filter((h) => h.label === "ASSISTANT").map((h) => h.turn).sort((a, b) => b - a);
	for (const turn of turns) {
		const page = await mcpCall(cfg, "read_chat_history", { chatId, from: turn, to: turn }, fetchFn);
		const t = parseTurn(page.text, turn);
		if (t.label !== "ASSISTANT") throw new StudioFormatError(`unexpected Studio read reply: turn ${turn} is ${t.label}`);
		const status = parseStatus(t.body);
		if (status) return status;
	}
	return null;
}

function parseRpc(text) {
	const t = text.trim();
	if (t.startsWith("{")) return JSON.parse(t);
	// Server-sent events fallback: take the last data line.
	const data = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
	if (!data.length) throw new Error("Studio MCP: unreadable response");
	return JSON.parse(data[data.length - 1]);
}

let rpcId = 0;
export async function mcpCall(cfg, name, args, fetchFn = fetch) {
	const res = await fetchFn(cfg.mcpUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${cfg.token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`Studio MCP ${name}: HTTP ${res.status}${res.status === 401 ? " (token missing, expired or revoked: ask Nitay for a new Studio CLI token)" : ""}`);
	const msg = parseRpc(text);
	if (msg.error) throw new Error(`Studio MCP ${name}: ${msg.error.message || "error"}`);
	const result = msg.result || {};
	const firstText = (result.content || []).find((c) => c.type === "text")?.text || "";
	if (result.isError) throw new Error(`Studio MCP ${name}: ${firstText || "tool error"}`);
	if (result.structuredContent) return result.structuredContent;
	try { return JSON.parse(firstText); } catch { return { text: firstText }; }
}

function bugKey(bug) {
	return createHash("sha256").update(`${bug.slack.channel}|${bug.slack.ts}|${bug.title}`).digest("hex").slice(0, 16);
}

async function slackPost(token, payload, fetchFn) {
	const res = await fetchFn("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify(payload),
	});
	const out = await res.json();
	if (!out.ok) throw new Error(`Slack: ${out.error || "post failed"}`);
	return out;
}

async function slackReplies(token, channel, ts, fetchFn) {
	const url = `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(ts)}&limit=50`;
	const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
	const out = await res.json();
	if (!out.ok) throw new Error(`Slack: ${out.error || "replies failed"}`);
	return out.messages || [];
}

/** Text Nitay reads: one plain line, no em dashes, no line breaks. */
export function plainLine(text) {
	return String(text || "").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
}

/** The hand-off line Adam relays to Nitay's WhatsApp. */
export function nitayLine(text, link) {
	return `<@${ADAM_SLACK_ID}> for Nitay: ${plainLine(text)}${link ? ` | ${link}` : ""}`;
}

/**
 * Tell Nitay one line. Through Adam (hand-off channel) when it is set; when it is not set, or
 * the post fails, the same line without Adam's mention goes in the bug's own Slack thread with
 * Nitay tagged. Returns { via, channel, ts, poster, note }. Throws only when both fail.
 */
export async function notifyNitay(cfg, bug, text, fetchFn = fetch) {
	if (!cfg.slackToken) throw new Error("no slack_bot_token: cannot tell Nitay");
	let note = null;
	if (cfg.handoffChannel) {
		try {
			const out = await slackPost(cfg.slackToken, { channel: cfg.handoffChannel, text: nitayLine(text, bug.studioLink) }, fetchFn);
			return { via: "handoff", channel: cfg.handoffChannel, ts: out.ts, poster: out.message?.user || null, note };
		} catch (e) {
			note = `hand-off post failed (${e.message}), used the thread instead`;
		}
	} else note = "handoff_channel not set, used the thread instead";
	const line = `<@${NITAY_SLACK_ID}> ${plainLine(text)}${bug.studioLink ? ` | ${bug.studioLink}` : ""}`;
	const out = await slackPost(cfg.slackToken, { channel: bug.slack.channel, thread_ts: bug.slack.ts, text: line }, fetchFn);
	return { via: "thread", channel: bug.slack.channel, ts: out.ts, threadTs: bug.slack.ts, poster: out.message?.user || null, note };
}

export async function openBug(profile, cfg, stateFile, bug, fetchFn = fetch) {
	const state = loadState(stateFile);
	const id = bugKey(bug);
	let record = state.bugs.find((b) => b.id === id);
	if (!record) {
		const message = profile.buildStudioMessage({ title: bug.title, body: bug.body, slackLink: bug.slack.permalink || `${bug.slack.channel}/${bug.slack.ts}` });
		const op = await mcpCall(cfg, "create_chat", { projectSlug: bug.project, title: `${profile.titlePrefix}: ${bug.title}`.slice(0, 120), message, idempotencyKey: `${profile.keyPrefix}-${id}` }, fetchFn);
		const chatId = op.chatId || op.chat?.chatId || null;
		const rel = op.url || op.chat?.url || (chatId ? `/?chat=${encodeURIComponent(chatId)}` : null);
		record = {
			id,
			title: bug.title,
			project: bug.project,
			chatId,
			operationId: op.id || op.operationId || null,
			studioLink: rel ? `${cfg.origin}${rel}` : null,
			slack: { channel: bug.slack.channel, ts: bug.slack.ts, permalink: bug.slack.permalink || null },
			status: "open",
			openedAt: new Date().toISOString(),
			// Set on new chats only, so chats opened before this change are never announced late.
			toldNitay: false,
			nitayText: plainLine(bug.nitayText || profile.defaultOpenText(bug.title)),
			pending: [],
		};
		state.bugs.push(record);
		saveState(stateFile, state);
	}
	if (record.toldNitay === false && cfg.slackToken) {
		await announceOpen(cfg, record, fetchFn);
		saveState(stateFile, state);
	}
	return record;
}

async function announceOpen(cfg, record, fetchFn) {
	try {
		const r = await notifyNitay(cfg, record, record.nitayText, fetchFn);
		record.toldNitay = true;
		record.toldNitayAt = new Date().toISOString();
		record.toldNitayVia = r.via;
		if (r.note) record.toldNitayNote = r.note;
		delete record.toldNitayError;
	} catch (e) {
		record.toldNitayError = e.message; // retried by the next open or check
	}
}

/** Read every inbox message after the saved cursor. Returns { messages, cursor }. */
async function readInbox(cfg, cursor, fetchFn) {
	const all = [];
	let cur = cursor || null;
	for (let page = 0; page < MAX_INBOX_PAGES; page++) {
		const args = { limit: INBOX_PAGE };
		if (cur) args.cursor = cur;
		const out = await mcpCall(cfg, "read_inbox", args, fetchFn);
		if (!Array.isArray(out.messages)) throw new StudioFormatError("unexpected Studio inbox reply (no messages list)");
		all.push(...out.messages);
		const next = out.nextCursor || cur;
		const done = out.messages.length < INBOX_PAGE || next === cur;
		cur = next;
		if (done) break;
	}
	return { messages: all, cursor: cur };
}

function queueItem(bug, item) {
	bug.pending = Array.isArray(bug.pending) ? bug.pending : [];
	if (bug.pending.some((p) => p.key === item.key)) return false;
	if ((bug.handled || []).some((h) => h.key === item.key)) return false;
	bug.pending.push(item);
	return true;
}

export async function checkBugs(profile, cfg, stateFile, { post = false, slackToken = null, now = Date.now() } = {}, fetchFn = fetch) {
	const state = loadState(stateFile);
	const token = cfg.slackToken || slackToken;
	const cfgS = { ...cfg, slackToken: token };
	const changed = [];
	const errors = [];
	const warnings = [];
	let dirty = false;

	// 1. STUDIO-STATUS: FIXED / WONTFIX as Studio's last word (unchanged behaviour).
	for (const bug of state.bugs) {
		if (bug.status !== "open" || !bug.chatId) continue;
		let status = null;
		try {
			status = await studioStatus(cfg, bug.chatId, fetchFn);
		} catch (e) {
			errors.push(`${bug.id}: ${e.message}`);
			continue;
		}
		if (!status) continue;
		if (post) {
			try {
				await slackPost(token, { channel: bug.slack.channel, thread_ts: bug.slack.ts, text: profile.statusNote(bug, status) }, fetchFn);
			} catch (e) {
				errors.push(`${bug.id}: ${e.message}`);
				continue; // stays open, retried next check
			}
		}
		bug.status = status;
		bug.closedAt = new Date().toISOString();
		queueItem(bug, { key: `status-${status}`, kind: "status", text: `STUDIO-STATUS: ${status.toUpperCase()}`, at: bug.closedAt });
		changed.push(bug);
		dirty = true;
	}

	// 2. New replies in the agent's Studio inbox, matched to bugs by chat id.
	const byChat = new Map(state.bugs.filter((b) => b.chatId).map((b) => [b.chatId, b]));
	if (byChat.size) {
		try {
			const baseline = !state.inboxCursor;
			const { messages, cursor } = await readInbox(cfg, state.inboxCursor, fetchFn);
			for (const m of messages) {
				const bug = byChat.get(m.chatId);
				if (!bug || typeof m.sequence !== "number") continue;
				if (m.sequence <= (bug.lastSeenSeq || 0)) continue;
				bug.lastSeenSeq = m.sequence;
				dirty = true;
				if (m.kind === "no_reply" || m.status === "no_reply") continue; // Studio chose not to answer
				// First run after the upgrade: only replies from the last 24 hours, so old history is not re-reported.
				if (baseline && Number(m.createdAt) < now - BASELINE_WINDOW_MS) continue;
				queueItem(bug, {
					key: `m${m.sequence}`,
					kind: m.kind || "reply",
					text: String(m.text || "").slice(0, MAX_ITEM_CHARS),
					at: m.createdAt ? new Date(Number(m.createdAt)).toISOString() : null,
				});
			}
			if (cursor && cursor !== state.inboxCursor) { state.inboxCursor = cursor; dirty = true; }
			if (baseline && !state.inboxBaselineAt) { state.inboxBaselineAt = new Date(now).toISOString(); dirty = true; }
		} catch (e) {
			errors.push(`inbox: ${e.message}`);
		}
	}

	// 3. A chat opened but Nitay not told yet (the post failed last time): try again.
	if (token) {
		for (const bug of state.bugs) {
			if (bug.toldNitay !== false || !bug.chatId) continue;
			await announceOpen(cfgS, bug, fetchFn);
			if (bug.toldNitayError) warnings.push(`${bug.id}: could not tell Nitay about the new Studio chat: ${bug.toldNitayError}`);
			dirty = true;
		}
	}

	// 4. A question asked to Nitay: look for his answer in the thread of that line (Adam replies there).
	const answers = [];
	for (const bug of state.bugs) {
		const q = bug.pendingQuestion;
		if (!q || !q.ts || !token) continue;
		try {
			const msgs = await slackReplies(token, q.channel, q.threadTs || q.ts, fetchFn);
			const replies = msgs.filter((x) => Number(x.ts) > Number(q.ts) && (!q.poster || x.user !== q.poster)).map((x) => ({ ts: x.ts, user: x.user || x.bot_id || null, text: String(x.text || "").slice(0, MAX_ITEM_CHARS) }));
			if (replies.length) answers.push({ id: bug.id, title: bug.title, studioLink: bug.studioLink, question: q.text, replies });
		} catch (e) {
			warnings.push(`${bug.id}: could not read the thread of the question to Nitay: ${e.message}`);
		}
	}

	// Fail loudly: one Slack line to Nitay per distinct problem per day (never silent, never a flood).
	let alerted = false;
	if (errors.length && post && token && cfg.alertChannel) {
		const line = profile.alertLine(errors);
		const key = `${new Date().toISOString().slice(0, 10)} ${createHash("sha256").update(errors.join("|")).digest("hex").slice(0, 12)}`;
		if (state.lastAlert !== key) {
			try {
				await slackPost(token, { channel: cfg.alertChannel, text: line }, fetchFn);
				state.lastAlert = key;
				alerted = true;
			} catch (e) {
				errors.push(`alert to Nitay failed: ${e.message}`);
			}
		}
	}
	if (dirty || alerted) saveState(stateFile, state);
	return { changed, news: newsOf(state), answers, errors, warnings, open: state.bugs.filter((b) => b.status === "open").length };
}

/** Bugs with Studio replies the agent has not handled yet. */
export function newsOf(state) {
	return state.bugs
		.filter((b) => (b.pending || []).length)
		.map((b) => ({ id: b.id, title: b.title, status: b.status, studioLink: b.studioLink, waitingForNitay: b.pendingQuestion ? b.pendingQuestion.text : null, items: b.pending }));
}

function pickBug(state, id) {
	const bug = state.bugs.find((b) => b.id === id);
	if (!bug) throw new Error(`no Studio chat with id ${id} (run list)`);
	return bug;
}

function takeItems(bug, keys) {
	const pending = bug.pending || [];
	const want = keys && keys.length ? new Set(keys) : null;
	const taken = want ? pending.filter((p) => want.has(p.key)) : pending.slice();
	if (want && taken.length !== want.size) throw new Error(`not pending on ${bug.id}: ${[...want].filter((k) => !taken.some((p) => p.key === k)).join(", ")}`);
	return taken;
}

function markHandled(bug, items, action, extra = {}) {
	const at = new Date().toISOString();
	const keys = new Set(items.map((i) => i.key));
	bug.pending = (bug.pending || []).filter((p) => !keys.has(p.key));
	bug.handled = bug.handled || [];
	for (const i of items) bug.handled.push({ key: i.key, action, at, ...extra });
	if (bug.handled.length > 200) bug.handled = bug.handled.slice(-200);
}

/** One plain Hebrew sentence to Nitay about what Studio did. Refuses when nothing new is pending. */
export async function tellNitay(cfg, stateFile, { id, text, keys = null }, fetchFn = fetch) {
	const state = loadState(stateFile);
	const bug = pickBug(state, id);
	const items = takeItems(bug, keys);
	if (!items.length) return { sent: false, reason: "nothing new from Studio on this chat, nothing sent" };
	if (!plainLine(text)) throw new Error("tell: --text is required");
	const r = await notifyNitay(cfg, bug, text, fetchFn);
	markHandled(bug, items, "told", { via: r.via, ts: r.ts });
	bug.lastToldAt = new Date().toISOString();
	saveState(stateFile, state);
	return { sent: true, via: r.via, note: r.note, keys: items.map((i) => i.key) };
}

/** A question for Nitay when Studio needs something the agent does not know. */
export async function askNitay(cfg, stateFile, { id, text, keys = null }, fetchFn = fetch) {
	const state = loadState(stateFile);
	const bug = pickBug(state, id);
	if (bug.pendingQuestion) return { sent: false, reason: "a question to Nitay on this chat is still open; wait for the answer" };
	if (!plainLine(text)) throw new Error("ask: --text is required");
	const items = takeItems(bug, keys);
	const r = await notifyNitay(cfg, bug, text, fetchFn);
	bug.pendingQuestion = { text: plainLine(text), askedAt: new Date().toISOString(), via: r.via, channel: r.channel, ts: r.ts, threadTs: r.threadTs || null, poster: r.poster, keys: items.map((i) => i.key) };
	markHandled(bug, items, "asked", { via: r.via, ts: r.ts });
	saveState(stateFile, state);
	return { sent: true, via: r.via, note: r.note, keys: items.map((i) => i.key) };
}

/** Answer Studio in its own chat. With answer=true this relays Nitay's answer and closes the open question. */
export async function replyStudio(profile, cfg, stateFile, { id, text, keys = null, answer = false }, fetchFn = fetch) {
	const state = loadState(stateFile);
	const bug = pickBug(state, id);
	if (!bug.chatId) throw new Error(`${id} has no Studio chat`);
	const message = String(text || "").trim();
	if (!message) throw new Error("reply: --text or --text-file is required");
	if (answer && !bug.pendingQuestion) throw new Error(`${id}: no open question to Nitay to answer`);
	const items = answer ? [] : takeItems(bug, keys);
	const hash = createHash("sha256").update(message).digest("hex").slice(0, 12);
	const op = await mcpCall(cfg, "send_to_chat", { chatId: bug.chatId, message, idempotencyKey: `${profile.keyPrefix}-reply-${id}-${hash}` }, fetchFn);
	const opId = op.id || op.operationId || null;
	if (items.length) markHandled(bug, items, "replied", { operationId: opId });
	if (answer) {
		bug.answeredQuestions = bug.answeredQuestions || [];
		bug.answeredQuestions.push({ ...bug.pendingQuestion, answeredAt: new Date().toISOString(), operationId: opId });
		delete bug.pendingQuestion;
	}
	bug.lastReplyAt = new Date().toISOString();
	saveState(stateFile, state);
	return { sent: true, operationId: opId, keys: items.map((i) => i.key), answeredQuestion: !!answer };
}

/** Nothing worth telling Nitay (an acknowledgement, a "working on it"). */
export function skipItems(stateFile, { id, keys = null }) {
	const state = loadState(stateFile);
	const bug = pickBug(state, id);
	const items = takeItems(bug, keys);
	if (items.length) { markHandled(bug, items, "skipped"); saveState(stateFile, state); }
	return { skipped: items.map((i) => i.key) };
}

export function pendingWork(stateFile) {
	const state = loadState(stateFile);
	return {
		news: newsOf(state),
		questions: state.bugs.filter((b) => b.pendingQuestion).map((b) => ({ id: b.id, title: b.title, studioLink: b.studioLink, question: b.pendingQuestion.text, askedAt: b.pendingQuestion.askedAt, via: b.pendingQuestion.via, channel: b.pendingQuestion.channel, ts: b.pendingQuestion.ts })),
	};
}

export function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) {
			const k = argv[i].slice(2);
			const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
			out[k] = v;
		} else out._.push(argv[i]);
	}
	return out;
}

function str(v) { return v && v !== true ? String(v) : null; }
function keyList(v) { return str(v) ? str(v).split(",").map((s) => s.trim()).filter(Boolean) : null; }
function textArg(a) { return str(a["text-file"]) ? readFileSync(a["text-file"], "utf8") : str(a.text); }

export async function runCli(profile, argv) {
	const a = parseArgs(argv);
	const credsFile = a.creds || "/workspace/credentials.json";
	const creds = existsSync(credsFile) ? JSON.parse(readFileSync(credsFile, "utf8")) : {};
	const mcpUrl = creds.studio_mcp_url || DEFAULT_MCP_URL;
	const cfg = {
		mcpUrl,
		token: creds.studio_mcp_token || process.env.STUDIO_MCP_TOKEN,
		origin: new URL(mcpUrl).origin,
		alertChannel: creds.alert_slack_user || NITAY_SLACK_ID,
		slackToken: creds.slack_bot_token || null,
		handoffChannel: creds.handoff_channel || null,
	};
	const stateFile = a.state || profile.stateFile;
	const cmd = a._[0];
	const print = (o) => console.log(JSON.stringify(o, null, 2));
	if (cmd === "list") return print(loadState(stateFile));
	if (cmd === "pending") return print(pendingWork(stateFile));
	if (cmd === "skip") return print(skipItems(stateFile, { id: str(a.id), keys: keyList(a.keys) }));
	if (cmd === "tell" || cmd === "ask") {
		const fn = cmd === "tell" ? tellNitay : askNitay;
		const r = await fn(cfg, stateFile, { id: str(a.id), text: textArg(a), keys: keyList(a.keys) });
		if (r.note) console.error(`${profile.logTag}: ${r.note}`);
		return print(r);
	}
	if (!cfg.token) {
		console.error(profile.noTokenMessage);
		process.exit(3);
	}
	if (cmd === "projects") return print(await mcpCall(cfg, "list_projects", {}));
	if (cmd === "open") {
		for (const k of ["project", "title", "body-file", "channel", "ts"]) if (!str(a[k])) throw new Error(`open: --${k} is required`);
		let permalink = str(a.permalink);
		if (!permalink && creds.slack_bot_token) {
			const r = await fetch(`https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(a.channel)}&message_ts=${encodeURIComponent(a.ts)}`, { headers: { Authorization: `Bearer ${creds.slack_bot_token}` } });
			permalink = (await r.json()).permalink || null;
		}
		const rec = await openBug(profile, cfg, stateFile, { project: a.project, title: a.title, body: readFileSync(a["body-file"], "utf8"), nitayText: str(a.nitay), slack: { channel: a.channel, ts: a.ts, permalink } });
		if (rec.toldNitayError) console.error(`${profile.logTag}: Studio chat opened, but telling Nitay failed (${rec.toldNitayError}); the next check retries.`);
		if (rec.toldNitayNote) console.error(`${profile.logTag}: ${rec.toldNitayNote}`);
		return print(rec);
	}
	if (cmd === "check") {
		const res = await checkBugs(profile, cfg, stateFile, { post: !!a.post });
		print({ changed: res.changed.map((b) => ({ id: b.id, title: b.title, status: b.status })), news: res.news, answers: res.answers, errors: res.errors, warnings: res.warnings, open: res.open });
		if (res.errors.length) process.exitCode = 4;
		return;
	}
	if (cmd === "reply") {
		return print(await replyStudio(profile, cfg, stateFile, { id: str(a.id), text: textArg(a), keys: keyList(a.keys), answer: !!a.answer }));
	}
	console.error("usage: studio.mjs projects | open ... [--nitay \"<hebrew>\"] | check [--post] | pending | tell|ask --id <id> --text \"<hebrew>\" [--keys k1,k2] | reply --id <id> --text \"...\" [--keys ...] [--answer] | skip --id <id> [--keys ...] | list");
	process.exit(2);
}
