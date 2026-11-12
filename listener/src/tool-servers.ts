/**
 * Tool servers per agent (config.json "tool_servers").
 *
 * Lets an agent use tools served by an MCP server the operator runs on the
 * host (or at an https address). Each entry:
 *
 *   "tool_servers": { "<name>": { "url": "http://172.17.0.1:<port>/mcp", "token_key": "<key in credentials.json>" } }
 *
 * Rules (an entry that breaks one is logged and skipped; the agent still runs):
 *  - <name> matches [a-z][a-z0-9_]{1,30}. The agent sees the tools as
 *    mcp__<name>__<tool>.
 *  - url is http://172.17.0.1:<port>/... (the docker host, as seen from the
 *    container) or https://... (any host).
 *  - token_key names a non-empty string in the agent's credentials.json. It
 *    is sent as "Authorization: Bearer <token>".
 *
 * The token never goes into docker args, env or any command line: the
 * runner passes only {url, token_key} (AGENT_TOOL_SERVERS), and inside the
 * container a headersHelper (docker/tool-server-headers.mjs) reads it from
 * the read-only credentials.json mount when the Claude program connects.
 * token_key is limited to [A-Za-z0-9_.-] because it is part of that helper
 * command. The url handed on is the normalized one that was validated.
 * Read-only agents may use tool servers too: the server decides what it offers.
 */

export const TOOL_SERVER_NAME = /^[a-z][a-z0-9_]{1,30}$/;
export const DOCKER_HOST_IP = "172.17.0.1";
export const TOKEN_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

export interface ToolServer {
	url: string;
	headers: Record<string, string>;
}

/** What the container is told: where the server is and which credentials key holds its token. */
export interface ToolServerRef {
	url: string;
	token_key: string;
}

/** The normalized url when allowed, else { problem }. */
function checkUrl(raw: unknown): { url: string } | { problem: string } {
	if (typeof raw !== "string" || !raw) return { problem: "is missing" };
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return { problem: "is not a valid URL" };
	}
	if (u.protocol === "https:") return { url: u.href };
	if (u.protocol === "http:" && u.hostname === DOCKER_HOST_IP && u.port !== "") return { url: u.href };
	return { problem: `must be http://${DOCKER_HOST_IP}:<port>/... or https://...` };
}

export function parseToolServers(
	manifest: { tool_servers?: unknown },
	credentials: Record<string, unknown> | null,
): { servers: Record<string, ToolServer>; errors: string[] } {
	const servers: Record<string, ToolServer> = {};
	const errors: string[] = [];
	const raw = manifest.tool_servers;
	if (raw === undefined) return { servers, errors };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		errors.push("tool_servers ignored: must be an object of name to {url, token_key}");
		return { servers, errors };
	}
	for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
		if (!TOOL_SERVER_NAME.test(name)) {
			errors.push(`tool_servers.${JSON.stringify(name)} skipped: name must match [a-z][a-z0-9_]{1,30}`);
			continue;
		}
		const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
		const url = checkUrl(e.url);
		if ("problem" in url) {
			errors.push(`tool_servers.${name}.url ${url.problem}; server skipped`);
			continue;
		}
		const key = e.token_key;
		if (typeof key !== "string" || !key) {
			errors.push(`tool_servers.${name}.token_key is missing; server skipped`);
			continue;
		}
		if (!TOKEN_KEY.test(key)) {
			errors.push(`tool_servers.${name}.token_key may only use letters, digits, "_", "." and "-"; server skipped`);
			continue;
		}
		const token = credentials ? credentials[key] : undefined;
		if (typeof token !== "string" || !token.trim()) {
			errors.push(`tool_servers.${name}.token_key "${key}" not found in credentials.json; server skipped`);
			continue;
		}
		servers[name] = { url: url.url, headers: { Authorization: `Bearer ${token.trim()}` } };
	}
	return { servers, errors };
}

/** The {url, token_key} of each valid server, for the container env. */
export function toolServerRefs(
	manifest: { tool_servers?: unknown },
	servers: Record<string, ToolServer>,
): Record<string, ToolServerRef> {
	const raw = (manifest.tool_servers || {}) as Record<string, { token_key: string }>;
	const refs: Record<string, ToolServerRef> = {};
	for (const [name, s] of Object.entries(servers)) refs[name] = { url: s.url, token_key: raw[name].token_key };
	return refs;
}

/** ["-e", "AGENT_TOOL_SERVERS=<json>"] when the agent has servers, else nothing. */
export function toolServersDockerEnv(refs: Record<string, ToolServerRef> | undefined): string[] {
	if (!refs || !Object.keys(refs).length) return [];
	return ["-e", `AGENT_TOOL_SERVERS=${JSON.stringify(refs)}`];
}
