/**
 * The sign that an agent got a message and is working on it (Nitay 2026-11-16: "I don't always
 * see when she is working").
 *
 * Slack removes the "is thinking…" status every time the bot posts a message and two minutes
 * after it was last set, so it is re-set every few seconds for the whole run and cleared at the
 * end, however the run ends. A person's message (a mention, a DM, a thread reply) raises it at
 * once, before any waiting; a wake by another agent's message stays quiet, since that run may end
 * silent.
 *
 * Nitay 2026-11-23: this status is the only sign, the way Sasha shows it. The 👀 then ⏳
 * reactions it used to add are gone ("why did Gadi react with an eyes emoji? ... the hourglass is
 * the old method"): only Gadi's Slack app could add them, so only his runs showed them.
 */
import { isSlackThreadTs } from "./run-failures";

export const THINKING = "is thinking…";

export interface SignMessage {
	agent: { name: string };
	channel: string;
	threadTs: string;
	messageTs: string;
	/** Woken by another agent's message in the thread: no sign, it may stay silent. */
	quiet?: boolean;
}

/** The Slack call. Rejects with the Slack error (err.data.error or err.message). */
export interface SignApi {
	status(agentName: string, channel: string, threadTs: string, text: string): Promise<void>;
}

const threadKey = (m: SignMessage): string => `${m.agent.name}|${m.channel}:${m.threadTs}`;
const errorCode = (err: unknown): string => String((err as any)?.data?.error || (err as any)?.message || err);

export class WorkingSign {
	private readonly statusUp = new Set<string>();  // threads that carry "is thinking…" now
	private readonly complained = new Set<string>();
	private readonly arrivals = new Map<string, number>();  // thread -> person messages received so far

	constructor(private readonly api: SignApi, private readonly opts: {
		heartbeatMs: number;
		/** Wait before clearing the status, so the reply reaches the client first. */
		clearDelayMs: number;
		log?: (line: string) => void;
	}) {}

	/** A message was accepted for this agent: show it at once, before any waiting. */
	received(m: SignMessage): void {
		if (m.quiet) return;
		this.arrivals.set(threadKey(m), (this.arrivals.get(threadKey(m)) || 0) + 1);
		void this.status(m, THINKING);
	}

	/**
	 * Keep the sign up while `run` works on `batch`, and take it down when it ends or throws.
	 * The status belongs to the thread, so messages the run takes in mid-run need nothing more.
	 */
	async during<T>(batch: SignMessage[], run: () => Promise<T>): Promise<T> {
		const first = batch[0];
		const thread = threadKey(first);
		const loud = batch.find((m) => !m.quiet);
		if (loud) void this.status(loud, THINKING);
		// The status is up when this batch raised it or a message received since did (a mention
		// that arrives while a quiet run works): keep it up, and take it down at the end.
		const beat = () => {
			if (this.statusUp.has(thread)) void this.status(first, THINKING);
		};
		const timer = setInterval(beat, this.opts.heartbeatMs);
		try {
			return await run();
		} finally {
			clearInterval(timer);
			const seenAtEnd = this.arrivals.get(thread) || 0;
			if (this.statusUp.has(thread)) {
				await new Promise((r) => setTimeout(r, this.opts.clearDelayMs));
				// A person's message that came in after the run ended waits for the next run (the
				// debounce): clearing now would leave it with no sign. The next run takes the status over.
				if ((this.arrivals.get(thread) || 0) === seenAtEnd) await this.status(first, "");
			}
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
