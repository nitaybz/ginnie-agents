// What the entrypoint does after a session error. Pure, so the listener tests
// can exercise it (entrypoint.mjs starts a session on import).
//
// The rule behind every branch: once the run has made a tool call, it may
// have sent a message, written a record or issued a document. Re-sending the
// original request would repeat those actions. So after a tool call the only
// way forward is to resume the same session and ask it to continue, and if
// that session cannot be found the run fails instead of starting over.

// Transient/ambiguous API failures that are worth one or two automatic retries.
// "Could not process image" is nominally a 400, but in practice it's an
// intermittent server-side decode hiccup, so it is treated as retryable.
export const TRANSIENT_ERROR =
	/could not process image|overloaded|rate.?limit|\b429\b|\b5\d\d\b|internal server error|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up/i;
export const MAX_TRANSIENT_RETRIES = 2;

export const CONTINUE_AFTER_ERROR_MESSAGE =
	"Your previous attempt at this task stopped partway because of a temporary API error. Continue from " +
	"where it stopped. Do NOT repeat any action already completed above (messages or posts sent, files or " +
	"records written, payments or documents issued). If you are unsure whether an action went through, " +
	"check its result first instead of doing it again.";

export function isMissingSession(error) {
	return /No conversation found/.test(String(error || ""));
}

/**
 * @param {object} s
 * @param {string} s.error          the thrown error, as text
 * @param {string|undefined} s.sessionArg  session the failed try resumed (undefined: new session)
 * @param {boolean} s.strictResume  the resumed session must exist (a continuation): never start over
 * @param {number} s.toolCalls      tool calls made so far in this container
 * @param {string} s.sessionId      latest known session id of this run ("" if none)
 * @param {number} s.transientRetries retries already used
 * @returns {{action:"fresh"} | {action:"retry"} | {action:"continue", sessionId:string} | {action:"fail", reason:string}}
 */
export function nextStep(s) {
	if (s.sessionArg && isMissingSession(s.error)) {
		if (s.strictResume || s.toolCalls > 0) {
			return { action: "fail", reason: "the session to continue was not found; not starting over, to avoid repeating actions" };
		}
		// Stale thread session, nothing done yet: start a new session with the original request.
		return { action: "fresh" };
	}
	if (TRANSIENT_ERROR.test(String(s.error || "")) && s.transientRetries < MAX_TRANSIENT_RETRIES) {
		if (!s.toolCalls) return { action: "retry" };
		if (s.sessionId) return { action: "continue", sessionId: s.sessionId };
		return { action: "fail", reason: "transient error after tool calls and no session to continue; not repeating the request" };
	}
	return { action: "fail", reason: "" };
}
