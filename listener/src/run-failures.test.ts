import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
	recordRunOutcome,
	checkRunFailures,
	pickErrorLine,
	isSlackThreadTs,
	FAILURE_ALERT_THRESHOLD,
} from "./run-failures";

function tmpFile(): string {
	return path.join(mkdtempSync(path.join(tmpdir(), "runfail-")), "run-failures.json");
}

const T0 = Date.parse("2026-09-06T09:00:00Z");

test("consecutive failures accumulate with first-failure time and last error", () => {
	const file = tmpFile();
	recordRunOutcome(file, "omer", true, "boom 1", T0);
	recordRunOutcome(file, "omer", true, "boom 2", T0 + 60_000);
	const data = JSON.parse(readFileSync(file, "utf-8"));
	assert.equal(data.omer.count, 2);
	assert.equal(data.omer.since, new Date(T0).toISOString());
	assert.equal(data.omer.lastError, "boom 2");
});

test("a successful run clears the agent's streak", () => {
	const file = tmpFile();
	recordRunOutcome(file, "omer", true, "boom", T0);
	recordRunOutcome(file, "nass", true, "boom", T0);
	recordRunOutcome(file, "omer", false, "", T0 + 1);
	const data = JSON.parse(readFileSync(file, "utf-8"));
	assert.equal(data.omer, undefined);
	assert.equal(data.nass.count, 1);
});

test("no alert below the threshold", () => {
	const file = tmpFile();
	for (let i = 0; i < FAILURE_ALERT_THRESHOLD - 1; i++) recordRunOutcome(file, "omer", true, "boom", T0);
	assert.deepEqual(checkRunFailures(file, T0), []);
});

test("alert at the threshold names the agent, the error, and how long", () => {
	const file = tmpFile();
	for (let i = 0; i < FAILURE_ALERT_THRESHOLD; i++) {
		recordRunOutcome(file, "omer", true, "Unable to find image 'ginnie-agent:latest' locally", T0);
	}
	const [alert, ...rest] = checkRunFailures(file, T0 + 3 * 3600_000);
	assert.equal(rest.length, 0);
	assert.equal(alert.key, "run-failures-omer");
	assert.equal(alert.severity, "critical");
	assert.match(alert.message, /omer/);
	assert.match(alert.message, /Unable to find image/);
	assert.match(alert.message, /3h/);
});

test("missing or corrupt file produces no alerts", () => {
	assert.deepEqual(checkRunFailures(path.join(tmpdir(), "does-not-exist-runfail.json"), T0), []);
});

test("pickErrorLine prefers the result, else the last stderr error line", () => {
	assert.equal(pickErrorLine("API rejected", "whatever"), "API rejected");
	const stderr = [
		"Unable to find image 'ginnie-agent:latest' locally",
		"docker: Error response from daemon: pull access denied for ginnie-agent",
		"",
		"Run 'docker run --help' for more information",
	].join("\n");
	assert.equal(pickErrorLine("", stderr), "docker: Error response from daemon: pull access denied for ginnie-agent");
	assert.equal(pickErrorLine("", "just a line\n"), "just a line");
	assert.equal(pickErrorLine("", ""), "(no error output)");
});

test("isSlackThreadTs rejects the scheduler's synthetic thread ids", () => {
	assert.equal(isSlackThreadTs("1789318800.027000"), true);
	assert.equal(isSlackThreadTs("scheduled_fleet-scan-weekday_1789318800027"), false);
});
