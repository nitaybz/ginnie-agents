// Mid-run messages, container side. The listener drops a message that arrives
// while this run is working into <dir>/inbox/ (one JSON file: {"text": "..."},
// the text already in the usual Slack envelope).
// This module hands it to the running session as one more user message, which
// the Claude program delivers at the next turn boundary (between tool calls).
//
// A file moves through three folders, each move one rename:
//   inbox/    written by the listener, not taken yet
//   claimed/  taken by this run, not yet shown to the model
//   seen/     the Claude program confirmed it put the message in the conversation
// When the run is done the inbox folder is renamed to closed/, so a message
// that arrives too late cannot land in it: the listener's write fails and it
// queues the message as a normal next run. After the container exits the
// listener runs everything that is not in seen/ the same way (no loss), and
// never runs what is in seen/ (no duplicate). See listener/src/midrun-inbox.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";

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

/** Take every waiting file. Returns [{ name, text }] in arrival order. */
export function claim(dir) {
	const out = [];
	for (const name of jsonFiles(path.join(dir, "inbox"))) {
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
 * it arrives. Call observe() with each message the query yields; the feed ends
 * the input (so the query returns) once a result came, every message it handed
 * over was seen, and the inbox is closed with nothing left in it.
 */
export function createFeed(dir, firstPrompt, { pollMs = 2000, idleMs = 60000, log = () => {} } = {}) {
	openInbox(dir);
	const queue = [userMessage(firstPrompt)];
	const unseen = new Map(); // uuid -> file name
	let wake = null;
	let ended = false;
	let resultIn = false;
	let idleTimer = null;
	let timer = null;

	const hand = (m) => {
		const uuid = randomUUID();
		unseen.set(uuid, m.name);
		queue.push(userMessage(m.text, uuid));
		log(`mid-run message handed to the session (${m.name})`);
		wake?.();
	};
	const end = () => {
		ended = true;
		clearInterval(timer);
		clearTimeout(idleTimer);
		wake?.();
	};
	// The result is in: finish unless a message is still on its way to the model.
	const settle = () => {
		if (ended || !resultIn) return;
		for (const m of claim(dir)) hand(m);
		if (unseen.size === 0) {
			closeInbox(dir);
			return end();
		}
		// A handed message starts a new turn. If the program never takes it, stop
		// waiting: it stays in claimed/ and the listener runs it as a new run.
		if (idleTimer) return;
		idleTimer = setTimeout(() => {
			log("mid-run message not taken by the session; leaving it for the next run");
			closeInbox(dir);
			end();
		}, idleMs);
	};

	for (const m of claimedNotSeen(dir)) hand(m);
	timer = setInterval(() => {
		if (resultIn) return settle();
		for (const m of claim(dir)) hand(m);
	}, pollMs);

	return {
		input: (async function* () {
			while (true) {
				while (queue.length) yield queue.shift();
				if (ended) return;
				await new Promise((r) => { wake = r; });
				wake = null;
			}
		})(),
		observe(msg) {
			if (ended) return;
			if (msg.type === "user" && msg.isReplay && unseen.has(msg.uuid)) {
				markSeen(dir, unseen.get(msg.uuid));
				log(`mid-run message seen by the session (${unseen.get(msg.uuid)})`);
				unseen.delete(msg.uuid);
				clearTimeout(idleTimer);
				idleTimer = null;
			} else if (msg.type === "result") {
				if (msg.is_error) {
					closeInbox(dir);
					return end();
				}
				resultIn = true;
				settle();
			} else if (msg.type === "assistant") {
				resultIn = false; // a new turn is running; wait for its result
				clearTimeout(idleTimer);
				idleTimer = null;
			}
		},
		stop: end,
	};
}
