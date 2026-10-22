/**
 * WhatsApp trigger: new inbound messages in watched chats wake the agent with
 * a sender line; own messages, reactions and history never do; bursts batch.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "fs";
import { createServer, type IncomingMessage } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import path from "path";
import {
	WhatsAppTrigger,
	buildWakePrompt,
	defaultFetchJson,
	formatWhatsAppSenderLine,
	isWakeable,
	newSince,
	parseWhatsAppConfig,
	resolveWhatsAppSender,
	whatsappDockerArgs,
	type WaMessage,
	type WaSender,
} from "./whatsapp-trigger";

const CHAT = "100000000000000001@g.us";
const users = {
	U1: { name: "Alice Example", short_name: "Alice", role: "owner", whatsapp: "15550000001" },
	U2: { name: "Bob Example", role: "operator", whatsapp: ["+1 555 000 0002"] },
};

function msg(id: string, ts: number, extra: Partial<WaMessage> = {}): WaMessage {
	return {
		id, chat_jid: CHAT, ts, content: `text ${id}`, is_from_me: false,
		sender_phone: "15550000001", quoted_message_id: null, media_type: null, ...extra,
	};
}

const cfg = parseWhatsAppConfig({
	api_url: "http://172.17.0.1:18091/",
	account_id: "office",
	watch_chats: [CHAT, "not-a-jid"],
	debounce_seconds: 5,
})!;

describe("config", () => {
	test("parses and defaults", () => {
		assert.equal(cfg.apiUrl, "http://172.17.0.1:18091");
		assert.equal(cfg.containerApiUrl, cfg.apiUrl);
		assert.deepEqual(cfg.watchChats, [CHAT]);
		assert.equal(cfg.pollSeconds, 10);
		assert.equal(cfg.debounceSeconds, 5);
		assert.equal(parseWhatsAppConfig({ api_url: "http://h:1", account_id: "a" })!.debounceSeconds, 4, "default batching window is short");
	});
	test("LID chat ids are accepted", () => {
		assert.deepEqual(parseWhatsAppConfig({ api_url: "http://h:1", account_id: "a", watch_chats: ["123456789@lid"] })!.watchChats, ["123456789@lid"]);
	});
	test("absent or broken block is off", () => {
		assert.equal(parseWhatsAppConfig(undefined), undefined);
		assert.equal(parseWhatsAppConfig({ api_url: "nope", account_id: "office" }), undefined);
		assert.equal(parseWhatsAppConfig({ api_url: "http://x:1" }), undefined);
	});
	test("docker args only when configured, never a token", () => {
		assert.deepEqual(whatsappDockerArgs(undefined), []);
		const args = whatsappDockerArgs(cfg).join(" ");
		assert.match(args, /WHATSAPP_API_URL=http:\/\/172\.17\.0\.1:18091/);
		assert.match(args, /WHATSAPP_ACCOUNT_ID=office/);
		assert.doesNotMatch(args, /TOKEN/i);
	});
});

describe("cursor", () => {
	test("first poll starts at the latest message without waking", () => {
		const r = newSince([msg("a", 10), msg("b", 20)], undefined);
		assert.deepEqual(r.fresh, []);
		assert.deepEqual(r.cursor, { ts: 20, ids: ["b"] });
	});
	test("returns only newer messages, oldest first, including same-second ones", () => {
		const r = newSince([msg("c", 30), msg("b", 20), msg("b2", 20), msg("a", 10)], { ts: 20, ids: ["b"] });
		assert.deepEqual(r.fresh.map((m) => m.id), ["b2", "c"]);
		assert.deepEqual(r.cursor, { ts: 30, ids: ["c"] });
		assert.deepEqual(newSince([msg("c", 30)], r.cursor).fresh, []);
	});
});

describe("who wakes the agent", () => {
	test("own messages, reactions and system rows never wake", () => {
		assert.equal(isWakeable(msg("a", 1)), true);
		assert.equal(isWakeable(msg("a", 1, { is_from_me: true })), false);
		assert.equal(isWakeable(msg("a", 1, { is_from_me: 1 })), false);
		assert.equal(isWakeable(msg("a", 1, { media_type: "reaction" })), false);
		assert.equal(isWakeable(msg("a", 1, { sender_phone: null })), false);
		assert.equal(isWakeable(msg("a", 1, { content: "", media_type: "image" })), true);
		assert.equal(isWakeable(msg("a", 1, { content: "  " })), false);
	});
	test("known senders resolve by phone, any formatting", () => {
		assert.deepEqual(resolveWhatsAppSender(users, "15550000001"), { name: "Alice", role: "owner", phone: "15550000001", known: true });
		assert.equal(resolveWhatsAppSender(users, "15550000002").name, "Bob Example");
		assert.deepEqual(resolveWhatsAppSender(users, "15559999999"), { name: "unknown", role: "external", phone: "15559999999", known: false });
	});
	test("sender line carries chat, msg_id and quoted", () => {
		const s = resolveWhatsAppSender(users, "15550000001");
		assert.equal(
			formatWhatsAppSenderLine(s, msg("m1", 1, { quoted_message_id: "q9" })),
			`From: Alice | role: owner | channel: whatsapp | chat: ${CHAT} | msg_id: m1 | quoted: q9`,
		);
		const u = resolveWhatsAppSender(users, "15559999999");
		assert.equal(
			formatWhatsAppSenderLine(u, msg("m2", 1)),
			`From: unknown | role: external | channel: whatsapp | chat: ${CHAT} | msg_id: m2 | quoted: none | phone: 15559999999 (unverified)`,
		);
	});
	test("wake prompt shows history with (You) and the new messages", () => {
		const alice = resolveWhatsAppSender(users, "15550000001");
		const p = buildWakePrompt({
			cfg, chat: CHAT, users, tz: "UTC",
			batch: [{ message: msg("n1", 100, { content: "can you check?", quoted_message_id: "y1" }), sender: alice }],
			history: [msg("y1", 50, { is_from_me: true, content: "open question?" }), msg("n1", 100), msg("r", 60, { media_type: "reaction" })],
		});
		assert.match(p, /\(You\) \(msg_id y1\): open question\?/);
		assert.doesNotMatch(p, /msg_id r\)/);
		assert.match(p, /From: Alice \| role: owner \| channel: whatsapp .* msg_id: n1 \| quoted: y1\ncan you check\?/);
		assert.match(p, /your own rules/);
		assert.doesNotMatch(p, /not for you/, "no addressing rule in framework text");
	});
});

function harness(rowsByPoll: WaMessage[][], opts: { allowUnknown?: boolean; dir?: string } = {}) {
	const dir = opts.dir || mkdtempSync(path.join(tmpdir(), "wa-trigger-"));
	const cursorFile = path.join(dir, "cursors.json");
	const timers: { fn: () => void; ms: number }[] = [];
	const runs: string[] = [];
	const logs: string[] = [];
	let poll = 0;
	let release: (() => void) | null = null;
	let hold = false;
	const t = new WhatsAppTrigger({
		agentName: "office",
		cfg,
		token: "tok",
		cursorFile,
		knownUsers: () => users,
		allowSender: (s: WaSender) => s.known || !!opts.allowUnknown,
		fetchJson: async (url, token) => {
			assert.equal(token, "tok");
			assert.match(url, /\/v1\/messages\?account_id=office&chat_jid=100000000000000001%40g\.us&limit=50$/);
			const rows = rowsByPoll[Math.min(poll, rowsByPoll.length - 1)];
			poll++;
			if (rows === null) throw new Error("ECONNREFUSED");
			return rows;
		},
		dispatch: async (prompt) => {
			runs.push(prompt);
			if (hold) await new Promise<void>((r) => { release = r; });
		},
		setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
		log: (l) => logs.push(l),
	});
	const fire = async () => {
		const due = timers.splice(0);
		for (const x of due) x.fn();
		await new Promise((r) => setImmediate(r));
	};
	return { t, dir, timers, runs, logs, cursorFile, fire, setHold: (h: boolean) => { hold = h; }, release: () => release?.() };
}

describe("poller", () => {
	test("history at startup does not wake; a new message wakes once after the debounce", async () => {
		const base = [msg("a", 10), msg("b", 20)];
		const h = harness([base, [...base, msg("c", 30, { is_from_me: true }), msg("d", 40)], [...base, msg("d", 40)]]);
		await h.t.pollOnce();
		assert.equal(h.timers.length, 0);
		await h.t.pollOnce();
		assert.equal(h.timers.length, 1);
		assert.equal(h.timers[0].ms, 5000);
		await h.fire();
		assert.equal(h.runs.length, 1);
		assert.match(h.runs[0], /msg_id: d/);
		assert.doesNotMatch(h.runs[0], /msg_id: c \|/);
		await h.t.pollOnce();
		assert.equal(h.timers.length, 0, "same message never wakes twice");
		const saved = JSON.parse(readFileSync(h.cursorFile, "utf-8"));
		assert.deepEqual(saved[`office:office:${CHAT}`], { ts: 40, ids: ["d"] });
	});

	test("a burst becomes one run; messages during a run go to the next one", async () => {
		const base = [msg("a", 10)];
		const h = harness([base, [...base, msg("b", 20), msg("c", 21)], [...base, msg("b", 20), msg("c", 21), msg("d", 22)]]);
		await h.t.pollOnce();
		await h.t.pollOnce();
		h.setHold(true);
		await h.fire();
		assert.equal(h.runs.length, 1);
		assert.match(h.runs[0], /2 new messages/);
		await h.t.pollOnce();
		assert.equal(h.timers.length, 0, "no second run while one is active");
		h.release();
		await new Promise((r) => setImmediate(r));
		assert.equal(h.timers.length, 1);
		h.setHold(false);
		await h.fire();
		assert.equal(h.runs.length, 2);
		assert.match(h.runs[1], /msg_id: d/);
	});

	test("unknown senders do not wake a write agent unless allowed", async () => {
		const base = [msg("a", 10)];
		const stranger = msg("s", 20, { sender_phone: "15559999999" });
		const h = harness([base, [...base, stranger]]);
		await h.t.pollOnce();
		await h.t.pollOnce();
		assert.equal(h.timers.length, 0);
		assert.ok(h.logs.some((l) => /unverified sender/.test(l)));
		const h2 = harness([base, [...base, stranger]], { allowUnknown: true });
		await h2.t.pollOnce();
		await h2.t.pollOnce();
		await h2.fire();
		assert.match(h2.runs[0], /\(unverified\)/);
	});

	test("gateway down: logged, no wake, no crash", async () => {
		const h = harness([null as unknown as WaMessage[]]);
		await h.t.pollOnce();
		await h.t.pollOnce();
		assert.equal(h.runs.length, 0);
		assert.equal(h.logs.filter((l) => /poll failed/.test(l)).length, 1);
	});
});

describe("whatsapp skill and wiring", () => {
	const repoRoot = path.join(__dirname, "..", "..");
	const read = (p: string) => readFileSync(path.join(repoRoot, p), "utf-8");
	const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

	test("framework skill ships with placeholders, no hard-coded account or address", () => {
		const body = read("framework/skills/whatsapp/SKILL.md");
		assert.match(body, /^---\nname: whatsapp\n/);
		assert.ok(body.includes("{{WHATSAPP_API_URL}}") && body.includes("{{WHATSAPP_ACCOUNT_ID}}"));
		assert.match(body, /idempotency_key/);
		assert.match(body, /uncertain/);
		assert.match(body, /own rules/);
		assert.doesNotMatch(body, /Answer only when|not for you/i, "relevance is the agent's own rule, not the framework's");
		assert.match(body, /reply-<msg_id>-<n>/);
		assert.doesNotMatch(body, /\d{9,}@g\.us/);
	});

	test("entrypoint loads it only when the API is configured", async () => {
		const { whatsappSkill } = await esmImport(require("node:url").pathToFileURL(path.join(repoRoot, "docker", "prompt-skills.mjs")).href);
		const t = "a {{WHATSAPP_API_URL}} b {{WHATSAPP_ACCOUNT_ID}}";
		assert.equal(whatsappSkill(t, "http://h:1", "office"), "a http://h:1 b office");
		assert.equal(whatsappSkill(t, "", "office"), null);
		assert.equal(whatsappSkill(t, "http://h:1", ""), null);
		assert.equal(whatsappSkill(null, "http://h:1", "office"), null);
		const ep = read("docker/entrypoint.mjs");
		assert.ok(ep.includes("/workspace/.framework/skills/whatsapp/SKILL.md"));
		assert.ok(ep.includes("process.env.WHATSAPP_API_URL"));
	});

	test("runner forwards it and the listener starts the trigger", () => {
		assert.ok(read("listener/src/runner.ts").includes("whatsappDockerArgs(agent.whatsapp)"));
		const idx = read("listener/src/index.ts");
		assert.ok(idx.includes("new WhatsAppTrigger("));
		assert.ok(idx.includes('runAgent(agent, prompt, "whatsapp")'));
	});

	test("a WhatsApp turn is told not to answer in Slack", async () => {
		const { deliveryInstruction } = await import("./studio-delivery");
		const text = deliveryInstruction("whatsapp");
		assert.match(text, /WhatsApp/);
		assert.match(text, /not .*Slack/i);
		assert.equal(deliveryInstruction("slack"), "");
	});
});

describe("no silent loss of wakes", () => {
	test("pending wakes survive a listener restart and run once", async () => {
		const base = [msg("a", 10)];
		const h = harness([base, [...base, msg("b", 20)]]);
		await h.t.pollOnce();
		await h.t.pollOnce();
		assert.equal(h.runs.length, 0, "still in the batching window");
		h.t.stop(); // listener goes down before the window closes
		const h2 = harness([[...base, msg("b", 20)]], { dir: h.dir });
		h2.t.restorePending();
		await h2.fire();
		assert.equal(h2.runs.length, 1);
		assert.match(h2.runs[0], /msg_id: b/);
		await h2.t.pollOnce();
		const h3 = harness([[...base, msg("b", 20)]], { dir: h.dir });
		h3.t.restorePending();
		await h3.fire();
		assert.equal(h3.runs.length, 0, "a started wake is not replayed");
	});

	test("more than a page of new messages: one wake that says older ones were skipped", async () => {
		const base = [msg("a", 10)];
		const flood = Array.from({ length: 50 }, (_, i) => msg(`f${i}`, 100 + i, { is_from_me: true }));
		const h = harness([base, flood]);
		await h.t.pollOnce();
		await h.t.pollOnce();
		await h.fire();
		assert.equal(h.runs.length, 1);
		assert.match(h.runs[0], /older messages were skipped/);
		assert.ok(h.logs.some((l) => /skipped/.test(l)));
	});
});

describe("local source address", () => {
	test("local_address is parsed when it is an IP literal", () => {
		assert.equal(parseWhatsAppConfig({ api_url: "http://h:1", account_id: "a", local_address: " 127.0.0.1 " })!.localAddress, "127.0.0.1");
		assert.equal(parseWhatsAppConfig({ api_url: "http://h:1", account_id: "a", local_address: "::1" })!.localAddress, "::1");
		assert.equal(parseWhatsAppConfig({ api_url: "http://h:1", account_id: "a" })!.localAddress, undefined, "absent: unchanged behavior");
	});

	test("an invalid local_address is dropped, the block still works", () => {
		for (const bad of ["localhost", "300.1.1.1", "10.0.0", "1.2.3.4:80", "", 42, null]) {
			const c = parseWhatsAppConfig({ api_url: "http://h:1", account_id: "a", local_address: bad });
			assert.ok(c, `block stays on for ${JSON.stringify(bad)}`);
			assert.equal(c!.localAddress, undefined, `${JSON.stringify(bad)} is rejected`);
		}
	});

	async function server(handler: (req: IncomingMessage) => { status: number; body: unknown }) {
		const seen: { remote: string | undefined; auth: string | undefined }[] = [];
		const srv = createServer((req, res) => {
			seen.push({ remote: req.socket.remoteAddress, auth: req.headers.authorization });
			const { status, body } = handler(req);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		});
		await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
		const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
		return { url, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
	}

	test("the poller connects from local_address, with the token, and reads the JSON", async () => {
		const s = await server(() => ({ status: 200, body: [msg("a", 10)] }));
		try {
			const c = parseWhatsAppConfig({ api_url: s.url, account_id: "office", watch_chats: [CHAT], local_address: "127.0.0.1" })!;
			const dir = mkdtempSync(path.join(tmpdir(), "wa-local-"));
			const logs: string[] = [];
			const t = new WhatsAppTrigger({
				agentName: "office", cfg: c, token: "tok", cursorFile: path.join(dir, "cursors.json"),
				allowSender: () => true, knownUsers: () => users, dispatch: async () => {},
				setTimer: () => null, log: (l) => logs.push(l),
			});
			await t.pollOnce();
			assert.deepEqual(logs.filter((l) => /poll failed/.test(l)), []);
			assert.equal(s.seen.length, 1);
			assert.equal(s.seen[0].remote, "127.0.0.1");
			assert.equal(s.seen[0].auth, "Bearer tok");
			const saved = JSON.parse(readFileSync(path.join(dir, "cursors.json"), "utf-8"));
			assert.deepEqual(saved[`office:office:${CHAT}`], { ts: 10, ids: ["a"] }, "the response was parsed");
		} finally {
			await s.close();
		}
	});

	// Linux routes all of 127.0.0.0/8 to loopback, so a second source address
	// proves the request really is bound (a default connection comes from 127.0.0.1).
	test("the source address is the configured one, not the default", { skip: process.platform !== "linux" }, async () => {
		const s = await server(() => ({ status: 200, body: [] }));
		try {
			assert.deepEqual(await defaultFetchJson(`${s.url}/v1/messages`, "tok", "127.0.0.2"), []);
			assert.equal(s.seen[0].remote, "127.0.0.2");
		} finally {
			await s.close();
		}
	});

	test("with local_address, a non-2xx status is an error", async () => {
		const s = await server(() => ({ status: 401, body: { error: "unauthorized" } }));
		try {
			await assert.rejects(defaultFetchJson(`${s.url}/v1/messages`, "bad", "127.0.0.1"), /HTTP 401/);
		} finally {
			await s.close();
		}
	});
});
