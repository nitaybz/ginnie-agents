// Pure helpers for system-prompt assembly. Kept out of entrypoint.mjs (which
// starts a session on import) so the listener tests can exercise them.

// Bottom-line skill: included only when a channel is configured. Returns the
// skill text with the channel filled in, or null when it must stay out.
export function bottomLineSkill(template, channel) {
	const ch = (channel || "").trim();
	if (!ch || !template) return null;
	return template.replaceAll("{{BOTTOM_LINE_CHANNEL}}", ch);
}

// WhatsApp skill: included only when the runner forwarded the gateway's agent
// API (WHATSAPP_API_URL) and the account (WHATSAPP_ACCOUNT_ID).
export function whatsappSkill(template, apiUrl, accountId) {
	const url = (apiUrl || "").trim();
	const account = (accountId || "").trim();
	if (!template || !/^https?:\/\/\S+$/.test(url) || !/^[a-z][a-z0-9_-]{0,31}$/.test(account)) return null;
	return template.replaceAll("{{WHATSAPP_API_URL}}", url).replaceAll("{{WHATSAPP_ACCOUNT_ID}}", account);
}

// Skills a run profile puts straight into the system prompt (PRELOAD_SKILLS,
// a comma list of folder names under the agent's skills/), so a short run does
// not spend model round trips reading them. A name that is not a plain folder
// name is skipped before anything is read, so it can never leave skills/.
// Returns the joined text, or null when nothing was named or found.
export function preloadSkills(names, readSkill) {
	const parts = [];
	for (const raw of String(names || "").split(",")) {
		const name = raw.trim();
		if (!/^[a-z0-9-]{1,40}$/.test(name)) continue;
		const text = readSkill(name);
		if (text) parts.push(`# Skill: ${name}\n\n${text.trim()}`);
	}
	return parts.length ? parts.join("\n\n---\n\n") : null;
}
