import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { buildRoster, readDisplayName, readRole } from "./studio-roster";
import type { AgentConfig } from "./runner";

function makeAgentDir(name: string, files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "roster-"));
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	for (const [file, body] of Object.entries(files)) {
		writeFileSync(path.join(dir, file), body);
	}
	return dir;
}

function fakeAgent(name: string, dir: string): AgentConfig {
	return {
		name,
		dir,
		slackBotId: "",
		slackBotMsgId: "",
		slackChannel: "",
		slackBotToken: "",
		slackAppToken: "",
		maxTurns: 50,
		allowedTools: [],
		boundaries: "write",
		workHours: { enabled: false, start: "09:00", end: "18:00", days: [], off_hours_behavior: "queue" },
		allowUnverifiedSenders: false,
		buttonTtlHours: 48,
	};
}

test("readDisplayName uses the Slack app name", () => {
	const dir = makeAgentDir("casper", { "slack.json": JSON.stringify({ app_name: "Casper" }) });
	assert.equal(readDisplayName(dir, "casper"), "Casper");
});

test("readDisplayName falls back to a capitalised agent name", () => {
	const dir = makeAgentDir("casper", {});
	assert.equal(readDisplayName(dir, "casper"), "Casper");
});

test("readDisplayName survives malformed slack.json", () => {
	const dir = makeAgentDir("casper", { "slack.json": "{ not json" });
	assert.equal(readDisplayName(dir, "casper"), "Casper");
});

test("readRole prefers the Role bullet", () => {
	const dir = makeAgentDir("casper", {
		"AGENT.md": "# Casper — Business Consultant\n\n## Identity\n- **Name:** Casper\n- **Role:** Finance lead. Knows the pipeline.\n",
	});
	assert.equal(readRole(dir), "Finance lead. Knows the pipeline.");
});

test("readRole falls back to the heading subtitle", () => {
	const dir = makeAgentDir("casper", { "AGENT.md": "# Casper — Business Consultant\n\nsome prose\n" });
	assert.equal(readRole(dir), "Business Consultant");
});

test("readRole returns empty string when there is nothing to read", () => {
	const dir = makeAgentDir("casper", {});
	assert.equal(readRole(dir), "");
});

test("buildRoster reports avatar presence and boundaries", () => {
	const withAvatar = makeAgentDir("casper", {
		"slack.json": JSON.stringify({ app_name: "Casper" }),
		"AGENT.md": "# Casper — Business Consultant\n",
		"avatar.png": "not really a png",
	});
	const withoutAvatar = makeAgentDir("gadi", {});
	const roster = buildRoster([fakeAgent("casper", withAvatar), fakeAgent("gadi", withoutAvatar)]);

	assert.equal(roster.length, 2);
	assert.deepEqual(roster[0], {
		name: "casper",
		displayName: "Casper",
		role: "Business Consultant",
		boundaries: "write",
		hasAvatar: true,
		avatarPath: path.join(withAvatar, "avatar.png"),
	});
	assert.equal(roster[1].hasAvatar, false);
	assert.equal(roster[1].avatarPath, "");
	assert.equal(roster[1].displayName, "Gadi");
});
