/**
 * Tool servers for this run (config.json "tool_servers", validated by the
 * listener in listener/src/tool-servers.ts).
 *
 * AGENT_TOOL_SERVERS is JSON { "<name>": { "url", "token_key" } }. Returns
 * the SDK's mcpServers option (HTTP transport) and one "mcp__<name>__*"
 * allowed-tool entry per server.
 *
 * The token is never put in the options: the SDK hands mcpServers to the
 * Claude program as a command-line argument (--mcp-config), which anyone
 * on the host can read in the process list. Instead each server gets a
 * headersHelper command (docker/tool-server-headers.mjs) that the program
 * runs when it connects; it reads the token from the agent's read-only
 * credentials.json and prints the Authorization header. The command holds
 * only file paths and the token's key name.
 *
 * A server is skipped with one log line when its entry is malformed or its
 * token is not in credentials.json. This never throws.
 */

import { fileURLToPath } from "url";

const NAME = /^[a-z][a-z0-9_]{1,30}$/;
// Key names go into a shell command, so only plain characters.
export const TOKEN_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

const DEFAULT_HELPER = {
	node: process.execPath,
	script: fileURLToPath(new URL("./tool-server-headers.mjs", import.meta.url)),
	credentialsFile: "/workspace/credentials.json",
};

function shellQuote(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function toolServerOptions(envJson, credentials, log, helper = DEFAULT_HELPER) {
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
		const key = ref && typeof ref.token_key === "string" && TOKEN_KEY.test(ref.token_key) ? ref.token_key : null;
		const token = credentials && typeof credentials === "object" && key ? credentials[key] : undefined;
		if (!ref || typeof ref.url !== "string" || typeof token !== "string" || !token.trim()) {
			log(`tool server ${name} skipped: url or token missing (token_key in credentials.json)`);
			continue;
		}
		mcpServers[name] = {
			type: "http",
			url: ref.url,
			headersHelper: [helper.node, helper.script, key, helper.credentialsFile].map(shellQuote).join(" "),
		};
		allowedTools.push(`mcp__${name}__*`);
	}
	return { mcpServers: allowedTools.length ? mcpServers : undefined, allowedTools };
}
