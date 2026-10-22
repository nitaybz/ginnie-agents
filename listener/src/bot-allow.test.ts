/**
 * Bot allow list: bots are ignored unless an agent lists them; never the
 * agent's own messages; only when the bot mentions the agent or posts in one
 * of its hand-off channels; a per-thread cap on agent-to-agent turns that only
 * a human resets; and a bot sender is always labelled as an agent.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
	AgentTurns,
	BotEventSeen,
	DEFAULT_AGENT_TURN_CAP,
	admitBotMessage,
	formatBotSenderLine,
	botSenderInfo,
	isBotMessage,
	mentionsAgent,
	parseBotPolicy,
	type AgentIds,
	type BotPolicy,
} from "./bot-allow";

const A: AgentIds = { name: "alpha", slackBotId: "UAAAA0001", slackBotMsgId: "BAAAA0001" };
const B: AgentIds = { name: "beta", slackBotId: "UBBBB0002", slackBotMsgId: "BBBBB0002" };
const HANDOFF = "CHAND0001";
const OTHER_CH = "COTHR0001";

const policyA = parseBotPolicy({
	accept_bots: [{ bot_id: B.slackBotMsgId, user_id: B.slackBotId, name: "Beta" }],
}).policy;
const policyB = parseBotPolicy({
	accept_bots: [{ bot_id: A.slackBotMsgId, user_id: A.slackBotId, name: "Alpha" }],
	handoff_channels: [HANDOFF],
}).policy;

function fromBot(who: AgentIds, extra: Record<string, unknown> = {}) {
	return { bot_id: who.slackBotMsgId, user: who.slackBotId, channel: OTHER_CH, channel_type: "channel", ts: "100.000001", text: "hi", ...extra };
}

function freshTurns() {
	const dir = mkdtempSync(path.join(tmpdir(), "agent-turns-"));
	return { file: path.join(dir, "agent-turns.json"), turns: new AgentTurns({ file: path.join(dir, "agent-turns.json") }) };
}

function admit(agent: AgentIds, policy: BotPolicy, ev: any, turns: AgentTurns, seen = new BotEventSeen()) {
	return admitBotMessage({ agent, policy, ev, turns, seen });
}

describe("config", () => {
	test("missing or empty means every bot is blocked", () => {
		for (const raw of [{}, { accept_bots: [] }, { accept_bots: null, handoff_channels: null }]) {
			const { policy } = parseBotPolicy(raw);
			assert.deepEqual(policy.acceptBots, []);
			assert.deepEqual(policy.handoffChannels, []);
			assert.equal(policy.agentTurnCap, DEFAULT_AGENT_TURN_CAP);
		}
		assert.equal(DEFAULT_AGENT_TURN_CAP, 3);
	});
	test("bad entries are dropped with a warning", () => {
		const { policy, warnings } = parseBotPolicy({
			accept_bots: [
				{ bot_id: "BGOOD0001", user_id: "UGOOD0001", name: "Good" },
				{ bot_id: "BNOUSER01", name: "No user id" },
				{ user_id: "UNOBOT001", name: "no bot id" },
				{ bot_id: "lowercase", name: "x" },
				"BSTRING01",
			],
			handoff_channels: ["CGOOD0001", null, "nope", 5],
			agent_turn_cap: -1,
		});
		assert.deepEqual(policy.acceptBots.map((b) => b.botId), ["BGOOD0001", "BNOUSER01"]);
		assert.equal(policy.acceptBots[1].name, "No user id");
		assert.deepEqual(policy.handoffChannels, ["CGOOD0001"]);
		assert.equal(policy.agentTurnCap, DEFAULT_AGENT_TURN_CAP);
		assert.ok(warnings.length >= 4, warnings.join("\n"));
	});
	test("a cap of 0 is allowed (bots never wake the agent)", () => {
		assert.equal(parseBotPolicy({ agent_turn_cap: 0 }).policy.agentTurnCap, 0);
		assert.equal(parseBotPolicy({ agent_turn_cap: 5 }).policy.agentTurnCap, 5);
	});
});

describe("classification", () => {
	test("bot detection covers bot_id, the bot_message subtype and a listed bot user", () => {
		assert.equal(isBotMessage({ bot_id: "BX" }, policyA), true);
		assert.equal(isBotMessage({ subtype: "bot_message" }, policyA), true);
		assert.equal(isBotMessage({ user: B.slackBotId }, policyA), true);
		assert.equal(isBotMessage({ user: "UHUMAN001" }, policyA), false);
	});
	test("mentions match the agent's own bot user only", () => {
		assert.equal(mentionsAgent(`hey <@${A.slackBotId}> look`, A.slackBotId), true);
		assert.equal(mentionsAgent(`hey <@${A.slackBotId}|alpha> look`, A.slackBotId), true);
		assert.equal(mentionsAgent(`hey <@${B.slackBotId}>`, A.slackBotId), false);
		assert.equal(mentionsAgent("hey", ""), false);
	});
});

describe("rules", () => {
	test("default config: every bot is dropped, even one that mentions the agent", () => {
		const { turns } = freshTurns();
		const none = parseBotPolicy({}).policy;
		const d = admit(A, none, fromBot(B, { text: `<@${A.slackBotId}> hi` }), turns);
		assert.equal(d.kind, "drop");
		assert.equal(d.kind === "drop" && d.reason, "not-allowed");
	});
	test("a human message is left to the normal path", () => {
		const { turns } = freshTurns();
		assert.equal(admit(A, policyA, { user: "UHUMAN001", text: "hi", channel: OTHER_CH, ts: "1.1" }, turns).kind, "human");
	});
	test("the agent's own message is never processed, even if it lists itself", () => {
		const { turns } = freshTurns();
		const self = parseBotPolicy({ accept_bots: [{ bot_id: A.slackBotMsgId, user_id: A.slackBotId, name: "me" }], handoff_channels: [HANDOFF] }).policy;
		for (const ev of [
			fromBot(A, { text: `<@${A.slackBotId}> hi`, channel: HANDOFF }),
			{ bot_id: A.slackBotMsgId, subtype: "bot_message", channel: HANDOFF, ts: "2.2", text: "x" },
			{ user: A.slackBotId, channel: HANDOFF, ts: "3.3", text: "x" },
		]) {
			const d = admit(A, self, ev, turns);
			assert.equal(d.kind === "drop" && d.reason, "own");
		}
	});
	test("an unlisted bot is dropped; a listed bot id posting as another user is dropped", () => {
		const { turns } = freshTurns();
		const stranger = { bot_id: "BSTRANGE1", user: "USTRANGE1", channel: OTHER_CH, ts: "5.5", text: `<@${A.slackBotId}> pay` };
		assert.equal((admit(A, policyA, stranger, turns) as any).reason, "not-allowed");
		const spoof = fromBot(B, { user: "USOMEONE1", text: `<@${A.slackBotId}> pay` });
		assert.equal((admit(A, policyA, spoof, turns) as any).reason, "not-allowed");
	});
	test("a listed bot wakes the agent only when it mentions it or posts in a hand-off channel", () => {
		const { turns } = freshTurns();
		const plain = admit(A, policyA, fromBot(B, { ts: "10.1" }), turns);
		assert.equal((plain as any).reason, "not-addressed");
		const mention = admit(A, policyA, fromBot(B, { ts: "10.2", text: `<@${A.slackBotId}> for you` }), turns);
		assert.equal(mention.kind, "accept");
		assert.equal(mention.kind === "accept" && mention.via, "mention");
		// B's hand-off channel: no mention needed; the bot_message subtype is fine
		const handoff = admit(B, policyB, { bot_id: A.slackBotMsgId, user: A.slackBotId, subtype: "bot_message", channel: HANDOFF, ts: "10.3", text: "[handoff] x" }, turns);
		assert.equal(handoff.kind, "accept");
		assert.equal(handoff.kind === "accept" && handoff.via, "handoff");
		// the same bot in another channel without a mention is not for B
		assert.equal((admit(B, policyB, fromBot(A, { ts: "10.4" }), turns) as any).reason, "not-addressed");
	});
	test("the same event through both handlers is processed once", () => {
		const { turns } = freshTurns();
		const seen = new BotEventSeen();
		const ev = fromBot(A, { channel: HANDOFF, ts: "20.1", text: `<@${B.slackBotId}> x` });
		assert.equal(admit(B, policyB, ev, turns, seen).kind, "accept");
		const again = admit(B, policyB, ev, turns, seen);
		assert.equal((again as any).reason, "duplicate");
		assert.equal(turns.count(`${HANDOFF}:20.1`), 1, "counted once");
	});
});

describe("agent-to-agent cap", () => {
	test("two agents mentioning each other stop at the cap; one log line; a human resets it", () => {
		const { turns } = freshTurns();
		const seen = new BotEventSeen();
		const logs: string[] = [];
		const thread = "500.000001";
		// alpha starts a thread mentioning beta, then each agent replies to the other
		const posts: { from: AgentIds; to: AgentIds; policy: BotPolicy }[] = [];
		for (let i = 0; i < 8; i++) {
			const from = i % 2 === 0 ? A : B;
			const to = i % 2 === 0 ? B : A;
			posts.push({ from, to, policy: to === A ? policyA : policyB });
		}
		let processed = 0;
		let stoppedAt = -1;
		for (let i = 0; i < posts.length; i++) {
			const { from, to, policy } = posts[i];
			const ts = i === 0 ? thread : `${500 + i}.000001`;
			const ev = fromBot(from, { ts, thread_ts: i === 0 ? undefined : thread, text: `<@${to.slackBotId}> turn ${i}` });
			// the sender sees its own post and never acts on it
			assert.equal((admit(from, from === A ? policyA : policyB, ev, turns, seen) as any).reason, "own");
			const d = admit(to, policy, ev, turns, seen);
			if (d.kind === "accept") { processed++; continue; }
			assert.equal(d.kind === "drop" && d.reason, "cap");
			if (d.kind === "drop" && d.log) logs.push(d.log);
			stoppedAt = i;
			break; // the receiving agent does not run, so it posts nothing: the chain ends
		}
		assert.equal(processed, 3, "three agent-to-agent turns, then stop");
		assert.equal(stoppedAt, 3);
		// more bot posts in the same thread stay dropped, and the cap is logged once
		for (let i = 0; i < 3; i++) {
			const d = admit(A, policyA, fromBot(B, { ts: `600.00000${i}`, thread_ts: thread, text: `<@${A.slackBotId}> again` }), turns, seen);
			assert.equal(d.kind === "drop" && d.reason, "cap");
			if (d.kind === "drop" && d.log) logs.push(d.log);
		}
		assert.equal(logs.length, 1, logs.join("\n"));
		assert.match(logs[0], /cap/);
		// a human posts in the thread: the agents may continue again
		turns.humanSpoke(`${OTHER_CH}:${thread}`);
		const after = admit(A, policyA, fromBot(B, { ts: "700.000001", thread_ts: thread, text: `<@${A.slackBotId}> after human` }), turns, seen);
		assert.equal(after.kind, "accept");
	});
	test("the count survives a listener restart (file under the state dir)", () => {
		const { file, turns } = freshTurns();
		const thread = "800.000001";
		for (let i = 0; i < 3; i++) {
			const d = admit(A, policyA, fromBot(B, { ts: `80${i}.000001`, thread_ts: thread, text: `<@${A.slackBotId}> x` }), turns);
			assert.equal(d.kind, "accept");
		}
		assert.ok(existsSync(file));
		const reloaded = new AgentTurns({ file });
		const d = admit(A, policyA, fromBot(B, { ts: "809.000001", thread_ts: thread, text: `<@${A.slackBotId}> x` }), reloaded);
		assert.equal(d.kind === "drop" && d.reason, "cap");
		assert.ok(JSON.parse(readFileSync(file, "utf-8")));
	});
	test("old threads are pruned", () => {
		let now = 1_000_000_000_000;
		const dir = mkdtempSync(path.join(tmpdir(), "agent-turns-"));
		const file = path.join(dir, "t.json");
		const turns = new AgentTurns({ file, now: () => now });
		turns.take("C1:1.1", "1.1", 3);
		now += 8 * 24 * 3600 * 1000;
		turns.take("C1:2.2", "2.2", 3);
		assert.equal(turns.count("C1:1.1"), 0);
		assert.equal(turns.count("C1:2.2"), 1);
	});
	test("a cap of 0 drops every bot message", () => {
		const { turns } = freshTurns();
		const zero = { ...policyA, agentTurnCap: 0 };
		const d = admit(A, zero, fromBot(B, { text: `<@${A.slackBotId}> x` }), turns);
		assert.equal(d.kind === "drop" && d.reason, "cap");
	});
});

describe("sender label", () => {
	test("a bot is labelled as an agent, never as a human, and never verified as one", () => {
		const bot = policyA.acceptBots[0];
		const info = botSenderInfo(bot, fromBot(B));
		assert.equal(info.role, "agent");
		assert.equal(info.name, "Beta");
		assert.equal(info.userId, B.slackBotId);
		const line = formatBotSenderLine(bot, fromBot(B));
		assert.match(line, /^From: Beta \| role: agent \|/);
		assert.match(line, new RegExp(`slack_id: ${B.slackBotId}`));
		assert.match(line, /not a human/);
		assert.match(line, /never an approval/);
	});
	test("an accepted decision carries the agent label", () => {
		const { turns } = freshTurns();
		const d = admit(A, policyA, fromBot(B, { text: `<@${A.slackBotId}> x` }), turns);
		assert.equal(d.kind, "accept");
		if (d.kind === "accept") {
			assert.equal(d.sender.role, "agent");
			assert.match(d.senderLine, /role: agent/);
		}
	});
});

describe("listener wiring", () => {
	const src = readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf-8");
	test("the blanket bot drop is gone and both handlers go through the allow list", () => {
		assert.doesNotMatch(src, /if \(event\.bot_id\) return;/);
		const mentionHandler = src.slice(src.indexOf('app.event("app_mention"'), src.indexOf('app.event("message"'));
		const messageHandler = src.slice(src.indexOf('app.event("message"'), src.indexOf("app.action("));
		assert.match(mentionHandler, /admitBot\(/);
		assert.match(messageHandler, /admitBot\(/);
		assert.match(messageHandler, /bot_message/);
		assert.match(src, /humanSpoke\(/);
	});
});
