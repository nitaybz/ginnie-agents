/**
 * Watcher checks — pure functions that produce alerts.
 *
 * Each check returns a CheckResult: { key, severity, message, actions }.
 * The watcher loop runs them on a timer and decides whether to post,
 * based on cooldowns and acks stored in data/watcher-state.json.
 *
 * No AI here — just shell-outs and file reads. Cheap, fast, deterministic.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";

export type Severity = "info" | "warn" | "critical";

export interface CheckAction {
	type: "update_framework" | "ack_24h" | "ack_7d" | "restart_listener" | "view_logs";
	label: string;
	style?: "primary" | "danger";
	value?: string;
}

export interface CheckResult {
	key: string;            // stable id for cooldown/ack tracking
	severity: Severity;
	message: string;        // Slack mrkdwn; can be multi-line
	actions?: CheckAction[]; // interactive buttons for this alert
	context?: Record<string, string>; // extra metadata (e.g., target version sha for update)
}

const REPO = path.resolve(__dirname, "..", "..");

// ─── Token expiry ──────────────────────────────────────────
export function checkTokenAge(): CheckResult | null {
	const tsFile = path.join(REPO, "data", "token-issued-at.txt");
	if (!existsSync(tsFile)) return null;
	const issued = readFileSync(tsFile, "utf-8").trim();
	const epochThen = Date.parse(issued + "T00:00:00Z");
	if (!Number.isFinite(epochThen)) return null;
	const days = Math.floor((Date.now() - epochThen) / 86400_000);
	if (days < 335) return null;
	return {
		key: "token-expiry",
		severity: days >= 350 ? "critical" : "warn",
		message:
			`🔑 *CLAUDE_CODE_OAUTH_TOKEN is ${days} days old* (cap ~365). ` +
			`Run \`claude setup-token\`, update \`CLAUDE_CODE_OAUTH_TOKEN\` in \`.env\`, ` +
			`then \`pm2 restart ginnie-agents-listener\`. After that: ` +
			`\`date '+%Y-%m-%d' > data/token-issued-at.txt\`.`,
	};
}

// ─── Framework update available ────────────────────────────
export function checkFrameworkUpdate(): CheckResult | null {
	try {
		execSync("git fetch origin --quiet", { cwd: REPO, stdio: "ignore" });
	} catch {
		return null; // no remote, no remote/main, or fetch failed — silent
	}
	let ahead = 0;
	let titles = "";
	let targetSha = "";
	try {
		ahead = parseInt(
			execSync("git rev-list --count HEAD..origin/main", {
				cwd: REPO,
				encoding: "utf-8",
			}).trim(),
			10,
		) || 0;
		if (ahead > 0) {
			titles = execSync("git log HEAD..origin/main --oneline", {
				cwd: REPO,
				encoding: "utf-8",
			})
				.split("\n")
				.slice(0, 10)
				.join("\n");
			targetSha = execSync("git rev-parse origin/main", {
				cwd: REPO,
				encoding: "utf-8",
			}).trim();
		}
	} catch {
		return null;
	}
	if (ahead === 0) return null;
	return {
		key: `framework-update:${targetSha.slice(0, 7)}`,
		severity: "info",
		message:
			`🔄 *${ahead} framework update${ahead === 1 ? "" : "s"} available* on origin/main:\n` +
			"```\n" + titles + "\n```",
		actions: [
			{ type: "update_framework", label: "Update now", style: "primary", value: targetSha },
			{ type: "ack_24h", label: "Remind tomorrow" },
			{ type: "ack_7d", label: "Skip this version", value: targetSha },
		],
		context: { target_sha: targetSha, ahead: String(ahead) },
	};
}

// ─── PM2 listener health ───────────────────────────────────
interface Pm2Process {
	name: string;
	pm2_env?: { status?: string; restart_time?: number };
}

export function checkListenerHealth(): CheckResult | null {
	let status = "unknown";
	let restarts = 0;
	try {
		const raw = execSync("pm2 jlist", { encoding: "utf-8" });
		const data: Pm2Process[] = JSON.parse(raw);
		const proc = data.find((p) => p.name === "ginnie-agents-listener");
		if (!proc) {
			return {
				key: "listener-not-loaded",
				severity: "critical",
				message:
					`❓ *Listener not loaded in PM2.* Run \`pm2 start ecosystem.config.cjs\` ` +
					`from the repo root.`,
			};
		}
		status = proc.pm2_env?.status || "unknown";
		restarts = proc.pm2_env?.restart_time || 0;
	} catch {
		return null; // pm2 unavailable; not actionable from watcher
	}
	if (status === "errored") {
		return {
			key: "listener-errored",
			severity: "critical",
			message:
				`🚨 *Listener errored.* Inspect with the View logs button or ` +
				`\`pm2 logs ginnie-agents-listener\`.`,
			actions: [
				{ type: "view_logs", label: "View logs" },
				{ type: "restart_listener", label: "Restart listener", style: "primary" },
			],
		};
	}
	if (status === "stopped") {
		return {
			key: "listener-stopped",
			severity: "warn",
			message: `⏸️ *Listener stopped.* Click below to restart, or run \`pm2 start ecosystem.config.cjs\`.`,
			actions: [
				{ type: "restart_listener", label: "Restart listener", style: "primary" },
			],
		};
	}
	if (status === "online" && restarts > 50) {
		return {
			key: "listener-flapping",
			severity: "warn",
			message:
				`🌀 *Listener has restarted ${restarts} times.* Likely a crash loop. ` +
				`Inspect logs.`,
			actions: [{ type: "view_logs", label: "View logs" }],
		};
	}
	return null;
}

// ─── Disk usage ────────────────────────────────────────────
export function checkDisk(): CheckResult | null {
	try {
		const out = execSync(`df -P "${REPO}"`, { encoding: "utf-8" });
		const line = out.split("\n")[1] || "";
		const m = line.match(/(\d+)%/);
		if (!m) return null;
		const used = parseInt(m[1], 10);
		if (used >= 95) {
			return {
				key: "disk-95",
				severity: "critical",
				message:
					`🔥 *Disk ${used}% full* on the filesystem holding the repo. ` +
					`Free space: \`pm2 flush\`, \`docker system prune\`, rotate \`agents/*/logs/\`.`,
			};
		}
		if (used >= 90) {
			return {
				key: "disk-90",
				severity: "warn",
				message: `💾 *Disk ${used}% full.* Watch closely or free space soon.`,
			};
		}
	} catch {
		/* ignore */
	}
	return null;
}

