/**
 * Conversation runs: one open run per conversation, fed by POST /studio/converse.
 *
 * A host process (a chat line's host script, for example) hands the listener
 * each new message of a conversation, named by a key it chooses. Per agent and
 * conversation:
 *  - no run going: the message starts one ("started"), with no debounce;
 *  - a run going: the message goes into its mid-run inbox and reaches the
 *    session between steps ("midrun", midrun-inbox.ts);
 *  - the run is ending (its inbox closed): the message waits in line and runs
 *    next ("queued").
 * A run resumes the conversation's stored session when its last activity was
 * under 24 hours ago, else it starts fresh. The run can stay open for more
 * messages after its answer (its profile's linger_minutes); past the
 * agent's open-run cap (linger_max_open, default 4) a new run starts without
 * that wait, so a busy line cannot keep every container up.
 *
 * Unlike a Slack run, the message text is passed as is (no Slack envelope),
 * nothing is posted to Slack and there is no working sign: the host owns the
 * channel. A failed run is logged; the mid-run messages it did not get run
 * next, exactly as on the Slack line.
 *
 * Privacy: message text can carry customer names and phone numbers. It goes
 * only into the run's prompt and its mid-run inbox. Log lines name the agent,
 * the conversation key, the delivery and lengths, never the text.
 */

import { MIDRUN_ROOT, openMidRunInbox, type MidRunInbox } from "./midrun-inbox";
import { ThreadDispatcher, queueKey } from "./thread-routing";
import { errorCode, runAgent, resumeAgent, type AgentConfig, type AgentRunResult, type RunOptions } from "./runner";
import { getThread, setThread } from "./store";

/** A conversation key: letters, digits and . _ : - only, 1 to 128 characters. */
export const CONVERSATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Store "channel" under which conversation sessions are kept (store.ts setThread/getThread). */
export const CONVERSATION_CHANNEL = "conversation";

/** A stored session older than this starts a fresh one. */
export const SESSION_RESUME_MS = 24 * 60 * 60 * 1000;

/** Open runs per agent that may wait for more messages, when the profile does not say. */
export const DEFAULT_MAX_OPEN = 4;

/** Conversation runs per agent that may run at once, when the profile does not say (max_running). */
export const DEFAULT_MAX_RUNNING = 8;

export type Delivery = "midrun" | "started" | "queued";

export interface ConversationRunsOptions {
	run: (agent: AgentConfig, message: string, midrunDir: string | undefined, profile: string | undefined, opts: RunOptions) => Promise<AgentRunResult>;
	resume: (
		agent: AgentConfig, sessionId: string, message: string, midrunDir: string | undefined, profile: string | undefined, opts: RunOptions,
	) => Promise<AgentRunResult>;
	getSession: (agentName: string, conversation: string) => { sessionId: string; createdAt: number } | undefined;
	setSession: (agentName: string, conversation: string, sessionId: string) => void;
	now: () => number;
	/** Open-run cap when the profile has no linger_max_open. */
	maxOpen?: number;
	/** Where run inboxes are made (default: the listener's mid-run root, cleared at start). */
	inboxRoot?: string;
	log?: (line: string) => void;
}

interface ConversationMessage {
	agent: AgentConfig;
	channel: string;
	threadTs: string; // the conversation key
	message: string;
	profile?: string;
}

export class ConversationRuns {
	private readonly dispatcher: ThreadDispatcher<ConversationMessage>;
	private readonly inboxes = new Map<string, MidRunInbox<ConversationMessage>>();
	private readonly open = new Map<string, number>();
	/** Per agent: conversations let through to the dispatcher (starting, running or with messages in its line). */
	private readonly live = new Map<string, Set<string>>();
	/** Per agent: conversations held back by max_running, oldest first, with their messages. */
	private readonly held = new Map<string, Array<{ conversation: string; msgs: ConversationMessage[] }>>();
	private readonly log: (line: string) => void;

	constructor(private readonly opts: ConversationRunsOptions) {
		this.log = opts.log ?? ((line) => console.log(line));
		this.dispatcher = new ThreadDispatcher<ConversationMessage>({
			// The host already decided this message needs an answer: start at once.
			debounceMs: 0,
			// Generic dispatcher lines name the agent and the conversation key only.
			log: this.log,
			onError: (agentName, err) => this.log(`[${agentName}] conversation run error: ${errorCode(err)}`),
			offerToRun: (msg, key) => {
				const inbox = this.inboxes.get(key);
				return !!inbox && inbox.offer(msg, msg.message);
			},
			process: (_agentName, batch) => this.runBatch(batch),
			onDrained: (key) => this.release(key),
		});
	}

	/**
	 * Hand one message of a conversation to its run. Returns at once; the run
	 * goes on in the background. Throws on a bad conversation key or a profile
	 * the agent does not define.
	 */
	deliver(agent: AgentConfig, conversation: string, message: string, profile?: string): Delivery {
		if (!CONVERSATION_ID.test(conversation)) throw new Error("bad conversation id");
		if (profile !== undefined && !Object.prototype.hasOwnProperty.call(agent.runProfiles ?? {}, profile)) throw new Error("unknown run profile");
		const msg: ConversationMessage = { agent, channel: CONVERSATION_CHANNEL, threadTs: conversation, message, profile };
		const live = this.liveSet(agent.name);
		if (!live.has(conversation)) {
			const held = this.held.get(agent.name) ?? [];
			const waiting = held.find((h) => h.conversation === conversation);
			if (waiting) {
				waiting.msgs.push(msg);
				return "queued";
			}
			const max = (profile ? agent.runProfiles?.[profile]?.maxRunning : undefined) ?? DEFAULT_MAX_RUNNING;
			if (live.size >= max) {
				held.push({ conversation, msgs: [msg] });
				this.held.set(agent.name, held);
				this.log(`[${agent.name}] conversation ${conversation}: ${live.size} conversations running (max ${max}), waiting in line`);
				return "queued";
			}
			live.add(conversation);
		}
		const r = this.dispatcher.enqueue(msg);
		return r === "handed" ? "midrun" : r === "queued" ? "queued" : "started";
	}

