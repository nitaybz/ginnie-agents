/**
 * Bottom line: the channel where routines post their short plain-words summary.
 *
 * Configured once per install with BOTTOM_LINE_CHANNEL in the listener .env
 * (a Slack channel id or #name). The runner forwards it into every agent
 * container; the entrypoint then loads framework/skills/bottom-line with the
 * channel filled in. Unset or blank means the skill stays off.
 */
export function bottomLineDockerEnv(env: NodeJS.ProcessEnv): string[] {
	const channel = (env.BOTTOM_LINE_CHANNEL || "").trim();
	return channel ? ["-e", `BOTTOM_LINE_CHANNEL=${channel}`] : [];
}
