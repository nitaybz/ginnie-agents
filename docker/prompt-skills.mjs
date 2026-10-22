// Pure helpers for system-prompt assembly. Kept out of entrypoint.mjs (which
// starts a session on import) so the listener tests can exercise them.

// Bottom-line skill: included only when a channel is configured. Returns the
// skill text with the channel filled in, or null when it must stay out.
export function bottomLineSkill(template, channel) {
	const ch = (channel || "").trim();
	if (!ch || !template) return null;
	return template.replaceAll("{{BOTTOM_LINE_CHANNEL}}", ch);
}
