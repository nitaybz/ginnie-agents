// Mid-run messages, container side. The listener drops a message that arrives
// while this run is working into <dir>/inbox/ (one JSON file: {"text": "..."},
// the text already in the usual Slack envelope). This module hands it to the
// running session as one more user message, which the Claude program delivers
// at the next turn boundary (between tool calls).
//
// A file moves through three folders, each move one rename:
//   inbox/    written by the listener, not taken yet
//   claimed/  taken by this run, not yet shown to the model
//   seen/     the Claude program confirmed it put the message in the conversation
// When the run stops taking messages the inbox folder is renamed to closed/, so
// a message that arrives too late cannot land in it: the listener's write fails
// and it queues the message as a normal next run. After the container exits the
// listener runs everything that is not in seen/ the same way (no loss), and
// never runs what is in seen/ (no duplicate). See listener/src/midrun-inbox.ts.
//
// The folder is writable by the agent itself. A message read from it is never
// more trusted than the agent: it is plain user text for the model, nothing else.
import { execFileSync } from "child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";

// A run takes at most this many mid-run messages; the next one waits for the next run.
export const MAX_MIDRUN_MESSAGES = 20;

// The longest a run stays open for more messages after an answer.
export const MAX_LINGER_MS = 60 * 60 * 1000;

/**
 * The open-run wait for this run, from MIDRUN_LINGER_MS. A run with no mid-run
 * inbox (none given, or the feed is off) does not wait: it ends at its result.
 * Not a number, negative or empty = 0; above MAX_LINGER_MS = MAX_LINGER_MS.
 */
export function lingerMsFor(raw, hasInbox) {
	if (!hasInbox || typeof raw !== "string" || !raw.trim()) return 0;
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms <= 0) return 0;
	return Math.min(Math.round(ms), MAX_LINGER_MS);
}

const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : []);

function move(dir, from, to, name) {
	try {
		renameSync(path.join(dir, from, name), path.join(dir, to, name));
		return true;
	} catch {
		return false;
	}
}

function readText(dir, name) {
	try {
		const text = JSON.parse(readFileSync(path.join(dir, "claimed", name), "utf8")).text;
		return typeof text === "string" && text.trim() ? text : "";
	} catch {
		return "";
	}
}

/**
 * Can this run feed mid-run messages? It needs three things from the installed
 * SDK (pinned in docker/package.json): the program confirms each message it
 * took (--replay-user-messages, isReplay with our uuid) and accepts
 * priority "next". And the folder must be writable by the container user.
 * @returns {{ ok: boolean, reason: string }}
 */
