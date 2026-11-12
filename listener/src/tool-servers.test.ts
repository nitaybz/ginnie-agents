/**
 * Tool servers per agent (config.json "tool_servers"): validation on the
 * host, the env the runner hands the container, and the entrypoint helper
 * that turns it into the SDK's mcpServers option.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { parseToolServers, toolServerRefs, toolServersDockerEnv } from "./tool-servers";

const repoRoot = path.join(__dirname, "..", "..");
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
const entrypointHelper = () => esmImport(require("node:url").pathToFileURL(path.join(repoRoot, "docker", "tool-servers.mjs")).href);

const creds = { sasha_tools_token: "tok-test-123", slack_bot_token: "xoxb-x" };
const good = { url: "http://172.17.0.1:8765/mcp", token_key: "sasha_tools_token" };

describe("parseToolServers", () => {
	test("no key: no servers, no errors", () => {
		assert.deepEqual(parseToolServers({}, creds), { servers: {}, errors: [] });
		assert.deepEqual(parseToolServers({}, null), { servers: {}, errors: [] });
	});

	test("valid entry resolves the bearer header from credentials", () => {
		const r = parseToolServers({ tool_servers: { sasha_tools: good } }, creds);
		assert.deepEqual(r.errors, []);
		assert.deepEqual(r.servers, {
			sasha_tools: { url: "http://172.17.0.1:8765/mcp", headers: { Authorization: "Bearer tok-test-123" } },
		});
	});

	test("https url to any host is allowed", () => {
		const r = parseToolServers({ tool_servers: { remote: { ...good, url: "https://tools.example.com/mcp" } } }, creds);
		assert.deepEqual(r.errors, []);
		assert.deepEqual(Object.keys(r.servers), ["remote"]);
	});

	test("bad name: error naming the field, no server", () => {
		for (const name of ["Sasha", "1abc", "a", "has-dash", "has space", "a".repeat(32), "__proto__"]) {
			const r = parseToolServers({ tool_servers: { [name]: good } }, creds);
			assert.deepEqual(r.servers, {}, `name=${name}`);
			assert.equal(r.errors.length, 1, `name=${name}`);
			assert.match(r.errors[0], /tool_servers\..*name/, `name=${name}`);
		}
	});

	test("http url to another host (or without a port): error naming url, no server", () => {
		for (const url of [
			"http://example.com:8765/mcp", "http://127.0.0.1:8765/mcp", "http://172.17.0.10:8765/mcp",
			"http://172.17.0.1/mcp", "ftp://172.17.0.1:21/x", "not a url", "", 5,
		]) {
			const r = parseToolServers({ tool_servers: { sasha_tools: { ...good, url } } }, creds);
			assert.deepEqual(r.servers, {}, `url=${String(url)}`);
			assert.equal(r.errors.length, 1, `url=${String(url)}`);
			assert.match(r.errors[0], /tool_servers\.sasha_tools\.url/, `url=${String(url)}`);
		}
	});

	test("missing token_key, or a key absent from credentials: error naming token_key, no server", () => {
		const cases: Array<[unknown, Record<string, unknown> | null]> = [
			[undefined, creds],
			["", creds],
			["no_such_key", creds],
			["sasha_tools_token", null],
			["sasha_tools_token", { sasha_tools_token: "" }],
			["sasha_tools_token", { sasha_tools_token: 42 }],
		];
		for (const [token_key, c] of cases) {
			const r = parseToolServers({ tool_servers: { sasha_tools: { url: good.url, token_key } } }, c);
			assert.deepEqual(r.servers, {}, `token_key=${String(token_key)}`);
			assert.equal(r.errors.length, 1, `token_key=${String(token_key)}`);
			assert.match(r.errors[0], /tool_servers\.sasha_tools\.token_key/);
		}
	});

	test("errors never contain the token value", () => {
		const r = parseToolServers({ tool_servers: { sasha_tools: { ...good, url: "http://evil.example:1/x" } } }, creds);
		assert.ok(!r.errors.join("\n").includes(creds.sasha_tools_token));
	});

	test("one bad entry does not drop the good one", () => {
		const r = parseToolServers({ tool_servers: { sasha_tools: good, bad: { url: good.url } } }, creds);
		assert.deepEqual(Object.keys(r.servers), ["sasha_tools"]);
		assert.equal(r.errors.length, 1);
	});

	test("tool_servers that is not an object: one error, no servers", () => {
		for (const v of [[], "x", 3, null]) {
			const r = parseToolServers({ tool_servers: v }, creds);
			assert.deepEqual(r.servers, {});
			assert.equal(r.errors.length, 1);
			assert.match(r.errors[0], /tool_servers/);
		}
	});
});

describe("container env (token never in docker args)", () => {
	test("refs keep url and token_key only, for valid servers only", () => {
		const manifest = { tool_servers: { sasha_tools: good, bad: { url: good.url } } };
		const refs = toolServerRefs(manifest, parseToolServers(manifest, creds).servers);
		assert.deepEqual(refs, { sasha_tools: { url: good.url, token_key: "sasha_tools_token" } });
	});

	test("no servers: no env at all", () => {
		assert.deepEqual(toolServersDockerEnv(undefined), []);
		assert.deepEqual(toolServersDockerEnv({}), []);
	});

	test("servers: one AGENT_TOOL_SERVERS env with JSON, no token value", () => {
		const args = toolServersDockerEnv({ sasha_tools: { url: good.url, token_key: "sasha_tools_token" } });
		assert.equal(args.length, 2);
		assert.equal(args[0], "-e");
		assert.ok(args[1].startsWith("AGENT_TOOL_SERVERS="));
		assert.deepEqual(JSON.parse(args[1].slice("AGENT_TOOL_SERVERS=".length)), {
			sasha_tools: { url: good.url, token_key: "sasha_tools_token" },
		});
		assert.ok(!args.join(" ").includes(creds.sasha_tools_token));
	});
});

describe("runner docker args", () => {
	// Recorded from origin/main (b383c40) before this change, with the same
	// agent and environment as below. Tmp dir, repo root and container name
	// are normalized.
	const BASELINE = [
		"run", "--rm", "--name", "<container>", "--memory", "1g", "--cpus", "2", "--pids-limit", "512",
		"--network", "bridge", "--cap-drop=ALL", "--security-opt=no-new-privileges",
		"-e", "TZ=UTC", "-e", "AGENT_MESSAGE=hello", "-e", "AGENT_NAME=base", "-e", "MAX_TURNS=7",
		"-e", "ALLOWED_TOOLS=Read,Grep", "-e", "CLAUDE_CODE_OAUTH_TOKEN", "-e", "AGENT_MODEL=opus",
		"-v", "<agent>/sessions:/home/node/.claude",
		"-v", "<agent>/PROMPT.md:/workspace/PROMPT.md:ro",
		"-v", "<agent>/memory:/workspace/memory",
		"-v", "<repo>/shared:/workspace/.shared:ro",
		"-v", "<repo>/framework/skills:/workspace/.framework/skills:ro",
		"ginnie-agent",
	];

	async function dockerArgsFor(extra: Record<string, unknown>): Promise<string[]> {
		const { spawnAttempt } = require("./runner");
		const dir = mkdtempSync(path.join(tmpdir(), "tool-servers-"));
		writeFileSync(path.join(dir, "PROMPT.md"), "# t");
		const bin = path.join(dir, "bin");
		mkdirSync(bin);
		const out = path.join(dir, "args.txt");
		writeFileSync(path.join(bin, "docker"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${out}"\necho '{}'\n`, { mode: 0o755 });
		const saved = { PATH: process.env.PATH, TZ: process.env.TZ, BL: process.env.BOTTOM_LINE_CHANNEL };
		const log = console.log;
		process.env.PATH = `${bin}:/usr/bin:/bin`;
		process.env.TZ = "UTC";
		delete process.env.BOTTOM_LINE_CHANNEL;
		console.log = () => {};
		try {
			const agent = { name: "base", dir, maxTurns: 7, allowedTools: ["Read", "Grep"], model: "opus", ...extra };
			await spawnAttempt(agent, "hello", undefined, "slack", { label: "A", envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "x" });
		} finally {
			console.log = log;
			process.env.PATH = saved.PATH;
			process.env.TZ = saved.TZ;
			if (saved.BL !== undefined) process.env.BOTTOM_LINE_CHANNEL = saved.BL;
		}
		return readFileSync(out, "utf-8").trim().split("\n").map((a) =>
			a.split(dir).join("<agent>").split(repoRoot).join("<repo>").replace(/^ginnie-base-\d+$/, "<container>"));
	}

	test("agent without tool_servers: args identical to the recorded baseline, no AGENT_TOOL_SERVERS", async () => {
		const args = await dockerArgsFor({});
		assert.deepEqual(args, BASELINE);
		assert.ok(!args.some((a) => a.includes("AGENT_TOOL_SERVERS")));
	});

	test("agent with tool_servers: one extra env, before the image, no token", async () => {
		const args = await dockerArgsFor({ toolServers: { sasha_tools: { url: good.url, token_key: "sasha_tools_token" } } });
		const i = args.findIndex((a) => a.startsWith("AGENT_TOOL_SERVERS="));
		assert.ok(i > 0 && args[i - 1] === "-e");
		assert.equal(args[args.length - 1], "ginnie-agent");
		const without = [...args.slice(0, i - 1), ...args.slice(i + 1)];
		assert.deepEqual(without, BASELINE);
	});
});

describe("entrypoint helper (docker/tool-servers.mjs)", () => {
	const env = JSON.stringify({ sasha_tools: { url: good.url, token_key: "sasha_tools_token" } });

	test("unset env: no servers, no extra tools, no log", async () => {
		const { toolServerOptions } = await entrypointHelper();
		const lines: string[] = [];
		assert.deepEqual(toolServerOptions(undefined, creds, (l: string) => lines.push(l)), { mcpServers: undefined, allowedTools: [] });
		assert.deepEqual(toolServerOptions("", creds, (l: string) => lines.push(l)), { mcpServers: undefined, allowedTools: [] });
		assert.equal(lines.length, 0);
	});

	test("valid env: SDK http server with bearer header, and a wildcard allowed-tool per server", async () => {
		const { toolServerOptions } = await entrypointHelper();
		const r = toolServerOptions(env, creds, () => {});
		assert.deepEqual(r, {
			mcpServers: { sasha_tools: { type: "http", url: good.url, headers: { Authorization: "Bearer tok-test-123" } } },
			allowedTools: ["mcp__sasha_tools__*"],
		});
	});

	test("token missing in the mounted credentials: server skipped with one log line, no token in log", async () => {
		const { toolServerOptions } = await entrypointHelper();
		const lines: string[] = [];
		const r = toolServerOptions(env, { other: "x" }, (l: string) => lines.push(l));
		assert.deepEqual(r, { mcpServers: undefined, allowedTools: [] });
		assert.equal(lines.length, 1);
		assert.match(lines[0], /sasha_tools/);
	});

	test("bad JSON or a bad name in env: skipped with a log line, never throws", async () => {
		const { toolServerOptions } = await entrypointHelper();
		const lines: string[] = [];
		assert.deepEqual(toolServerOptions("{not json", creds, (l: string) => lines.push(l)), { mcpServers: undefined, allowedTools: [] });
		const bad = JSON.stringify({ "Bad-Name": { url: good.url, token_key: "sasha_tools_token" } });
		assert.deepEqual(toolServerOptions(bad, creds, (l: string) => lines.push(l)), { mcpServers: undefined, allowedTools: [] });
		assert.equal(lines.length, 2);
	});

	test("Dockerfile copies the helper into the image", () => {
		assert.ok(readFileSync(path.join(repoRoot, "docker", "Dockerfile"), "utf-8").includes("COPY docker/tool-servers.mjs /app/tool-servers.mjs"));
	});
});
