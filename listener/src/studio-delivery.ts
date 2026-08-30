/**
 * Delivery-mode instruction — tells an agent, in the composed system prompt,
 * how to deliver its answer when a turn did not come from Slack.
 *
 * Why this exists: every agent's own PROMPT.md carries a strongly worded rule
 * to always reply by posting into the Slack thread it was called from. That
 * rule is correct for Slack turns and wrong for any other origin, since there
 * is no Slack thread to post into. This module produces the override text;
 * the caller is responsible for appending it to the system prompt AFTER
 * PROMPT.md, so it wins the conflict instead of losing it.
 */

/** Turn origins the framework currently knows how to name. Add here as new bridges appear. */
export type DeliveryOrigin = "slack" | "studio" | string;

const STUDIO_INSTRUCTION =
	"You were reached from Ginnie Studio, not from Slack, for this turn. " +
	"There is no Slack thread for this conversation, so do not post your answer to Slack " +
	"and do not call chat.postMessage or any other Slack API for it. " +
	"Put your entire answer directly in your reply to this message instead — that reply is " +
	"what the person on the other end will see.";

/**
 * Returns the extra system-prompt instruction for a given turn origin, or ""
 * when none is needed. Anything other than the recognised "studio" origin —
 * including "slack" and any unknown value — returns "", which keeps the
 * agent's default Slack-posting behaviour untouched.
 */
export function deliveryInstruction(origin: DeliveryOrigin): string {
	if (origin === "studio") return STUDIO_INSTRUCTION;
	return "";
}
