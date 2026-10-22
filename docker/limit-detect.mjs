// Pure helpers for recognizing a Claude subscription usage limit. Kept out of
// entrypoint.mjs (which starts a session on import) so the listener tests can
// exercise them.

// The CLI's own terminal message for a subscription limit, e.g.
// "You've hit your limit · resets 4am (Asia/Jerusalem)", possibly wrapped by
// the SDK as "Error: Claude Code returned an error result: <message>".
// Anchored to the start so text quoted from tool output never matches.
const USAGE_LIMIT_TEXT =
	/^\s*(?:Error:\s*)?(?:Claude Code returned an error result:\s*)?(?:You['’]ve hit your (?:usage )?limit|Claude AI usage limit reached)/i;

export function isUsageLimitText(text) {
	return USAGE_LIMIT_TEXT.test(String(text || ""));
}

// SDK `rate_limit_event` with status "rejected" -> { type, resetsAt (ms) }.
export function limitFromEvent(msg) {
	if (!msg || msg.type !== "rate_limit_event") return null;
	const info = msg.rate_limit_info || {};
	if (info.status !== "rejected") return null;
	return {
		type: info.rateLimitType || null,
		resetsAt: typeof info.resetsAt === "number" ? info.resetsAt * 1000 : null,
	};
}

/**
 * Follows one run's SDK messages.
 *  - Counts tool calls, so the listener knows whether a retry on another
 *    account may start over (no tool calls yet) or must resume.
 *  - Remembers a rejected rate_limit_event only while it is the last thing
 *    that happened: any later normal assistant turn or tool result means the
 *    run went on, so a later failure is not a limit.
 */
export function createLimitTracker() {
	let pending = null;
	let toolCalls = 0;
	return {
		observe(msg) {
			if (!msg) return;
			const ev = limitFromEvent(msg);
			if (ev) {
				pending = ev;
				return;
			}
			if (msg.type === "assistant") {
				const content = msg.message?.content;
				if (Array.isArray(content)) {
					for (const block of content) if (block?.type === "tool_use") toolCalls++;
				}
				// The CLI's synthetic "You've hit your limit" turn carries an
				// error; only a normal turn means the run continued.
				if (!msg.error) pending = null;
			} else if (msg.type === "user") {
				pending = null;
			}
		},
		get toolCalls() {
			return toolCalls;
		},
		// Fields for the result JSON when the run's final error is the limit, else null.
		outcome(isError, finalText) {
			if (!isError) return null;
			if (!pending && !isUsageLimitText(finalText)) return null;
			return {
				limit_hit: true,
				limit_type: pending?.type ?? null,
				resets_at: pending?.resetsAt ?? null,
			};
		},
	};
}
