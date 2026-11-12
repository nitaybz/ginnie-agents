/**
 * Tool servers for this run (config.json "tool_servers", validated by the
 * listener in listener/src/tool-servers.ts).
 *
 * AGENT_TOOL_SERVERS is JSON { "<name>": { "url", "token_key" } }. The token
 * itself is read here from the agent's read-only credentials.json mount, so
 * it never appears in docker args or container env. Returns the SDK's
 * mcpServers option (HTTP transport with a bearer header) and one
 * "mcp__<name>__*" allowed-tool entry per server. Anything wrong skips that
 * server with one log line; this never throws.
 */

const NAME = /^[a-z][a-z0-9_]{1,30}$/;

export function toolServerOptions(envJson, credentials, log) {
	const none = { mcpServers: undefined, allowedTools: [] };
	if (!envJson) return none;
	let refs;
	try {
		refs = JSON.parse(envJson);
	} catch {
		log("AGENT_TOOL_SERVERS is not valid JSON; no tool servers");
		return none;
	}
	if (!refs || typeof refs !== "object" || Array.isArray(refs)) {
		log("AGENT_TOOL_SERVERS is not an object; no tool servers");
		return none;
	}
	const mcpServers = {};
	const allowedTools = [];
	for (const [name, ref] of Object.entries(refs)) {
		if (!NAME.test(name)) {
			log(`tool server ${JSON.stringify(name)} skipped: bad name`);
			continue;
		}
		const token = credentials && ref && typeof ref.token_key === "string" ? credentials[ref.token_key] : undefined;
		if (!ref || typeof ref.url !== "string" || typeof token !== "string" || !token.trim()) {
			log(`tool server ${name} skipped: url or token missing (token_key in credentials.json)`);
			continue;
		}
		mcpServers[name] = { type: "http", url: ref.url, headers: { Authorization: `Bearer ${token.trim()}` } };
		allowedTools.push(`mcp__${name}__*`);
	}
	return { mcpServers: allowedTools.length ? mcpServers : undefined, allowedTools };
}
