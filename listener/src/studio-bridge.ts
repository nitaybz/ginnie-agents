/**
 * Studio bridge — a loopback HTTP endpoint that lets Ginnie Studio list this
 * installation's agents and run a turn for one of them.
 *
 * Why this exists at all: spawning a container is the framework's job, not
 * Studio's. Everything else Studio needs is a file on disk; this is the one
 * thing that is an action.
 *
 * Security posture:
 *  - binds 127.0.0.1 only, never a routable interface
 *  - every request must carry `x-studio-key` matching <repo>/data/studio-bridge/key
 *  - the key is read per request, so installing it needs no listener restart
 *  - a missing or implausibly short key file disables the bridge (503), it
 *    does not open it
 */

import http from "http";
import { readFileSync } from "fs";
import path from "path";
import { timingSafeEqual } from "crypto";
import { agents, runAgent, resumeAgent, type AgentConfig, type AgentRunResult } from "./runner";
import { buildRoster } from "./studio-roster";

/** Default port. Override with STUDIO_BRIDGE_PORT. */
export const DEFAULT_STUDIO_BRIDGE_PORT = 4870;

/** Shortest string accepted as a key. Studio writes 64 hex characters. */
const MIN_KEY_LENGTH = 32;

/** Refuse request bodies above this size rather than buffering them. */
const MAX_BODY_BYTES = 256 * 1024;

const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const DEFAULT_KEY_FILE = path.join(REPO_ROOT, "data", "studio-bridge", "key");

export interface StudioBridgeOptions {
	port?: number;
	keyFile?: string;
	listAgents?: () => AgentConfig[];
	run?: (agent: AgentConfig, message: string) => Promise<AgentRunResult>;
	resume?: (agent: AgentConfig, sessionId: string, message: string) => Promise<AgentRunResult>;
}

/** Reads the installed key, or null when there is not a usable one. */
export function readBridgeKey(keyFile: string): string | null {
	let raw: string;
	try {
		raw = readFileSync(keyFile, "utf8");
	} catch {
		return null;
	}
	const key = raw.trim();
	if (key.length < MIN_KEY_LENGTH) return null;
	return key;
}

function keysMatch(expected: string, provided: string): boolean {
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(provided, "utf8");
	// timingSafeEqual throws on length mismatch, so check length first. The
	// length of a key is not a secret worth protecting.
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
	return new Promise((resolve) => {
		let size = 0;
		const chunks: Buffer[] = [];
		let aborted = false;
		req.on("data", (chunk: Buffer) => {
			if (aborted) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				aborted = true;
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", () => {
			if (!aborted) {
				aborted = true;
				resolve(null);
			}
		});
	});
}

export function startStudioBridge(options: StudioBridgeOptions = {}): http.Server {
	const port = options.port ?? Number(process.env.STUDIO_BRIDGE_PORT || DEFAULT_STUDIO_BRIDGE_PORT);
	const keyFile = options.keyFile ?? DEFAULT_KEY_FILE;
	const listAgents = options.listAgents ?? (() => agents);
	const run = options.run ?? runAgent;
	const resume = options.resume ?? resumeAgent;

	const server = http.createServer((req, res) => {
		void handle(req, res);
	});

	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const key = readBridgeKey(keyFile);
		const provided = String(req.headers["x-studio-key"] || "");

		if (!key) {
			sendJson(res, 503, { error: "no_key" });
			return;
		}
		if (!keysMatch(key, provided)) {
			sendJson(res, 401, { error: "unauthorized" });
			return;
		}

		const url = (req.url || "").split("?")[0];

		if (req.method === "GET" && url === "/studio/roster") {
			sendJson(res, 200, { agents: buildRoster(listAgents()) });
			return;
		}

		if (req.method === "POST" && url === "/studio/run") {
			const raw = await readBody(req);
			if (raw === null) {
				sendJson(res, 413, { error: "too_large" });
				return;
			}

			let parsed: { agent?: unknown; message?: unknown; sessionId?: unknown };
			try {
				parsed = JSON.parse(raw);
			} catch {
				sendJson(res, 400, { error: "bad_request" });
				return;
			}

			const agentName = typeof parsed.agent === "string" ? parsed.agent : "";
			const message = typeof parsed.message === "string" ? parsed.message : "";
			const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
			if (!agentName || !message) {
				sendJson(res, 400, { error: "bad_request" });
				return;
			}

			const agent = listAgents().find((a) => a.name === agentName);
			if (!agent) {
				sendJson(res, 404, { error: "unknown_agent" });
				return;
			}

			try {
				const result = sessionId
					? await resume(agent, sessionId, message)
					: await run(agent, message);
				sendJson(res, 200, {
					sessionId: result.sessionId,
					isError: result.isError,
					result: result.result,
				});
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				console.error(`[studio-bridge] run failed for ${agentName}:`, detail);
				sendJson(res, 500, { error: "run_failed", detail });
			}
			return;
		}

		sendJson(res, 404, { error: "not_found" });
	}

	// A container run can take many minutes. Node would otherwise cut the
	// request off at its 5-minute default and Studio would see a socket hang up
	// with no explanation.
	server.requestTimeout = 0;
	server.headersTimeout = 60_000;
	server.keepAliveTimeout = 5_000;

	server.listen(port, "127.0.0.1");
	return server;
}
