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
//
// Only relevant for Option A (CLAUDE_CODE_OAUTH_TOKEN). Option B
// (ANTHROPIC_API_KEY) doesn't expire on a fixed schedule — rotation cadence
// there is the operator's call, not a clock the framework can read.
export function checkTokenAge(): CheckResult | null {
	// Skip when API key is the active auth — token-age has no meaning.
	if (process.env.ANTHROPIC_API_KEY) return null;
	if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) return null;
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
//
// FRAMEWORK_UPSTREAM names the ref the operator wants tracked. For fresh
// adopters who cloned this repo directly, that's `origin/main`. For
// fork-and-track installs (private origin, public framework on `upstream`),
// set FRAMEWORK_UPSTREAM=upstream/main in .env.
//
// The "deployed framework version" is recorded in data/framework-version.txt
// (just a sha). update-framework.sh writes it after every successful pull.
// We compare that sha to the upstream HEAD — so even when the local repo's
// git HEAD points at unrelated private history, the comparison works.
//
// If data/framework-version.txt is missing, we fall back to git HEAD —
// correct for direct-clone installs whose HEAD always equals the deployed
// framework version.
const FRAMEWORK_UPSTREAM = process.env.FRAMEWORK_UPSTREAM || "origin/main";
const FRAMEWORK_VERSION_FILE = "data/framework-version.txt";

function deployedSha(): string {
	try {
		const f = path.join(REPO, FRAMEWORK_VERSION_FILE);
		if (existsSync(f)) {
			const s = readFileSync(f, "utf-8").trim();
			if (/^[0-9a-f]{7,40}$/.test(s)) return s;
		}
	} catch { /* fall through */ }
	try {
		return execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf-8" }).trim();
	} catch {
		return "";
	}
}

export function checkFrameworkUpdate(): CheckResult | null {
	const slash = FRAMEWORK_UPSTREAM.indexOf("/");
	if (slash <= 0) return null;
	const remote = FRAMEWORK_UPSTREAM.slice(0, slash);
	try {
		execSync(`git fetch ${remote} --quiet`, { cwd: REPO, stdio: "ignore" });
	} catch {
		return null; // no such remote, fetch failed — silent (not actionable)
	}
	const base = deployedSha();
	if (!base) return null;
	let targetSha = "";
	try {
		targetSha = execSync(`git rev-parse ${FRAMEWORK_UPSTREAM}`, {
			cwd: REPO,
			encoding: "utf-8",
		}).trim();
	} catch {
		return null;
	}
	if (!targetSha || targetSha === base) return null;
	let ahead = 0;
	let titles = "";
	try {
		ahead = parseInt(
			execSync(`git rev-list --count ${base}..${FRAMEWORK_UPSTREAM}`, {
				cwd: REPO,
				encoding: "utf-8",
			}).trim(),
			10,
		) || 0;
		if (ahead > 0) {
			titles = execSync(`git log ${base}..${FRAMEWORK_UPSTREAM} --oneline`, {
				cwd: REPO,
				encoding: "utf-8",
			})
				.split("\n")
				.slice(0, 10)
				.join("\n");
		}
	} catch {
		// `base` may be unreachable from upstream (e.g., user forced a reset
		// of the framework version file to a commit that's no longer in the
		// upstream history). Stay silent rather than alerting wrongly.
		return null;
	}
	if (ahead === 0) return null;
	return {
		key: `framework-update:${targetSha.slice(0, 7)}`,
		severity: "info",
		message:
			`🔄 *${ahead} framework update${ahead === 1 ? "" : "s"} available* on ${FRAMEWORK_UPSTREAM}:\n` +
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
