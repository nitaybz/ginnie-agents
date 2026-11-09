/**
 * Thread routing (Nitay 2026-11-09): "all involved agents in this thread
 * should get the message and decide if it is meant for them".
 *
 *  - Every agent has its own waiting line per thread. Before this, one line
 *    per thread was shared by all agents, so a reply that woke both Adam and
 *    Sally ran once, as Adam, and Sally never saw it.
 *  - An agent is involved in a thread when it posted there (the first message
 *    or a reply) or someone mentioned it there. Involved agents hear every new
 *    message in the thread and get THREAD_NOTE, so each one decides for itself
 *    whether to answer or stay silent.
 */

import { isOwnMessage, mentionsAgent, type AgentIds, type SlackMsgLike } from "./bot-allow";

export const THREAD_NOTE =
	"[You take part in this thread, so you see every new message in it. This one did not mention you and may be meant for another agent or person. " +
	"Answer only if it is for you or needs something only you can supply; otherwise post nothing and end the turn.]";

export function withThreadNote(text: string): string {
	return `${THREAD_NOTE}\n${text}`;
}

export function queueKey(agentName: string, channel: string, threadTs: string): string {
	return `${agentName}|${channel}:${threadTs}`;
}

/** Did this agent post in the thread, or was it mentioned there? */
export function agentInvolved(messages: SlackMsgLike[], agent: AgentIds): boolean {
	return messages.some((m) => isOwnMessage(agent, m) || mentionsAgent(m.text, agent.slackBotId));
}

export interface Dispatchable {
	agent: { name: string };
	channel: string;
	threadTs: string;
}

/**
 * Debounce and serialize runs per agent per thread. Messages for one agent that
 * arrive within debounceMs, or while that agent is still running in the thread,
 * are batched into its next run. Other agents in the same thread are never held.
 */
export class ThreadDispatcher<M extends Dispatchable> {
	private readonly queues = new Map<string, M[]>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly active = new Set<string>();
	private readonly pending = new Set<Promise<void>>();

	constructor(private readonly opts: {
		debounceMs: number;
		process: (agentName: string, batch: M[]) => Promise<void>;
		/** First message in an empty line (show "is thinking"). */
		onFirst?: (msg: M, key: string) => void;
		onError?: (agentName: string, err: unknown) => void;
		log?: (line: string) => void;
	}) {}

	enqueue(msg: M): void {
		const key = queueKey(msg.agent.name, msg.channel, msg.threadTs);
		const queue = this.queues.get(key) || [];
		queue.push(msg);
		this.queues.set(key, queue);
		if (queue.length === 1) this.opts.onFirst?.(msg, key);

		if (this.active.has(key)) {
			this.opts.log?.(`[${msg.agent.name}] Queued message for busy thread ${msg.threadTs} (${queue.length} in queue)`);
			return;
		}
		const existing = this.timers.get(key);
		if (existing) {
			clearTimeout(existing);
			this.opts.log?.(`[${msg.agent.name}] Debounce reset for thread ${msg.threadTs} (${queue.length} messages waiting)`);
		} else if (queue.length === 1) {
			this.opts.log?.(`[${msg.agent.name}] Message received, waiting ${this.opts.debounceMs / 1000}s for more...`);
		}
		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			this.track(this.drain(key, msg.agent.name));
		}, this.opts.debounceMs));
	}

	/** Resolves when no timer is waiting and no run is going (for tests). */
	async idle(): Promise<void> {
		while (this.timers.size > 0 || this.pending.size > 0) {
			if (this.pending.size > 0) await Promise.all([...this.pending]);
			else await new Promise((r) => setTimeout(r, this.opts.debounceMs + 1));
		}
	}

	private track(p: Promise<void>): void {
		this.pending.add(p);
		void p.finally(() => this.pending.delete(p));
	}

	private async drain(key: string, agentName: string): Promise<void> {
		const queue = this.queues.get(key);
		if (!queue || queue.length === 0) return;
		const batch = [...queue];
		this.queues.delete(key);
		if (batch.length > 1) this.opts.log?.(`[${agentName}] Batched ${batch.length} messages for thread ${batch[0].threadTs}`);

		this.active.add(key);
		try {
			await this.opts.process(agentName, batch);
		} catch (err) {
			if (this.opts.onError) this.opts.onError(agentName, err);
			else console.error(`[${agentName}] Queue drain error:`, err);
		} finally {
			this.active.delete(key);
		}
		const next = this.queues.get(key);
		if (next && next.length > 0) {
			this.opts.log?.(`[${agentName}] ${next.length} messages arrived during processing, draining...`);
			await this.drain(key, agentName);
		}
	}
}
