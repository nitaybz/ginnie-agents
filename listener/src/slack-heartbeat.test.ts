import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
	writeSlackHeartbeat,
	ensureSlackHeartbeat,
	clearSlackHeartbeat,
	pruneSlackHeartbeats,
	checkSlackHeartbeats,
	SLACK_HEARTBEAT_STALE_MS,
} from "./slack-heartbeat";

function tmpDir(): string {
	return path.join(mkdtempSync(path.join(tmpdir(), "slackhb-")), "slack-heartbeats");
}

const T0 = Date.parse("2026-09-06T09:00:00Z");
const MIN = 60_000;

test("stale threshold is 15 minutes", () => {
	assert.equal(SLACK_HEARTBEAT_STALE_MS, 15 * MIN);
});

test("fresh heartbeat produces no alert", () => {
	const dir = tmpDir();
	writeSlackHeartbeat(dir, "alpha", T0);
	assert.deepEqual(checkSlackHeartbeats(dir, T0 + 14 * MIN), []);
});

test("heartbeat older than 15 minutes alerts for that agent only", () => {
	const dir = tmpDir();
	writeSlackHeartbeat(dir, "alpha", T0);
	writeSlackHeartbeat(dir, "beta", T0 + 20 * MIN);
	const alerts = checkSlackHeartbeats(dir, T0 + 21 * MIN);
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].key, "slack-socket-dead-alpha");
	assert.equal(alerts[0].severity, "critical");
	assert.match(alerts[0].message, /alpha/);
	assert.match(alerts[0].message, /21m/);
});

test("all heartbeats stale collapses into one listener-level alert", () => {
	const dir = tmpDir();
	writeSlackHeartbeat(dir, "alpha", T0);
	writeSlackHeartbeat(dir, "beta", T0);
	const alerts = checkSlackHeartbeats(dir, T0 + 60 * MIN);
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].key, "slack-sockets-all-dead");
	assert.match(alerts[0].message, /alpha/);
	assert.match(alerts[0].message, /beta/);
});

test("a single agent whose heartbeat is stale still gets its own key", () => {
	const dir = tmpDir();
	writeSlackHeartbeat(dir, "alpha", T0);
	const alerts = checkSlackHeartbeats(dir, T0 + 60 * MIN);
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].key, "slack-socket-dead-alpha");
});

test("ensureSlackHeartbeat seeds a missing file but never refreshes an existing one", () => {
	const dir = tmpDir();
	ensureSlackHeartbeat(dir, "alpha", T0);
	// Never connected: goes stale 15 minutes after boot.
	assert.equal(checkSlackHeartbeats(dir, T0 + 16 * MIN).length, 1);
	// A restart must not hide an agent that was already dead.
	ensureSlackHeartbeat(dir, "alpha", T0 + 16 * MIN);
	assert.equal(checkSlackHeartbeats(dir, T0 + 17 * MIN).length, 1);
});

test("clearSlackHeartbeat removes the agent from monitoring", () => {
	const dir = tmpDir();
	writeSlackHeartbeat(dir, "alpha", T0);
	clearSlackHeartbeat(dir, "alpha");
	assert.equal(existsSync(path.join(dir, "alpha.json")), false);
	assert.deepEqual(checkSlackHeartbeats(dir, T0 + 60 * MIN), []);
	clearSlackHeartbeat(dir, "alpha"); // idempotent
});

test("missing dir, corrupt files and odd names produce no alerts", () => {
	assert.deepEqual(checkSlackHeartbeats(path.join(tmpdir(), "no-such-slackhb-dir"), T0), []);
	const dir = tmpDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "alpha.json"), "{not json");
	writeFileSync(path.join(dir, "notes.txt"), "x");
	assert.deepEqual(checkSlackHeartbeats(dir, T0 + 60 * MIN), []);
});

test("pruneSlackHeartbeats drops files of agents no longer discovered", () => {
	const dir = tmpDir();
	writeSlackHeartbeat(dir, "alpha", T0);
	writeSlackHeartbeat(dir, "retired", T0);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "notes.txt"), "x");
	pruneSlackHeartbeats(dir, ["alpha"]);
	assert.equal(existsSync(path.join(dir, "alpha.json")), true);
	assert.equal(existsSync(path.join(dir, "retired.json")), false);
	assert.equal(existsSync(path.join(dir, "notes.txt")), true);
	// The retired agent no longer produces a stale alert.
	const alerts = checkSlackHeartbeats(dir, T0 + 60 * 60_000);
	assert.deepEqual(alerts.map((a) => a.key), ["slack-socket-dead-alpha"]);
	pruneSlackHeartbeats(path.join(tmpdir(), "no-such-slackhb-dir"), []); // missing dir is fine
});
