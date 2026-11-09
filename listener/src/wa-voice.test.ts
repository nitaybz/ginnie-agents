/**
 * Nitay 2026-11-09: "I want Adam to understand voice messages". A WhatsApp
 * voice note is turned into text on the VM (whisper.cpp, Hebrew model, no
 * network) before the agent wakes, and the agent gets the text with it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { WhatsAppTrigger, buildWakePrompt, parseWhatsAppConfig, type WaMessage, type WaSender } from "./whatsapp-trigger";
import { audioContextFor, pickWhisperModel } from "./transcribe";

const CHAT = "100000000000000001@g.us";
const users = { U1: { name: "Dori Example", short_name: "Dori", role: "operator", whatsapp: "15550000001" } };
const cfg = parseWhatsAppConfig({ api_url: "http://h:1", account_id: "office", watch_chats: [CHAT], debounce_seconds: 5 })!;

function msg(id: string, ts: number, extra: Partial<WaMessage> = {}): WaMessage {
	return { id, chat_jid: CHAT, ts, content: "", is_from_me: false, sender_phone: "15550000001", quoted_message_id: null, media_type: null, ...extra };
}
const dori: WaSender = { name: "Dori", role: "operator", phone: "15550000001", known: true };

describe("wake prompt", () => {
	test("a transcribed voice note carries its text", () => {
		const v = msg("v1", 10, { media_type: "audio", filename: "audio_1.ogg" });
		const p = buildWakePrompt({ cfg, chat: CHAT, batch: [{ message: v, sender: dori }], history: [v], users, transcripts: new Map([["v1", "תבדוק עם שולם."]]) });
		assert.match(p, /\[voice message, transcribed: "תבדוק עם שולם\."; msg_id v1\]/);
	});
	test("a voice note that could not be transcribed says so", () => {
		const v = msg("v2", 10, { media_type: "audio" });
		const p = buildWakePrompt({ cfg, chat: CHAT, batch: [{ message: v, sender: dori }], history: [v], users, transcripts: new Map([["v2", null]]) });
		assert.match(p, /\[voice message \(could not be transcribed\); msg_id v2\]/);
	});
	test("earlier voice notes in the context also show their text", () => {
		const v = msg("v0", 5, { media_type: "audio" });
		const n = msg("n1", 10, { content: "נו?" });
		const p = buildWakePrompt({ cfg, chat: CHAT, batch: [{ message: n, sender: dori }], history: [v, n], users, transcripts: new Map([["v0", "תזמין מקשטן"]]) });
		assert.match(p, /msg_id v0\): \[voice message, transcribed: "תזמין מקשטן"/);
	});
	test("other media is unchanged", () => {
		const i = msg("i1", 10, { media_type: "image", filename: "x.jpg" });
		const p = buildWakePrompt({ cfg, chat: CHAT, batch: [{ message: i, sender: dori }], history: [i], users });
		assert.match(p, /\[media: image "x\.jpg"; msg_id i1\]/);
	});
});

function trigger(rows: WaMessage[][], transcribe?: (m: WaMessage) => Promise<string | null>) {
	const dir = mkdtempSync(path.join(tmpdir(), "wa-voice-"));
	const timers: (() => void)[] = [];
	const runs: string[] = [];
	let poll = 0;
	const t = new WhatsAppTrigger({
		agentName: "office", cfg, token: "tok", cursorFile: path.join(dir, "c.json"),
		knownUsers: () => users, allowSender: (s) => s.known,
		fetchJson: async () => rows[Math.min(poll++, rows.length - 1)],
		dispatch: async (prompt) => { runs.push(prompt); },
		setTimer: (fn) => { timers.push(fn); return 1; },
		log: () => {},
		transcribe,
	});
	const fire = async () => { for (const f of timers.splice(0)) f(); await new Promise((r) => setTimeout(r, 5)); };
	return { t, runs, fire };
}

describe("poller", () => {
	test("a new voice note is transcribed before the agent wakes", async () => {
		const asked: string[] = [];
		const base = [msg("a", 1, { content: "hi" })];
		const h = trigger([base, [...base, msg("v", 2, { media_type: "audio" }), msg("t", 3, { content: "text" })]], async (m) => { asked.push(m.id); return "תבדוק עם שולם."; });
		await h.t.pollOnce(); await h.t.pollOnce(); await h.fire();
		assert.deepEqual(asked, ["v"], "only the voice note is transcribed");
		assert.equal(h.runs.length, 1);
		assert.match(h.runs[0], /transcribed: "תבדוק עם שולם\."/);
	});
	test("a failed transcription still wakes the agent, marked as not transcribed", async () => {
		const base = [msg("a", 1, { content: "hi" })];
		const h = trigger([base, [...base, msg("v", 2, { media_type: "audio" })]], async () => { throw new Error("whisper died"); });
		await h.t.pollOnce(); await h.t.pollOnce(); await h.fire();
		assert.equal(h.runs.length, 1);
		assert.match(h.runs[0], /could not be transcribed/);
	});
	test("without a transcriber the old media line is kept", async () => {
		const base = [msg("a", 1, { content: "hi" })];
		const h = trigger([base, [...base, msg("v", 2, { media_type: "audio", filename: "a.ogg" })]]);
		await h.t.pollOnce(); await h.t.pollOnce(); await h.fire();
		assert.match(h.runs[0], /\[media: audio "a\.ogg"; msg_id v\]/);
	});
});

describe("whisper settings", () => {
	test("short clips only process their own length (13s instead of 100s on the VM)", () => {
		assert.ok(audioContextFor(3) >= 150 && audioContextFor(3) <= 400, String(audioContextFor(3)));
		assert.ok(audioContextFor(20) <= 1500);
		assert.equal(audioContextFor(45), 0, "long audio uses the full window");
		assert.equal(audioContextFor(NaN), 0);
	});
	test("the Hebrew model is preferred when present", () => {
		const has = (names: string[]) => (p: string) => names.some((n) => p.endsWith(n));
		assert.match(pickWhisperModel("/m", has(["ggml-ivrit-large-v3-turbo-q5_0.bin", "ggml-small.bin"]))!, /ivrit-large-v3-turbo-q5_0/);
		assert.match(pickWhisperModel("/m", has(["ggml-small.bin"]))!, /ggml-small\.bin$/);
		assert.equal(pickWhisperModel("/m", has([])), null);
	});
});