	/** Conversation runs going right now for this agent (including ones waiting for more messages). */
	openCount(agentName: string): number {
		return this.open.get(agentName) ?? 0;
	}

	private liveSet(agentName: string): Set<string> {
		let set = this.live.get(agentName);
		if (!set) this.live.set(agentName, (set = new Set()));
		return set;
	}

	/** A conversation's line is empty and its run is over: free its place and let held ones in. */
	private release(key: string): void {
		const sep = key.indexOf("|");
		const agentName = key.slice(0, sep);
		const conversation = key.slice(sep + 1 + CONVERSATION_CHANNEL.length + 1);
		const live = this.liveSet(agentName);
		live.delete(conversation);
		const held = this.held.get(agentName);
		while (held?.length) {
			const next = held[0];
			const last = next.msgs[next.msgs.length - 1];
			const max = (last.profile ? last.agent.runProfiles?.[last.profile]?.maxRunning : undefined) ?? DEFAULT_MAX_RUNNING;
			if (live.size >= max) break;
			held.shift();
			live.add(next.conversation);
			for (const m of next.msgs) this.dispatcher.enqueue(m);
		}
	}

	private async runBatch(batch: ConversationMessage[]): Promise<void> {
		const { agent, threadTs: conversation } = batch[0];
		// The latest message's profile names the kind of run (checked in deliver()).
		const profile = batch[batch.length - 1].profile;
		const key = queueKey(agent.name, CONVERSATION_CHANNEL, conversation);
		const text = batch.map((m) => m.message).join("\n\n");
		const tag = `[${agent.name}] conversation ${conversation}`;

		let counted = false;
		let inbox: MidRunInbox<ConversationMessage> | undefined;
		try {
			const cap = (profile ? agent.runProfiles?.[profile]?.lingerMaxOpen : undefined) ?? this.opts.maxOpen ?? DEFAULT_MAX_OPEN;
			const openBefore = this.openCount(agent.name);
			const runOpts: RunOptions = { linger: openBefore < cap };
			this.open.set(agent.name, openBefore + 1);
			counted = true;

			inbox = agent.midrunMessages !== false
				? openMidRunInbox<ConversationMessage>(this.opts.inboxRoot ?? MIDRUN_ROOT, agent.name, this.log)
				: undefined;
			if (inbox) this.inboxes.set(key, inbox);

			const stored = this.opts.getSession(agent.name, conversation);
			const resumeId = stored && this.opts.now() - stored.createdAt < SESSION_RESUME_MS ? stored.sessionId : undefined;
			this.log(
				`${tag}: run ${resumeId ? "resumed" : "new"}, ${batch.length} message(s), ${text.length} chars` +
				`${profile ? `, profile ${profile}` : ""}${runOpts.linger ? "" : `, no open-run wait (${openBefore} open, cap ${cap})`}`,
			);
			const r = resumeId
				? await this.opts.resume(agent, resumeId, text, inbox?.dir, profile, runOpts)
				: await this.opts.run(agent, text, inbox?.dir, profile, runOpts);
			if (r.isError) {
				// The result text may quote the conversation: its length only.
				this.log(`${tag}: run failed${r.limitHit ? " (usage limit)" : ""} (result ${r.result.length} chars)`);
			} else {
				// Every good run stamps the session, so "last activity" is the last run's end.
				this.opts.setSession(agent.name, conversation, r.sessionId);
			}
		} catch (err) {
			// The code only: an error can carry the run's args or text.
			this.log(`${tag}: run failed to start: ${errorCode(err)}`);
		} finally {
			if (counted) this.open.set(agent.name, this.openCount(agent.name) - 1);
			if (inbox) {
				this.inboxes.delete(key);
				// What the run was handed but did not get runs next, ahead of later messages.
				const left = inbox.finish();
				if (left.length) this.log(`${tag}: ${left.length} mid-run message(s) not taken by the run, queued for the next run`);
				this.dispatcher.requeue(key, left);
			}
		}
	}
}

/**
 * The conversation runs the listener uses (index.ts): containers through
 * runAgent/resumeAgent with origin "conversation", sessions in the thread
 * store under the "conversation" channel.
 */
export function listenerConversationRuns(extra: { inboxRoot?: string; log?: (line: string) => void } = {}): ConversationRuns {
	return new ConversationRuns({
		run: (agent, message, midrunDir, profile, opts) => runAgent(agent, message, "conversation", midrunDir, profile, opts),
		resume: (agent, sessionId, message, midrunDir, profile, opts) =>
			resumeAgent(agent, sessionId, message, "conversation", midrunDir, profile, opts),
		getSession: (agentName, conversation) => getThread(agentName, CONVERSATION_CHANNEL, conversation),
		setSession: (agentName, conversation, sessionId) => setThread(CONVERSATION_CHANNEL, conversation, sessionId, agentName),
		now: () => Date.now(),
		inboxRoot: extra.inboxRoot,
		log: extra.log,
	});
}
