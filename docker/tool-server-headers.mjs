/**
 * headersHelper for tool servers (see docker/tool-servers.mjs).
 *
 * The Claude program runs this when it connects to a tool server and sends
 * what it prints as HTTP headers. It reads the token from the agent's
 * read-only credentials.json, so the token is never on any command line
 * (the SDK passes mcpServers to the program as a command-line argument).
 *
 *   node tool-server-headers.mjs <token_key> [credentials file]
 *
 * Prints {"Authorization":"Bearer <token>"} and exits 0, or prints a short
 * reason (never the token) to stderr and exits 1.
 */

import { readFileSync } from "fs";

const [tokenKey, file = "/workspace/credentials.json"] = process.argv.slice(2);
let token;
try {
	const creds = JSON.parse(readFileSync(file, "utf-8"));
	token = creds && typeof creds === "object" ? creds[tokenKey] : undefined;
} catch {
	process.stderr.write(`tool server headers: cannot read ${file}\n`);
	process.exit(1);
}
if (typeof token !== "string" || !token.trim()) {
	process.stderr.write(`tool server headers: no token under ${JSON.stringify(tokenKey)}\n`);
	process.exit(1);
}
process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token.trim()}` }));
