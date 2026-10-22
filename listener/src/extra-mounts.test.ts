/**
 * Read-only extra mounts (config.json "extra_mounts"): validation at load
 * time and the docker args built at spawn time.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseExtraMounts, extraMountDockerArgs, hostPathProblem, checkHostPaths, EXTRA_MOUNTS_ROOT, type HostEnv } from "./extra-mounts";

function collect() {
	const lines: string[] = [];
	return { lines, log: (l: string) => lines.push(l) };
}

const good = { host_path: "/srv/data/reports", container_path: "/workspace/mounts/reports", read_only: true };

describe("parseExtraMounts", () => {
	test("absent or empty: no mounts, no log", () => {
		const c = collect();
		assert.deepEqual(parseExtraMounts(undefined, c.log), []);
		assert.deepEqual(parseExtraMounts([], c.log), []);
		assert.equal(c.lines.length, 0);
	});

	test("valid entry is kept; extra keys like _comment are ignored", () => {
		const c = collect();
		const out = parseExtraMounts([{ ...good, _comment: "x" }], c.log);
		assert.deepEqual(out, [{ hostPath: "/srv/data/reports", containerPath: "/workspace/mounts/reports" }]);
		assert.equal(c.lines.length, 0);
	});

	test("not a list: rejected with a log line", () => {
		const c = collect();
		assert.deepEqual(parseExtraMounts({ a: 1 }, c.log), []);
		assert.equal(c.lines.length, 1);
	});

	test("read_only must be exactly true", () => {
		for (const ro of [false, undefined, "true", 1]) {
			const c = collect();
			assert.deepEqual(parseExtraMounts([{ ...good, read_only: ro }], c.log), [], `read_only=${String(ro)}`);
			assert.match(c.lines[0], /read_only/);
		}
	});

	test("host path must be absolute and canonical", () => {
		for (const hp of ["~/.config/x.json", "relative/dir", "/srv/../etc", "/srv/./data", "/srv/data/", "/srv//data", "/", "", 5]) {
			const c = collect();
			assert.deepEqual(parseExtraMounts([{ ...good, host_path: hp }], c.log), [], `host_path=${String(hp)}`);
			assert.equal(c.lines.length, 1);
		}
	});

	test("container path must live under /workspace/mounts/ (never over framework mounts)", () => {
		assert.equal(EXTRA_MOUNTS_ROOT, "/workspace/mounts");
		for (const cp of [
			"/workspace/memory", "/workspace/memory/x", "/workspace/skills", "/workspace/data",
			"/workspace/PROMPT.md", "/workspace/credentials.json", "/workspace/.shared", "/workspace/.framework/skills",
			"/home/node/.claude", "/app", "/workspace", "/workspace/mounts", "/workspace/mounts/",
			"/workspace/mounts/../memory", "workspace/mounts/x", "/workspace/mountsx/y",
		]) {
			const c = collect();
			assert.deepEqual(parseExtraMounts([{ ...good, container_path: cp }], c.log), [], `container_path=${cp}`);
			assert.equal(c.lines.length, 1);
		}
	});

	test("commas are rejected (they would break the --mount spec)", () => {
		const c = collect();
		assert.deepEqual(parseExtraMounts([{ ...good, host_path: "/srv/a,b" }], c.log), []);
		assert.deepEqual(parseExtraMounts([{ ...good, container_path: "/workspace/mounts/a,readonly=false" }], c.log), []);
		assert.equal(c.lines.length, 2);
	});

	test("control characters and double quotes are rejected in both paths (docker --mount CSV injection)", () => {
		for (const bad of ["\n", "\r", "\t", "\"", "\u0000", "\u001b", "\u007f"]) {
			const c = collect();
			assert.deepEqual(parseExtraMounts([{ ...good, container_path: `/workspace/mounts/a${bad}readonly=false` }], c.log), [], `container ${JSON.stringify(bad)}`);
			assert.deepEqual(parseExtraMounts([{ ...good, host_path: `/srv/a${bad}b` }], c.log), [], `host ${JSON.stringify(bad)}`);
			assert.equal(c.lines.length, 2);
			assert.match(c.lines[0], /control characters or quotes/);
		}
	});

	test("the reviewer's newline payload never produces a mount arg", () => {
		const out = parseExtraMounts([{ ...good, container_path: "/workspace/mounts/x\n,target=/workspace/mounts/y" }], () => {});
		assert.deepEqual(out, []);
	});

	test("spaces in paths are fine", () => {
		const out = parseExtraMounts([{ ...good, host_path: "/home/u/My Projects/data" }], () => {});
		assert.equal(out.length, 1);
	});

	test("duplicate or nested container paths: later one rejected", () => {
		const c = collect();
		const out = parseExtraMounts([
			good,
			{ ...good, host_path: "/srv/other" },
			{ ...good, host_path: "/srv/other", container_path: "/workspace/mounts/reports/sub" },
			{ ...good, host_path: "/srv/third", container_path: "/workspace/mounts/third" },
		], c.log);
		assert.deepEqual(out.map((m) => m.containerPath), ["/workspace/mounts/reports", "/workspace/mounts/third"]);
		assert.equal(c.lines.length, 2);
	});

	test("one bad entry does not drop the good ones", () => {
		const out = parseExtraMounts([{ ...good, read_only: false }, good], () => {});
		assert.equal(out.length, 1);
	});
});

// Fake host: realpath from a table; anything not listed is missing (ENOENT).
function fakeHost(real: Record<string, string>): HostEnv {
	return {
		home: "/home/u",
		agentsDir: "/opt/fw/agents",
		frameworkRoot: "/opt/fw",
		realpath: (p: string) => {
			if (p in real) return real[p];
			const e: NodeJS.ErrnoException = new Error("ENOENT");
			e.code = "ENOENT";
			throw e;
		},
	};
}

describe("hostPathProblem", () => {
	const self = (p: string) => fakeHost({ [p]: p });

	test("ordinary data directory and file are fine", () => {
		assert.equal(hostPathProblem("agentA", "/srv/data/reports", self("/srv/data/reports")), null);
		assert.equal(hostPathProblem("agentA", "/home/u/.config/app/credentials.json", self("/home/u/.config/app/credentials.json")), null);
	});

	test("missing host path reports missing", () => {
		assert.equal(hostPathProblem("agentA", "/srv/none", fakeHost({})), "missing");
	});

	test("a symlink (realpath differs) is rejected", () => {
		const r = hostPathProblem("agentA", "/srv/link", fakeHost({ "/srv/link": "/home/u/.ssh" }));
		assert.ok(r && r !== "missing" && /symlink/.test(r), String(r));
	});

	test("sensitive locations are rejected, inside them or containing them", () => {
		for (const p of [
			"/var/run/docker.sock", "/run/docker.sock", "/var/run", "/run/user/1000",
			"/home/u/.ssh", "/home/u/.ssh/id_ed25519", "/home/u/.config/gh", "/home/u/.config/gh/hosts.yml",
			"/opt/fw/.env", "/etc", "/etc/passwd", "/proc/1", "/sys/kernel", "/dev/sda", "/root",
			"/", "/home", "/home/u", "/home/u/.config", "/opt/fw", "/opt/fw/agents",
			"/opt/fw/agents/agentB", "/opt/fw/agents/agentB/credentials.json",
		]) {
			const r = hostPathProblem("agentA", p, self(p));
			assert.ok(r && r !== "missing", `${p} should be rejected, got ${String(r)}`);
		}
	});

	test("the agent's own folder is not 'another agent's folder'", () => {
		assert.equal(hostPathProblem("agentA", "/opt/fw/agents/agentA/exports", self("/opt/fw/agents/agentA/exports")), null);
		// prefix lookalike is still another agent
		assert.notEqual(hostPathProblem("agentA", "/opt/fw/agents/agentAB/x", self("/opt/fw/agents/agentAB/x")), null);
	});
});

describe("checkHostPaths (startup)", () => {
	test("drops unsafe existing paths, keeps safe and missing ones", () => {
		const c = collect();
		const host = fakeHost({ "/srv/ok": "/srv/ok", "/srv/link": "/etc", "/home/u/.ssh": "/home/u/.ssh" });
		const out = checkHostPaths("agentA", [
			{ hostPath: "/srv/ok", containerPath: "/workspace/mounts/ok" },
			{ hostPath: "/srv/link", containerPath: "/workspace/mounts/link" },
			{ hostPath: "/home/u/.ssh", containerPath: "/workspace/mounts/ssh" },
			{ hostPath: "/srv/later", containerPath: "/workspace/mounts/later" },
		], host, c.log);
		assert.deepEqual(out.map((m) => m.hostPath), ["/srv/ok", "/srv/later"]);
		assert.equal(c.lines.length, 2);
	});
});

describe("extraMountDockerArgs", () => {
	const mounts = [
		{ hostPath: "/srv/data/reports", containerPath: "/workspace/mounts/reports" },
		{ hostPath: "/srv/missing", containerPath: "/workspace/mounts/missing" },
	];

	test("existing host path becomes a read-only bind mount; missing one is skipped", () => {
		const c = collect();
		const args = extraMountDockerArgs("agentA", mounts, fakeHost({ "/srv/data/reports": "/srv/data/reports" }), c.log);
		assert.deepEqual(args, [
			"--mount", "type=bind,source=/srv/data/reports,target=/workspace/mounts/reports,readonly",
		]);
		assert.equal(c.lines.length, 1);
		assert.match(c.lines[0], /\/srv\/missing/);
	});

	test("missing host path is logged once per agent and path, not on every run", () => {
		const c = collect();
		extraMountDockerArgs("agentB", mounts, fakeHost({}), c.log);
		extraMountDockerArgs("agentB", mounts, fakeHost({}), c.log);
		assert.equal(c.lines.length, 2); // one per missing path, across two runs
		extraMountDockerArgs("agentC", mounts, fakeHost({}), c.log);
		assert.equal(c.lines.length, 4);
	});

	test("re-checked at spawn: a path swapped for a symlink after startup is skipped", () => {
		const c = collect();
		const args = extraMountDockerArgs("agentE", mounts.slice(0, 1), fakeHost({ "/srv/data/reports": "/home/u/.ssh" }), c.log);
		assert.deepEqual(args, []);
		assert.equal(c.lines.length, 1);
	});

	test("no mounts: no args", () => {
		assert.deepEqual(extraMountDockerArgs("agentD", [], fakeHost({}), () => {}), []);
	});
});
