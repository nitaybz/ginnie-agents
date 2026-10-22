/**
 * Read-only extra mounts (config.json "extra_mounts"): validation at load
 * time and the docker args built at spawn time.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseExtraMounts, extraMountDockerArgs, EXTRA_MOUNTS_ROOT } from "./extra-mounts";

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

describe("extraMountDockerArgs", () => {
	const mounts = [
		{ hostPath: "/srv/data/reports", containerPath: "/workspace/mounts/reports" },
		{ hostPath: "/srv/missing", containerPath: "/workspace/mounts/missing" },
	];

	test("existing host path becomes a read-only bind mount; missing one is skipped", () => {
		const c = collect();
		const args = extraMountDockerArgs("agentA", mounts, (p) => p === "/srv/data/reports", c.log);
		assert.deepEqual(args, [
			"--mount", "type=bind,source=/srv/data/reports,target=/workspace/mounts/reports,readonly",
		]);
		assert.equal(c.lines.length, 1);
		assert.match(c.lines[0], /\/srv\/missing/);
	});

	test("missing host path is logged once per agent and path, not on every run", () => {
		const c = collect();
		extraMountDockerArgs("agentB", mounts, () => false, c.log);
		extraMountDockerArgs("agentB", mounts, () => false, c.log);
		assert.equal(c.lines.length, 2); // one per missing path, across two runs
		extraMountDockerArgs("agentC", mounts, () => false, c.log);
		assert.equal(c.lines.length, 4);
	});

	test("no mounts: no args", () => {
		assert.deepEqual(extraMountDockerArgs("agentD", [], () => true, () => {}), []);
	});
});
