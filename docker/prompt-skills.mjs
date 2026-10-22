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
