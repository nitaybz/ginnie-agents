/**
 * Slack socket heartbeats.
 *
 * Each agent has its own Socket Mode connection. If one dies and never comes
 * back, that agent silently stops hearing Slack: no error, no failed run,
 * nothing for the run-failure check to count.
 *
 * The listener refreshes data/slack-heartbeats/<agent>.json every minute
 * while that agent's socket is connected. The watcher alerts when a file is
 * older than SLACK_HEARTBEAT_STALE_MS. When every file is stale the listener
 * itself is the likely cause, so one alert is posted instead of one per agent.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import type { CheckResult } from "./watcher-checks";

export const SLACK_HEARTBEAT_STALE_MS = 15 * 60_000;
export const SLACK_HEARTBEAT_INTERVAL_MS = 60_000;

export const SLACK_HEARTBEAT_DIR = path.join(__dirname, "..", "..", "data", "slack-heartbeats");

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function fileFor(dir: string, agentName: string): string | null {
	if (!SAFE_NAME.test(agentName) || agentName.startsWith(".")) return null;
	return path.join(dir, `${agentName}.json`);
}

export function writeSlackHeartbeat(dir: string, agentName: string, now: number = Date.now()): void {
	const file = fileFor(dir, agentName);
	if (!file) return;
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString() }) + "\n");
	} catch (err) {
		console.error(`[heartbeat] failed to write ${file}:`, err);
	}
}

// Called at boot for every agent the listener tries to connect. Seeding a
// missing file gives a fresh agent a 15 minute grace period and makes an
// agent that never connects alert. An existing file is left alone, so a
// restart cannot hide an agent that was already dead.
export function ensureSlackHeartbeat(dir: string, agentName: string, now: number = Date.now()): void {
	const file = fileFor(dir, agentName);
	if (!file || existsSync(file)) return;
	writeSlackHeartbeat(dir, agentName, now);
}

// Called at boot for agents without Slack tokens: they have no socket to watch.
export function clearSlackHeartbeat(dir: string, agentName: string): void {
	const file = fileFor(dir, agentName);
	if (!file) return;
	try {
		rmSync(file, { force: true });
	} catch { /* ignore */ }
}

function formatAge(ms: number): string {
	const mins = Math.floor(ms / 60_000);
	if (mins >= 120) return `${Math.floor(mins / 60)}h`;
	return `${mins}m`;
}

export function checkSlackHeartbeats(
	dir: string = SLACK_HEARTBEAT_DIR,
	now: number = Date.now(),
): CheckResult[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const fresh: string[] = [];
	const stale: Array<{ agent: string; age: number }> = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".json")) continue;
		const agent = entry.slice(0, -".json".length);
		if (!fileFor(dir, agent)) continue;
		let at = NaN;
		try {
			at = Date.parse(JSON.parse(readFileSync(path.join(dir, entry), "utf-8")).at);
		} catch {
			continue;
		}
		if (!Number.isFinite(at)) continue;
		const age = now - at;
		if (age > SLACK_HEARTBEAT_STALE_MS) stale.push({ agent, age });
		else fresh.push(agent);
	}
	if (stale.length === 0) return [];

	const actions = [
		{ type: "view_logs" as const, label: "View logs" },
		{ type: "restart_listener" as const, label: "Restart listener", style: "primary" as const },
		{ type: "ack_24h" as const, label: "Ack 24h" },
	];

	if (fresh.length === 0 && stale.length > 1) {
		const list = stale.map((s) => `• ${s.agent} (${formatAge(s.age)})`).join("\n");
		return [{
			key: "slack-sockets-all-dead",
			severity: "critical",
			message:
				`🔌 *No agent is connected to Slack.* Every Slack connection has been silent for over ` +
				`${SLACK_HEARTBEAT_STALE_MS / 60_000} minutes, so the listener is likely down or stuck:\n` +
				list + "\n\nCheck `pm2 logs ginnie-agents-listener`.",
			actions,
		}];
	}

	return stale.map((s) => ({
		key: `slack-socket-dead-${s.agent}`,
		severity: "critical" as const,
		message:
			`🔌 *${s.agent} is not connected to Slack* (last heartbeat ${formatAge(s.age)} ago). ` +
			`It cannot hear messages until the connection is back. Check its Slack app token and ` +
			"`pm2 logs ginnie-agents-listener`, then restart the listener.",
		actions,
	}));
}
