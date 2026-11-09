/**
 * Simple file-backed store for thread → session mappings.
 * Persists to disk so it survives listener restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

// GINNIE_THREAD_STORE overrides the file (tests). Read at use, not at import.
function storePath(): string {
	return process.env.GINNIE_THREAD_STORE || path.join(__dirname, "..", "..", "data", "threads.json");
}

// One saved session per agent per thread (review 2026-11-09: two agents in
// one thread used to overwrite each other's entry on every run).
function entryKey(agentName: string, channel: string, threadTs: string): string {
	return `${agentName}|${channel}:${threadTs}`;
}

interface ThreadEntry {
	sessionId: string;
	agentName: string;
	createdAt: number;
}

let store: Record<string, ThreadEntry> = {};

export function loadStore(): void {
	const dir = path.dirname(storePath());
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	try {
		store = {};
		if (existsSync(storePath())) {
			store = JSON.parse(readFileSync(storePath(), "utf-8"));
			// Clean entries older than 24 hours
			const cutoff = Date.now() - 24 * 60 * 60 * 1000;
			for (const key of Object.keys(store)) {
				if (store[key].createdAt < cutoff) {
					delete store[key];
				}
			}
			saveStore();
		}
	} catch {
		store = {};
	}
}

function saveStore(): void {
	const dir = path.dirname(storePath());
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(storePath(), JSON.stringify(store, null, 2));
}

export function getThread(agentName: string, channel: string, threadTs: string): ThreadEntry | undefined {
	const own = store[entryKey(agentName, channel, threadTs)];
	if (own) return own;
	// Entries saved before 2026-11-09 are keyed by thread only.
	const legacy = store[`${channel}:${threadTs}`];
	return legacy && legacy.agentName === agentName ? legacy : undefined;
}

export function setThread(
	channel: string,
	threadTs: string,
	sessionId: string,
	agentName: string,
): void {
	store[entryKey(agentName, channel, threadTs)] = {
		sessionId,
		agentName,
		createdAt: Date.now(),
	};
	saveStore();
}
