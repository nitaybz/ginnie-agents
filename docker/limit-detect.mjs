// Pure helpers for recognizing a Claude subscription usage limit. Kept out of
// entrypoint.mjs (which starts a session on import) so the listener tests can
// exercise them.

// The CLI ends a limited run with text like
// "You've hit your limit · resets 4am (Asia/Jerusalem)".
const USAGE_LIMIT_TEXT = /hit your limit|usage limit/i;

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

// Fields to add to the entrypoint's JSON result when the run failed on a
// usage limit, or null. A run that succeeded is never a limit hit, even if a
// rejected event went by (e.g. overage took over).
export function limitOutcome(isError, text, seenLimit) {
	if (!isError) return null;
	if (!seenLimit && !isUsageLimitText(text)) return null;
	return {
		limit_hit: true,
		limit_type: seenLimit?.type ?? null,
		resets_at: seenLimit?.resetsAt ?? null,
	};
}
