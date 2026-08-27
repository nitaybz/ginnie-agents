/**
 * Roster reader — turns the runner's loaded agents into the display
 * information Ginnie Studio needs to show them as teammates.
 *
 * Everything here is best-effort. An agent missing slack.json, AGENT.md or
 * avatar.png is still a valid agent; it just shows up with less decoration.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";
import type { AgentConfig } from "./runner";

export interface RosterEntry {
	/** Directory name, the stable identifier Studio stores. */
	name: string;
	/** Human name, from the agent's Slack app. */
	displayName: string;
	/** One-line description of what the agent does. May be empty. */
	role: string;
	/** "read-only" or "write", mirrored from the agent's config. */
	boundaries: string;
	hasAvatar: boolean;
	/** Absolute path to avatar.png, or "" when there is none. */
	avatarPath: string;
}

function capitalise(name: string): string {
	if (!name) return "";
	return name.charAt(0).toUpperCase() + name.slice(1);
}

export function readDisplayName(agentDir: string, fallbackName: string): string {
	try {
		const raw = readFileSync(path.join(agentDir, "slack.json"), "utf8");
		const parsed = JSON.parse(raw) as { app_name?: unknown };
		if (typeof parsed.app_name === "string" && parsed.app_name.trim()) {
			return parsed.app_name.trim();
		}
	} catch {
		// no slack.json, or it is not readable JSON — fall through
	}
	return capitalise(fallbackName);
}

export function readRole(agentDir: string): string {
	let body = "";
	try {
		body = readFileSync(path.join(agentDir, "AGENT.md"), "utf8");
	} catch {
		return "";
	}

	const bullet = body.match(/^\s*[-*]\s*\*\*Role:\*\*\s*(.+)$/m);
	if (bullet && bullet[1].trim()) return bullet[1].trim();

	// "# Casper — Business Consultant" → "Business Consultant".
	// Accepts an em dash, an en dash, or a hyphen as the separator.
	const heading = body.match(/^#\s+[^\n—–-]+[—–-]\s*(.+)$/m);
	if (heading && heading[1].trim()) return heading[1].trim();

	return "";
}

export function buildRoster(agentList: AgentConfig[]): RosterEntry[] {
	return agentList.map((agent) => {
		const avatarPath = path.join(agent.dir, "avatar.png");
		const hasAvatar = existsSync(avatarPath);
		return {
			name: agent.name,
			displayName: readDisplayName(agent.dir, agent.name),
			role: readRole(agent.dir),
			boundaries: agent.boundaries,
			hasAvatar,
			avatarPath: hasAvatar ? avatarPath : "",
		};
	});
}
