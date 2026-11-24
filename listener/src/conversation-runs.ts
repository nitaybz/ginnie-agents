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
import type { AgentConfig, AgentRunResult, RunOptions } from "./runner";

/** A conversation key: letters, digits and . _ : - only, 1 to 128 characters. */
export const CONVERSATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Store "channel" under which conversation sessions are kept (store.ts setThread/getThread). */
export const CONVERSATION_CHANNEL = "conversation";

/** A stored session older than this starts a fresh one. */
export const SESSION_RESUME_MS = 24 * 60 * 60 * 1000;

/** Open runs per agent that may wait for more messages, when the profile does not say. */
export const DEFAULT_MAX_OPEN = 4;

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
	private readonly log: (line: string) => void;

	constructor(private readonly opts: ConversationRunsOptions) {
		this.log = opts.log ?? ((line) => console.log(line));
		this.dispatcher = new ThreadDispatcher<ConversationMessage>({
			// The host already decided this message needs an answer: start at once.
			debounceMs: 0,
			// Generic dispatcher lines name the agent and the conversation key only.
			log: this.log,
			onError: (agentName, err) => this.log(`[${agentName}] conversation run error: ${err instanceof Error ? err.name : "unknown"}`),
			offerToRun: (msg, key) => {
				const inbox = this.inboxes.get(key);
				return !!inbox && inbox.offer(msg, msg.message);
			},
			process: (_agentName, batch) => this.runBatch(batch),
		});
	}

	/** Hand one message of a conversation to its run. Returns at once; the run goes on in the background. */
	deliver(agent: AgentConfig, conversation: string, message: string, profile?: string): Delivery {
		if (!CONVERSATION_ID.test(conversation)) throw new Error("bad conversation id");
		const r = this.dispatcher.enqueue({ agent, channel: CONVERSATION_CHANNEL, threadTs: conversation, message, profile });
		return r === "handed" ? "midrun" : r === "queued" ? "queued" : "started";
	}

	/** Conversation runs going right now for this agent (including ones waiting for more messages). */
	openCount(agentName: string): number {
		return this.open.get(agentName) ?? 0;
	}

	private async runBatch(batch: ConversationMessage[]): Promise<void> {
		const { agent, threadTs: conversation } = batch[0];
		// The latest message's profile names the kind of run.
		const profile = batch[batch.length - 1].profile;
		const key = queueKey(agent.name, CONVERSATION_CHANNEL, conversation);
		const text = batch.map((m) => m.message).join("\n\n");

		const cap = (profile ? agent.runProfiles?.[profile]?.lingerMaxOpen : undefined) ?? this.opts.maxOpen ?? DEFAULT_MAX_OPEN;
		const openBefore = this.openCount(agent.name);
		const runOpts: RunOptions = { linger: openBefore < cap };
		this.open.set(agent.name, openBefore + 1);

		const inbox = agent.midrunMessages !== false
			? openMidRunInbox<ConversationMessage>(this.opts.inboxRoot ?? MIDRUN_ROOT, agent.name, this.log)
			: undefined;
		if (inbox) this.inboxes.set(key, inbox);

		const stored = this.opts.getSession(agent.name, conversation);
		const resumeId = stored && this.opts.now() - stored.createdAt < SESSION_RESUME_MS ? stored.sessionId : undefined;
		const tag = `[${agent.name}] conversation ${conversation}`;
		this.log(
			`${tag}: run ${resumeId ? "resumed" : "new"}, ${batch.length} message(s), ${text.length} chars` +
			`${profile ? `, profile ${profile}` : ""}${runOpts.linger ? "" : `, no open-run wait (${openBefore} open, cap ${cap})`}`,
		);
		try {
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
			this.log(`${tag}: run failed to start: ${redact(err, batch)}`);
		} finally {
			this.open.set(agent.name, this.openCount(agent.name) - 1);
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

/** An error's first line, without any message text of the run it came from. */
function redact(err: unknown, batch: ConversationMessage[]): string {
	let s = err instanceof Error ? err.message : String(err);
	for (const m of batch) if (m.message) s = s.split(m.message).join("[message]");
	return s.split("\n")[0].slice(0, 300);
}
