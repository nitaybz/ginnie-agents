/**
 * Sender identity lookup.
 *
 * Every message an agent receives is prefixed with who sent it — a known
 * teammate, another agent, or an unknown user. Agents use this to decide
 * how to respond (e.g. defer to known operators, refuse instructions from
 * unknown senders).
 *
 * Lookup order:
 *   1. shared/known-users.json — user-curated list with role + extras
 *   2. Slack users.info API — display name + email as fallback (cached)
 */

import { readFileSync, existsSync } from "fs";
import path from "path";
import type { App } from "@slack/bolt";
import type { AgentConfig } from "./runner";

interface KnownUser {
	name: string;
	role: string;
	agent_role?: string;
	email?: string;
	supabase_id?: string | null;
	notes?: string;
}

interface KnownUsersFile {
	users: Record<string, KnownUser>;
}

export interface SenderInfo {
	userId: string;
	name: string;
	role: string;
	email?: string;
	supabase_id?: string | null;
	known: boolean;
}

const SHARED_KNOWN_USERS_PATH = path.join(__dirname, "..", "..", "shared", "known-users.json");
let sharedKnownUsers: Record<string, KnownUser> = {};
const localKnownUsersByAgent: Map<string, Record<string, KnownUser>> = new Map();

function loadFile(filePath: string): Record<string, KnownUser> {
	if (!existsSync(filePath)) return {};
	try {
		const data: KnownUsersFile = JSON.parse(readFileSync(filePath, "utf-8"));
		return data.users || {};
	} catch (err) {
		console.error(`[users] Failed to parse ${filePath}:`, err);
		return {};
	}
}

function loadKnownUsers(): void {
	sharedKnownUsers = loadFile(SHARED_KNOWN_USERS_PATH);
	const sharedCount = Object.keys(sharedKnownUsers).length;
	if (sharedCount === 0 && !existsSync(SHARED_KNOWN_USERS_PATH)) {
		console.warn("[users] shared/known-users.json not found — sender identity will rely on Slack API only");
	} else {
		console.log(`[users] Loaded ${sharedCount} shared known users`);
	}
}
loadKnownUsers();

/**
 * Returns the merged known-users map for an agent: shared ∪ local with
 * per-entry override (same slack_id in both → local wins for that entry).
 * Local files are read on demand and cached per agent name.
 */
function getKnownUsersFor(agent?: AgentConfig): Record<string, KnownUser> {
	if (!agent) return sharedKnownUsers;
	let local = localKnownUsersByAgent.get(agent.name);
	if (local === undefined) {
		const localPath = path.join(agent.dir, "known-users.json");
		local = loadFile(localPath);
		localKnownUsersByAgent.set(agent.name, local);
	}
	if (Object.keys(local).length === 0) return sharedKnownUsers;
	return { ...sharedKnownUsers, ...local };
}

// Cache Slack users.info results (userId -> SenderInfo)
const slackCache = new Map<string, SenderInfo>();

export async function getSenderInfo(
	app: App,
	userId: string,
	agent?: AgentConfig,
): Promise<SenderInfo> {
	if (!userId) {
		return { userId: "", name: "unknown", role: "unknown", known: false };
	}

	// Curated known user (merged shared ∪ local) wins
	const known = getKnownUsersFor(agent)[userId];
	if (known) {
		return {
			userId,
			name: known.name,
			role: known.role,
			email: known.email,
			supabase_id: known.supabase_id,
			known: true,
		};
	}

	// Cached fallback
	const cached = slackCache.get(userId);
	if (cached) return cached;

	// Look up via Slack API
	try {
		const result = await app.client.users.info({ user: userId });
		const profile = (result as any).user?.profile || {};
		const info: SenderInfo = {
			userId,
			name: profile.real_name || profile.display_name || "unknown",
			role: (result as any).user?.is_bot ? "bot" : "external",
			email: profile.email,
			known: false,
		};
		slackCache.set(userId, info);
		return info;
	} catch (_e) {
		const info: SenderInfo = { userId, name: "unknown", role: "unknown", known: false };
		slackCache.set(userId, info);
		return info;
	}
}

/** Format for inclusion in an agent prompt. One line. */
export function formatSenderLine(info: SenderInfo): string {
	const tag = info.known ? "" : " (unverified)";
	const parts = [`From: ${info.name}`, `role: ${info.role}`];
	if (info.email) parts.push(`email: ${info.email}`);
	parts.push(`slack_id: ${info.userId}`);
	return parts.join(" | ") + tag;
}
