/**
 * The sign that an agent got a message and is working on it (Nitay 2026-11-16: "I don't always
 * see when she is working").
 *
 * Why the old sign was unreliable: Slack removes the "is thinking…" status every time the bot
 * posts a message and two minutes after it was last set, it was re-set only every 90 seconds, a
 * thread reply that does not @mention the agent got no sign at all, and a failed call was silent.
 *
 * Now every message gets a reaction from the agent the moment it is accepted (👀 received), which
 * changes to ⏳ while a run works on it and is removed when that run ends, however it ends. Runs
 * that will answer (or that take in a message which mentions the agent) also keep the
 * "is thinking…" status up, re-set every few seconds, and clear it at the end. A bot without
 * the reactions:write scope simply shows no reaction (logged once); the status still works.
 */
import { isSlackThreadTs } from "./run-failures";

export const RECEIVED = "eyes";
export const WORKING = "hourglass_flowing_sand";
export const THINKING = "is thinking…";

export interface SignMessage {
	agent: { name: string };
	channel: string;
	threadTs: string;
	messageTs: string;
	/** Woken only because it takes part in the thread: reaction only, it may stay silent. */
	quiet?: boolean;
}

/** The two Slack calls. Both reject with the Slack error (err.data.error or err.message). */
export interface SignApi {
	status(agentName: string, channel: string, threadTs: string, text: string): Promise<void>;
	react(agentName: string, channel: string, ts: string, emoji: string, add: boolean): Promise<void>;
}

const threadKey = (m: SignMessage): string => `${m.agent.name}|${m.channel}:${m.threadTs}`;
const errorCode = (err: unknown): string => String((err as any)?.data?.error || (err as any)?.message || err);

export class WorkingSign {
	private readonly marks = new Map<string, string>();         // message -> reaction it carries now
	private readonly order = new Map<string, Promise<void>>();  // message -> its last reaction call
	private readonly noReactions = new Set<string>();           // agents whose bot may not react
	private readonly statusUp = new Set<string>();              // threads that carry "is thinking…" now
	private readonly complained = new Set<string>();

	constructor(private readonly api: SignApi, private readonly opts: {
		heartbeatMs: number;
		/** Wait before clearing the status, so the reply reaches the client first. */
		clearDelayMs: number;
		log?: (line: string) => void;
	}) {}

	/** A message was accepted for this agent: show it at once, before any waiting. */
	received(m: SignMessage): void {
		void this.mark(m, RECEIVED);
		if (!m.quiet) void this.status(m, THINKING);
	}

	/**
	 * Keep the sign up while `run` works on `batch`, and take it down when it ends or throws.
	 * `picked` returns the messages the run took in while working (mid-run messages).
	 */
	async during<T>(batch: SignMessage[], run: () => Promise<T>, picked: () => SignMessage[] = () => []): Promise<T> {
		const first = batch[0];
		const thread = threadKey(first);
		const loud = batch.find((m) => !m.quiet);
		if (loud) void this.status(loud, THINKING);
		// The status is up when this batch raised it or a message received since did (a mention
		// that arrives while a quiet run works): keep it up, and take it down at the end.
		const beat = () => {
			if (this.statusUp.has(thread)) void this.status(first, THINKING);
			for (const m of [...batch, ...picked()]) void this.mark(m, WORKING);
		};
		beat();
		const timer = setInterval(beat, this.opts.heartbeatMs);
		try {
			return await run();
		} finally {
			clearInterval(timer);
			for (const m of [...batch, ...picked()]) void this.mark(m, null);
			if (this.statusUp.has(thread)) {
				await new Promise((r) => setTimeout(r, this.opts.clearDelayMs));
				await this.status(first, "");
			}
		}
	}

	private mark(m: SignMessage, next: string | null): Promise<void> {
		if (!isSlackThreadTs(m.messageTs) || this.noReactions.has(m.agent.name)) return Promise.resolve();
		const key = `${m.agent.name}|${m.channel}:${m.messageTs}`;
		const prev = this.marks.get(key) || null;
		if (prev === next) return this.order.get(key) || Promise.resolve();
		if (next) this.marks.set(key, next);
		else this.marks.delete(key);
		// One message's calls run in order, so a remove never overtakes its add.
		const p = (this.order.get(key) || Promise.resolve()).then(async () => {
			if (prev) await this.react(m, prev, false);
			if (next) await this.react(m, next, true);
		}).finally(() => { if (this.order.get(key) === p) this.order.delete(key); });
		this.order.set(key, p);
		return p;
	}

	private async react(m: SignMessage, emoji: string, add: boolean): Promise<void> {
		if (this.noReactions.has(m.agent.name)) return;
		try {
			await this.api.react(m.agent.name, m.channel, m.messageTs, emoji, add);
		} catch (err) {
			const code = errorCode(err);
			if (code === "already_reacted" || code === "no_reaction") return;
			if (code === "missing_scope" || code === "not_allowed_token_type") {
				if (this.noReactions.has(m.agent.name)) return;
				this.noReactions.add(m.agent.name);
				this.opts.log?.(`[${m.agent.name}] no reaction sign: the Slack app lacks the reactions:write scope (add it and reinstall the app)`);
				return;
			}
			this.complain(`${m.agent.name}|react|${code}`, `[${m.agent.name}] reaction sign failed: ${code}`);
		}
	}

	private async status(m: SignMessage, text: string): Promise<void> {
		if (!isSlackThreadTs(m.threadTs)) return;
		if (text) this.statusUp.add(threadKey(m));
		else this.statusUp.delete(threadKey(m));
		try {
			await this.api.status(m.agent.name, m.channel, m.threadTs, text);
		} catch (err) {
			const code = errorCode(err);
			this.complain(`${m.agent.name}|status|${code}`, `[${m.agent.name}] "is thinking" status failed: ${code}`);
		}
	}

	// Each kind of failure is logged once per agent, not on every heartbeat.
	private complain(key: string, line: string): void {
		if (this.complained.has(key)) return;
		this.complained.add(key);
		this.opts.log?.(line);
	}
}
