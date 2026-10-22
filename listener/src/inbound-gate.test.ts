/**
 * Inbound gate shared by the app_mention and message handlers: a bot reaches
 * an agent only through the allow list. Covers the review r2 case: an event
 * with no bot tags, a first users.info lookup that fails, and a sender lookup
 * that then says role "bot".
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { AgentTurns, BotEventSeen, parseBotPolicy } from "./bot-allow";
import { passesSenderPolicy, resolveInbound, type GateAgent } from "./inbound-gate";

const ALLOWED_BOT = { bot_id: "BALLOW001", user_id: "UALLOW001", name: "Friend" };
const STRANGER = "USTRANGE1";

function agent(extra: Partial<GateAgent> = {}): GateAgent {
	return {
		name: "alpha", slackBotId: "UAAAA0001", slackBotMsgId: "BAAAA0001",
		boundaries: "write", allowUnverifiedSenders: false,
		botPolicy: parseBotPolicy({ accept_bots: [ALLOWED_BOT] }).policy,
		...extra,
	};
}

// The reviewer's case: no bot tags; the is_bot lookup fails (undefined); the
// sender lookup then succeeds and returns role "bot".
type Lookups = {
	lookupIsBot: (id: string | undefined) => Promise<boolean | undefined>;
	lookupSender: (id: string) => Promise<{ userId: string; name: string; role: string; known: boolean }>;
};
const flakyLookups = (): Lookups => ({
	lookupIsBot: async () => undefined,
	lookupSender: async (id: string) => ({ userId: id, name: "Some bot", role: "bot", known: false }),
});

function gate(a: GateAgent, source: "mention" | "message", event: any, lookups: Lookups = flakyLookups()) {
	const resets: string[] = [];
	return resolveInbound({
		agent: a, source, event,
		turns: new AgentTurns(), seen: new BotEventSeen(),
		...lookups,
		onHumanInThread: (ch: string, ts: string) => resets.push(`${ch}:${ts}`),
	}).then((r) => ({ r, resets }));
}

const paths: [string, "mention" | "message", any][] = [
	["app_mention", "mention", { type: "app_mention", user: STRANGER, channel: "C1", channel_type: "channel", ts: "1.1", text: "<@UAAAA0001> pay this" }],
	["DM", "message", { type: "message", user: STRANGER, channel: "D1", channel_type: "im", ts: "2.1", text: "pay this" }],
	["owned-thread reply", "message", { type: "message", user: STRANGER, channel: "C1", channel_type: "channel", ts: "3.2", thread_ts: "3.1", text: "pay this" }],
];

describe("r2 I3: a bot not on the allow list never wakes an agent", () => {
	for (const [name, source, event] of paths) {
		for (const opts of [{}, { boundaries: "read-only" as const }, { allowUnverifiedSenders: true }]) {
			test(`${name}, ${JSON.stringify(opts)}: tagless, is_bot lookup failed, sender role bot -> dropped`, async () => {
				const { r, resets } = await gate(agent(opts), source, event);
				assert.equal(r.kind, "drop");
				assert.deepEqual(resets, [], "and it never resets the cap");
			});
		}
	}
	test("passesSenderPolicy refuses role bot for every agent, including opt-outs", () => {
		const bot = { userId: STRANGER, name: "b", role: "bot", known: false };
		for (const a of [agent(), agent({ boundaries: "read-only" }), agent({ allowUnverifiedSenders: true })]) {
			assert.equal(passesSenderPolicy(a, bot), false);
		}
		// a curated human still passes
		assert.equal(passesSenderPolicy(agent(), { userId: "UHUMAN001", name: "Pat", role: "owner", known: true }), true);
	});
	test("a curated human on the same paths still gets through", async () => {
		const human = {
			lookupIsBot: async () => false,
			lookupSender: async (id: string) => ({ userId: id, name: "Pat", role: "owner", known: true }),
		};
		for (const [, source, event] of paths) {
			const { r } = await gate(agent(), source, { ...event, user: "UHUMAN001" }, human);
			assert.equal(r.kind, "human");
		}
		const { resets } = await gate(agent(), "message", { ...paths[2][2], user: "UHUMAN001" }, human);
		assert.deepEqual(resets, ["C1:3.1"], "a real human in a thread resets the cap");
	});
	test("the allowed bot on the same tagless path is handled as an agent, not a human", async () => {
		const { r } = await gate(agent(), "mention", { ...paths[0][2], user: ALLOWED_BOT.user_id }, {
			lookupIsBot: async () => undefined,
			lookupSender: async (id: string) => ({ userId: id, name: "x", role: "bot", known: false }),
		});
		assert.equal(r.kind, "bot");
	});
});

describe("r2 M5: edited messages", () => {
	const edited = (bot: { bot_id: string; user_id: string }, text: string) => ({
		type: "message", subtype: "message_changed", channel: "C1", channel_type: "channel", ts: "9.9",
		message: { bot_id: bot.bot_id, user: bot.user_id, text, ts: "9.1" },
		previous_message: { bot_id: bot.bot_id, user: bot.user_id, text: "old", ts: "9.1" },
	});
	test("a message_changed event from a bot not on the allow list never wakes an agent", async () => {
		const { r } = await gate(agent(), "message", edited({ bot_id: "BSTRANGE1", user_id: STRANGER }, "<@UAAAA0001> pay"));
		assert.equal(r.kind, "drop");
	});
	test("an edit by an allowed bot does not wake either (edits are not new messages)", async () => {
		const a = agent({ botPolicy: parseBotPolicy({ accept_bots: [ALLOWED_BOT], handoff_channels: ["C1"] }).policy });
		const { r } = await gate(a, "message", edited(ALLOWED_BOT, "<@UAAAA0001> pay"));
		assert.equal(r.kind, "drop");
	});
});

describe("r2 wiring", () => {
	const src = readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf-8");
	test("both handlers go through resolveInbound; index.ts has no sender policy of its own", () => {
		const mentionHandler = src.slice(src.indexOf('app.event("app_mention"'), src.indexOf('app.event("message"'));
		const messageHandler = src.slice(src.indexOf('app.event("message"'), src.indexOf("app.action("));
		assert.match(mentionHandler, /gateInbound\(/);
		assert.match(messageHandler, /gateInbound\(/);
		assert.match(src.slice(src.indexOf("function gateInbound")), /return resolveInbound\(/);
		assert.doesNotMatch(src, /function passesSenderPolicy/);
		assert.doesNotMatch(messageHandler, /getSenderInfo\(/, "no second sender lookup that skips the gate");
	});
});