// ─── Memory caps per agent ─────────────────────────────────
export function checkMemoryCaps(): CheckResult[] {
	const out: CheckResult[] = [];
	const agentsDir = path.join(REPO, "agents");
	if (!existsSync(agentsDir)) return out;
	for (const entry of readdirSync(agentsDir)) {
		const full = path.join(agentsDir, entry);
		if (!statSync(full).isDirectory()) continue;
		for (const tier of ["rules", "playbook"] as const) {
			const cap = tier === "rules" ? 200 : 300;
			const warn = cap - 10;
			const f = path.join(full, "memory", `${tier}.md`);
			if (!existsSync(f)) continue;
			const lines = readFileSync(f, "utf-8").split("\n").length;
			if (lines > cap) {
				out.push({
					key: `memcap-${entry}-${tier}-over`,
					severity: "critical",
					message:
						`🚫 *${entry}/memory/${tier}.md is ${lines} lines* (cap ${cap}, over). ` +
						`Commits are now blocked by the hook. Run nightly consolidation.`,
					actions: [{ type: "ack_24h", label: "Ack for 24h" }],
				});
			} else if (lines >= warn) {
				out.push({
					key: `memcap-${entry}-${tier}-near`,
					severity: "warn",
					message:
						`⚠️ *${entry}/memory/${tier}.md is ${lines} lines* (cap ${cap}). ` +
						`Consolidation overdue.`,
					actions: [
						{ type: "ack_24h", label: "Ack 24h" },
						{ type: "ack_7d", label: "Ack 7d" },
					],
				});
			}
		}
	}
	return out;
}

export function runAllChecks(): CheckResult[] {
	const results: (CheckResult | null)[] = [
		checkTokenAge(),
		checkFrameworkUpdate(),
		checkListenerHealth(),
		checkDisk(),
		...checkMemoryCaps(),
	];
	return results.filter((r): r is CheckResult => r !== null);
}
