/**
 * Consecutive run-failure tracking.
 *
 * The runner records every container outcome to data/run-failures.json:
 * a failure extends the agent's streak, a success clears it. The watcher
 * reads the file and DMs the operator once an agent has failed
 * FAILURE_ALERT_THRESHOLD runs in a row.
 *
 * Without this, a run that fails before the agent can post anything is
 * silent for scheduled routines: they have no real Slack thread to reply
 * in, so the in-thread fallback can't land. (Precedent: the ginnie-agent
 * image was deleted and every run failed for a week with no signal.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { CheckResult } from "./watcher-checks";

export const FAILURE_ALERT_THRESHOLD = 3;

export const RUN_FAILURES_FILE = path.join(__dirname, "..", "..", "data", "run-failures.json");

interface FailureStreak {
	count: number;
	since: string;      // ISO time of the first failure in the streak
	lastError: string;
}

type FailuresFile = Record<string, FailureStreak>;

function load(file: string): FailuresFile {
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return {};
	}
}

export function recordRunOutcome(
	file: string,
	agentName: string,
	isError: boolean,
	errorText: string,
	now: number = Date.now(),
): void {
	const all = load(file);
	if (!isError) {
		if (!all[agentName]) return;
		delete all[agentName];
	} else {
		const prev = all[agentName];
		all[agentName] = {
			count: (prev?.count || 0) + 1,
			since: prev?.since || new Date(now).toISOString(),
			lastError: errorText.slice(0, 500),
		};
	}
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(all, null, 2));
	} catch (err) {
		console.error(`[runner] failed to write ${file}:`, err);
	}
}

// A container can fail before the entrypoint emits its JSON result (e.g.
// docker itself can't start it), so fall back to the most telling stderr line.
export function pickErrorLine(result: string, stderr: string): string {
	if (result.trim()) return result.trim();
	const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
	const errorLines = lines.filter((l) => /error/i.test(l));
	return errorLines[errorLines.length - 1] || lines[lines.length - 1] || "(no error output)";
}

// Real Slack thread ids look like "1789318800.027000". The scheduler uses
// synthetic ids ("scheduled_<id>_<ms>") that Slack rejects as thread_ts.
export function isSlackThreadTs(threadTs: string): boolean {
	return /^\d+\.\d+$/.test(threadTs);
}

function formatDuration(ms: number): string {
	const hours = Math.floor(ms / 3600_000);
	if (hours >= 48) return `${Math.floor(hours / 24)}d`;
	if (hours >= 1) return `${hours}h`;
	return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

export function checkRunFailures(file: string = RUN_FAILURES_FILE, now: number = Date.now()): CheckResult[] {
	const out: CheckResult[] = [];
	for (const [agentName, streak] of Object.entries(load(file))) {
		if (!streak || streak.count < FAILURE_ALERT_THRESHOLD) continue;
		const since = Date.parse(streak.since);
		const duration = Number.isFinite(since) ? ` over the last ${formatDuration(now - since)}` : "";
		out.push({
			key: `run-failures-${agentName}`,
			severity: "critical",
			message:
				`🛑 *${agentName} has failed ${streak.count} runs in a row*${duration}. ` +
				`It is not doing its work.\n\nLast error:\n` +
				"```\n" + streak.lastError + "\n```\n" +
				`Inspect with \`pm2 logs ginnie-agents-listener\`. A missing image is fixed with ` +
				`\`docker build -t ginnie-agent -f docker/Dockerfile .\` from the repo root.`,
			actions: [
				{ type: "view_logs", label: "View logs" },
				{ type: "ack_24h", label: "Ack 24h" },
				{ type: "ack_7d", label: "Ack 7d" },
			],
		});
	}
	return out;
}
