/**
 * Inbound gate for Slack events (app_mention and message handlers).
 *
 * One place decides who an event is from and whether it may wake the agent:
 *  - message events: only plain messages and file shares (bot_message only
 *    for bots); edits, deletes and other subtypes never wake an agent;
 *  - anything from a bot (bot tags, a listed bot user, or users.info is_bot)
 *    goes through the allow list in bot-allow.ts and nowhere else;
 *  - everyone else must pass the sender policy, which refuses role "bot"
 *    for every agent, so a bot whose tags and first lookup were missing is
 *    still refused when the sender lookup says it is a bot;
 *  - a real human posting in a thread resets the agent-to-agent cap.
 */

import {
	NO_BOT_POLICY,
	admitBotMessage,
	isBotMessage,
	isOwnMessage,
	isRealHuman,
	matchAcceptedBot,
	mentionsAgent,
	type AgentTurns,
	type BotDecision,
	type BotEventSeen,
	type BotPolicy,
} from "./bot-allow";
import type { SenderInfo } from "./users";

export interface GateAgent {
	name: string;
	slackBotId: string;
	slackBotMsgId: string;
	boundaries: "read-only" | "write";
	allowUnverifiedSenders: boolean;
	botPolicy?: BotPolicy;
}

// Refuse, at dispatch time, to wake an agent for a sender it must not hear.
// role "bot": always refused; bots reach agents only through the allow list.
// role "external" (real Slack user not in known-users.json) or "unknown"
// (lookup failed): refused for write-capable agents. Silent drop, not a
// posted reply; see ARCHITECTURE.md threat model. Read-only agents and
// `allow_unverified_senders` opt out of the second rule only.
export function passesSenderPolicy(agent: GateAgent, sender: SenderInfo): boolean {
	if (sender.role === "bot") {
		console.log(`[${agent.name}] dispatch refused: bot sender ${sender.userId || "(no id)"} is not on the allow list path`);
		return false;
	}
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

export type InboundResult =
	| { kind: "drop" }
	| { kind: "bot"; decision: Extract<BotDecision, { kind: "accept" }> }
	| { kind: "human"; sender: SenderInfo; slackIsBot: boolean | undefined };

export async function resolveInbound(args: {
	agent: GateAgent;
	source: "mention" | "message";
	event: any;
	turns: AgentTurns;
	seen: BotEventSeen;
	lookupIsBot: (userId: string | undefined) => Promise<boolean | undefined>;
	lookupSender: (userId: string) => Promise<SenderInfo>;
	onHumanInThread: (channel: string, threadTs: string) => void;
	/** Does the agent take part in this thread? Asked only for bot replies in channel threads. */
	lookupInvolved?: (channel: string, threadTs: string) => Promise<boolean>;
}): Promise<InboundResult> {
	const { agent, source, event } = args;
	const policy = agent.botPolicy || NO_BOT_POLICY;
	const tagged = isOwnMessage(agent, event) || isBotMessage(event, policy);

	if (source === "message") {
		const allowed = tagged ? ["file_share", "bot_message"] : ["file_share"];
		if (event.subtype && !allowed.includes(event.subtype)) return { kind: "drop" };
	}

	// An event without bot tags from a Slack bot user is still a bot.
	const slackIsBot = tagged ? true : await args.lookupIsBot(event.user);
	if (tagged || slackIsBot === true) {
		// In the message handler a bot counts in a hand-off channel, as a DM
		// mention, or as a reply in a thread the agent takes part in; a plain
		// channel mention is the app_mention handler's job.
		let involved = false;
		if (source === "message") {
			const inHandoff = policy.handoffChannels.includes(event.channel);
			const dmMention = event.channel_type === "im" && mentionsAgent(event.text, agent.slackBotId);
			const channelReply = Boolean(event.thread_ts) && (event.channel_type === "channel" || event.channel_type === "group");
			// Only listed bots are worth a thread lookup (saves the Slack read budget).
			const listed = Boolean(matchAcceptedBot(event, policy));
			if (!inHandoff && !dmMention && channelReply && listed && args.lookupInvolved && !isOwnMessage(agent, event)) {
				involved = await args.lookupInvolved(event.channel, event.thread_ts).catch(() => false);
			}
			if (!inHandoff && !dmMention && !involved) return { kind: "drop" };
		}
		const d = admitBotMessage({ agent, policy, ev: event, turns: args.turns, seen: args.seen, slackIsBot, involved });
		if (d.kind === "drop" && d.log) console.log(d.log);
		return d.kind === "accept" ? { kind: "bot", decision: d } : { kind: "drop" };
	}

	const sender = await args.lookupSender(event.user);
	if (!passesSenderPolicy(agent, sender)) return { kind: "drop" };
	if (event.thread_ts && isRealHuman({ ev: event, sender, slackIsBot })) args.onHumanInThread(event.channel, event.thread_ts);
	return { kind: "human", sender, slackIsBot };
}
