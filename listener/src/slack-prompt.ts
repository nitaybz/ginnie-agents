import { isSlackThreadTs } from "./run-failures";

// The scheduler has no Slack message to hang a run on, so it queues the run
// under a synthetic key. That key is only for the listener's own per-thread
// queue; it must never be handed to the agent as a thread to reply in, because
// Slack rejects it (invalid_thread_ts) and the agent's first post fails.
export function scheduledThreadKey(scheduleId: string, now: number = Date.now()): string {
	return `scheduled_${scheduleId}_${now}`;
}

export interface SlackPromptArgs {
	channel: string;
	threadTs: string;
	message: string;
	threadContext?: string;
	resumed?: boolean;
}

export function buildSlackPrompt({ channel, threadTs, message, threadContext = "", resumed = false }: SlackPromptArgs): string {
	if (!isSlackThreadTs(threadTs)) {
		return (
			`Scheduled run (channel: ${channel}, no Slack thread):\n\n${message}\n\n` +
			`This run was started by the scheduler, not by a Slack message, so there is no thread to reply in. ` +
			`If you post to Slack, post a new top-level message in channel ${channel} (no thread_ts), ` +
			`unless your instructions for this task name a different place.`
		);
	}
	const header = resumed
		? `Slack reply (channel: ${channel}, thread: ${threadTs}):`
		: `Slack message (channel: ${channel}, thread: ${threadTs}):${threadContext}`;
	return `${header}\n\n${message}\n\nReply in Slack channel ${channel}, thread ${threadTs}.`;
}
