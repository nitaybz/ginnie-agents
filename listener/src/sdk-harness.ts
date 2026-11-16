/**
 * Test helper: run the REAL Claude Agent SDK (the version pinned in docker/package.json, with its
 * real Claude program) and the REAL docker/midrun.mjs against a fake model API on localhost. The
 * events the feed sees are then the program's own, in its own order, not hand-made ones.
 *
 * The session loop below is the same few lines as runSession() in docker/entrypoint.mjs.
 * Needs the SDK installed in docker/ (`npm ci` there; `npm test` does it when missing).
 */
import http from "http";
import { mkdtempSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

const repoRoot = path.join(__dirname, "..", "..");
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
export const SDK_DIR = path.join(repoRoot, "docker", "node_modules", "@anthropic-ai", "claude-agent-sdk");

export const containerMidrun = () => esmImport(pathToFileURL(path.join(repoRoot, "docker", "midrun.mjs")).href);

/** The SDK the image will get: fails loudly when docker/ is not installed or is another version. */
export async function pinnedSdk(): Promise<any> {
	const pin = JSON.parse(readFileSync(path.join(repoRoot, "docker", "package.json"), "utf8")).dependencies["@anthropic-ai/claude-agent-sdk"];
	let installed = "";
	try { installed = JSON.parse(readFileSync(path.join(SDK_DIR, "package.json"), "utf8")).version; } catch { /* not installed */ }
	if (installed !== pin) throw new Error(`docker/ has SDK "${installed || "none"}", the pin is "${pin}": run \`npm ci\` in docker/`);
	return esmImport(pathToFileURL(path.join(SDK_DIR, "sdk.mjs")).href);
}

/** What the fake model answers to one request of the main conversation. */
export type Reply = ({ text: string } | { bash: string }) & { /** Answer only after this long (a model that takes its time). */ delayMs?: number };
export interface ModelRequest {
	/** Everything the model was told so far (user text, tool results, mid-turn messages), joined. */
	userText: string;
	/** Tool results in the conversation so far. */
	toolResults: number;
	/** 1 for the first request of the main conversation, 2 for the next, ... */
	call: number;
}

/** A local stand-in for the model API: answers the main conversation from `script`, anything else with "ok". */
export async function fakeModelApi(script: (req: ModelRequest) => Reply): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
	let calls = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => { body += d; });
		req.on("end", () => {
			let parsed: any = {};
			try { parsed = JSON.parse(body || "{}"); } catch { /* not json */ }
			if (!req.url?.includes("/v1/messages") || req.url.includes("count_tokens")) {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ input_tokens: 1 }));
			}
			const main = Array.isArray(parsed.tools) && parsed.tools.some((t: any) => t.name === "Bash");
			let reply: Reply = { text: "ok" };
			if (main) {
				const parts: string[] = [];
				let toolResults = 0;
				for (const m of parsed.messages || []) {
					if (m.role === "assistant") continue; // a mid-turn message arrives as a system-role entry
					for (const b of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || []) {
						if (b.type === "text") parts.push(b.text);
						if (b.type === "tool_result") { toolResults++; parts.push(JSON.stringify(b.content)); }
					}
				}
				reply = script({ userText: parts.join("\n"), toolResults, call: ++calls });
			}
			setTimeout(() => answer(reply, parsed), reply.delayMs || 0);
		});
		const answer = (reply: Reply, parsed: any) => {
			const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const block = "text" in reply
				? { type: "text", text: reply.text }
				: { type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2)}`, name: "Bash", input: { command: reply.bash } };
			const stop = "text" in reply ? "end_turn" : "tool_use";
			const usage = { input_tokens: 10, output_tokens: 5 };
			if (!parsed.stream) {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ id, type: "message", role: "assistant", model: parsed.model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage } });
			if (block.type === "text") {
				send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } });
			} else {
				send("content_block_start", { type: "content_block_start", index: 0, content_block: { ...block, input: {} } });
				send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
			}
			send("content_block_stop", { type: "content_block_stop", index: 0 });
			send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
			send("message_stop", { type: "message_stop" });
			res.end();
		};
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as any).port;
	return {
		url: `http://127.0.0.1:${port}`,
		calls: () => calls,
		close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
	};
}

export interface SessionRun {
	/** Every message the query yielded, in order. */
	events: any[];
	results: any[];
	/** Thrown by the query, if it threw. */
	error?: unknown;
}

/**
 * One session, the way docker/entrypoint.mjs runs it: the feed's stream as the prompt, every
 * yielded message shown to the feed, the feed stopped when the query is over.
 */
export async function runSession(opts: {
	inboxDir: string;
	prompt: string;
	script: (req: ModelRequest) => Reply;
	maxTurns?: number;
	feed?: Record<string, unknown>;
	/** Called with each yielded message (drop a file into the inbox at an exact point). */
	onEvent?: (msg: any, events: any[]) => void;
}): Promise<SessionRun> {
	const { query } = await pinnedSdk();
	const { createFeed } = await containerMidrun();
	const api = await fakeModelApi(opts.script);
	const home = mkdtempSync(path.join(os.tmpdir(), "sdk-harness-"));
	const maxTurns = opts.maxTurns ?? 20;
	const feed = createFeed(opts.inboxDir, opts.prompt, { pollMs: 20, maxTurns, ...opts.feed });
	const run: SessionRun = { events: [], results: [] };
	// Nothing of the machine's own Claude setup, no real account, no real API.
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
	delete env.CLAUDE_CODE_OAUTH_TOKEN;
	delete env.ANTHROPIC_AUTH_TOKEN;
	try {
		for await (const msg of query({
			prompt: feed.input,
			options: {
				systemPrompt: "test",
				allowedTools: ["Bash"],
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				maxTurns,
				cwd: home,
				persistSession: true,
				env,
				extraArgs: { "replay-user-messages": null },
			},
		})) {
			feed.observe(msg);
			run.events.push(msg);
			if (msg.type === "result") run.results.push(msg);
			opts.onEvent?.(msg, run.events);
		}
	} catch (err) {
		run.error = err;
	} finally {
		feed.stop();
		await api.close();
	}
	return run;
}

/** Short labels of a run's events, for reading an ordering in an assertion message. */
export function trace(events: any[]): string[] {
	return events.map((m) => {
		if (m.type === "assistant") return `assistant:${(m.message?.content || []).map((b: any) => b.type === "tool_use" ? `bash(${b.input?.command})` : b.type === "text" ? `"${b.text}"` : b.type).join("+")}`;
		if (m.type === "user") return m.isReplay ? `replay:${typeof m.message?.content === "string" ? m.message.content : "blocks"}` : "tool_result";
		if (m.type === "result") return `result:${m.subtype}`;
		return `${m.type}${m.subtype ? `:${m.subtype}` : ""}`;
	});
}