export function feedSupport(sdkDir, inboxDir) {
	const no = (reason) => ({ ok: false, reason });
	try {
		const types = readFileSync(path.join(sdkDir, "sdk.d.ts"), "utf8");
		if (!types.includes("isReplay: true")) return no("the SDK does not confirm streamed messages (isReplay)");
		if (!/priority\?: 'now' \| 'next' \| 'later'/.test(types)) return no('the SDK has no message priority "next"');
		const parent = path.dirname(sdkDir);
		const program = readdirSync(parent)
			.filter((d) => d.startsWith("claude-agent-sdk-"))
			.map((d) => path.join(parent, d, "claude"))
			.find((p) => existsSync(p));
		if (!program) return no("the Claude program was not found next to the SDK");
		const help = execFileSync(program, ["--help"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
		if (!help.includes("--replay-user-messages")) return no("the Claude program has no --replay-user-messages");
		accessSync(inboxDir, constants.W_OK | constants.X_OK);
		return { ok: true, reason: "" };
	} catch (err) {
		return no(String(err?.message || err));
	}
}

/** Make the folders ready; a run that continues an earlier try reopens its inbox. */
export function openInbox(dir) {
	for (const sub of ["claimed", "seen"]) mkdirSync(path.join(dir, sub), { recursive: true });
	if (existsSync(path.join(dir, "inbox"))) return;
	try {
		renameSync(path.join(dir, "closed"), path.join(dir, "inbox"));
	} catch {
		mkdirSync(path.join(dir, "inbox"), { recursive: true });
	}
}

/** Take waiting files, at most `limit`. Returns [{ name, text }] in arrival order. */
export function claim(dir, limit = Infinity) {
	const out = [];
	for (const name of jsonFiles(path.join(dir, "inbox"))) {
		if (out.length >= limit) break;
		if (!move(dir, "inbox", "claimed", name)) continue;
		const text = readText(dir, name);
		if (text) out.push({ name, text });
	}
	return out;
}

/** Files an earlier try took but never showed to the model. */
export function claimedNotSeen(dir) {
	return jsonFiles(path.join(dir, "claimed")).map((name) => ({ name, text: readText(dir, name) })).filter((m) => m.text);
}

export const markSeen = (dir, name) => move(dir, "claimed", "seen", name);

/** No more messages for this run. False if the folder was already closed. */
export function closeInbox(dir) {
	try {
		renameSync(path.join(dir, "inbox"), path.join(dir, "closed"));
		return true;
	} catch {
		return false;
	}
}

const userMessage = (text, uuid) => ({
	type: "user",
	message: { role: "user", content: text },
	parent_tool_use_id: null,
	...(uuid ? { uuid, priority: "next" } : {}),
});

/**
 * The prompt for one query(): the first message, then every mid-run message as
 * it arrives. Call observe() with EVERY message the query yields, until the
 * query is over, and stop() after it.
 *
 * It stops taking messages (closes the inbox) when the run's turn budget or
 * its message cap is used up, or a result reports an error. It ends the input
 * stream once a result is in and nothing it handed over is still unseen, unless
 * background work is still running (or ended within graceMs): then it keeps
 * taking messages, for at most holdMs without a new turn. The
 * program can still take a message it was handed after that (it does so after
 * a max-turns result), so confirmations are recorded until the query is over.
 *
 * With lingerMs > 0 the run also stays open after each answer: the inbox keeps
 * taking messages until lingerMs (at most holdMs) has passed with no new turn.
 * A message that arrives is handed over and starts a turn; its result starts
 * the wait again. The caps above still close the inbox and end the wait.
 *
 * @param {object} o
 * @param {number} o.maxTurns     turn budget of the whole run, follow-up turns included
 * @param {number} o.maxMessages  cap on mid-run messages
 * @param {number} o.lingerMs    open-run wait after each answer (0 = end at the result)
 * @param {boolean} o.refeedSeen  this try replays the original request in a session that
 *                                does not have the earlier one's history: hand over again
 *                                what that one had already seen
 */
export function createFeed(dir, firstPrompt, {
	pollMs = 2000, idleMs = 60000, graceMs = 20000, holdMs = 2 * 3600 * 1000,
	maxTurns = Infinity, maxMessages = MAX_MIDRUN_MESSAGES, refeedSeen = false, lingerMs = 0, log = () => {},
} = {}) {
	openInbox(dir);
	if (refeedSeen) for (const name of jsonFiles(path.join(dir, "seen"))) move(dir, "seen", "claimed", name);

	const queue = [userMessage(firstPrompt)];
	const unseen = new Map(); // uuid -> file name
	const turns = new Set();  // ids of the model's answers so far
	let wake = null;
	let taking = true;        // still accepting new messages
	let inputEnded = false;
	let resultIn = false;
	let handed = 0;
	let idleTimer = null;
	let timer = null;
	// Background work (a shell command or an agent the run left running) keeps the session going
	// after a result: its end starts a new turn. While it runs the inbox stays open, so a message
	// sent in that wait still reaches this run (seen live 2026-11-17: it used to wait for the next).
	let live = 0;             // background tasks running now, watchers that are not activity left out
	let graceUntil = 0;       // the last one just ended: its notice may still start a turn
	let heldSince = 0;        // when this wait began; 0 = not waiting
	const holding = () => {
		if (!taking || !(live > 0 || Date.now() < graceUntil)) return false;
		if (!heldSince) {
			heldSince = Date.now();
			log("background work is still running; the run keeps taking messages");
		}
		// Work that never ends must not hold the run for ever: then end the input as before.
		return Date.now() - heldSince < holdMs;
	};
	// The open-run wait: set at each answer, cleared when a turn starts.
	let lingerUntil = 0;
	const lingering = () => taking && Date.now() < lingerUntil;

	const stopTaking = (why) => {
		if (!taking) return;
		taking = false;
		clearInterval(timer);
		closeInbox(dir);
		if (why) log(`${why}; later messages wait for the next run`);
	};
	const endInput = () => {
		stopTaking();
		inputEnded = true;
		clearTimeout(idleTimer);
		wake?.();
	};
	const hand = (m) => {
		const uuid = randomUUID();
		unseen.set(uuid, m.name);
		queue.push(userMessage(m.text, uuid));
		handed++;
		log(`mid-run message handed to the session (${m.name})`);
		wake?.();
	};
	const take = (messages) => {
		for (const m of messages) hand(m);
		if (handed >= maxMessages) stopTaking(`this run took its ${maxMessages} mid-run messages`);
	};
	// The result is in: end the input unless a message is still on its way to the model.
	const settle = () => {
		if (inputEnded || !resultIn) return;
		if (taking) take(claim(dir, maxMessages - handed));
		if (unseen.size === 0) {
			if (holding() || lingering()) return;
			if (lingerUntil && taking) log("no message in the open-run wait; the run ends");
			return endInput();
		}
		// A handed message starts a new turn. If the program never takes it, stop
		// waiting: it stays in claimed/ and the listener runs it as a new run.
		if (idleTimer) return;
		idleTimer = setTimeout(() => {
			log("mid-run message not taken by the session; leaving it for the next run");
			endInput();
		}, idleMs);
	};

	take(claimedNotSeen(dir));
	if (taking) {
		timer = setInterval(() => {
			if (resultIn) return settle();
			take(claim(dir, maxMessages - handed));
		}, pollMs);
	}

	return {
		input: (async function* () {
			while (true) {
				while (queue.length) yield queue.shift();
				if (inputEnded) return;
				await new Promise((r) => { wake = r; });
				wake = null;
			}
		})(),
		observe(msg) {
			if (msg.type === "user" && msg.isReplay && unseen.has(msg.uuid)) {
				// Also after the input ended: the program still takes what it was handed.
				markSeen(dir, unseen.get(msg.uuid));
				log(`mid-run message seen by the session (${unseen.get(msg.uuid)})`);
				unseen.delete(msg.uuid);
				clearTimeout(idleTimer);
				idleTimer = null;
			} else if (msg.type === "assistant" && !msg.parent_tool_use_id) {
				resultIn = false; // a turn is running; wait for its result
				heldSince = 0;
				lingerUntil = 0;
				clearTimeout(idleTimer);
				idleTimer = null;
				turns.add(msg.message?.id || turns.size);
				if (turns.size >= maxTurns) stopTaking(`this run used its ${maxTurns} turns`);
			} else if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
				// The full set each time (the SDK's level signal), so a missed event cannot leave a count behind.
				const now = Array.isArray(msg.tasks) ? msg.tasks.filter((t) => !t?.ambient).length : 0;
				if (live > 0 && now === 0) graceUntil = Date.now() + graceMs;
				live = now;
			} else if (msg.type === "result") {
				if (msg.is_error) stopTaking();
				resultIn = true;
				if (taking && lingerMs > 0) {
					const wait = Math.min(lingerMs, holdMs);
					lingerUntil = Date.now() + wait;
					log(`answer in; the run stays open for more messages for ${Math.round(wait / 1000)} s`);
				}
				settle();
			}
		},
		/** The query is over. */
		stop() {
			endInput();
		},
	};
}
