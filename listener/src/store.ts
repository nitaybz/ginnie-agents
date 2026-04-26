/**
 * Simple file-backed store for thread → session mappings.
 * Persists to disk so it survives listener restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const STORE_PATH = path.join(__dirname, "..", "..", "data", "threads.json");

interface ThreadEntry {
	sessionId: string;
	agentName: string;
	createdAt: number;
}

let store: Record<string, ThreadEntry> = {};

export function loadStore(): void {
	const dir = path.dirname(STORE_PATH);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	try {
		if (existsSync(STORE_PATH)) {
			store = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
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
	const dir = path.dirname(STORE_PATH);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function getThread(channel: string, threadTs: string): ThreadEntry | undefined {
	return store[`${channel}:${threadTs}`];
}

export function setThread(
	channel: string,
	threadTs: string,
	sessionId: string,
	agentName: string,
): void {
	store[`${channel}:${threadTs}`] = {
		sessionId,
		agentName,
		createdAt: Date.now(),
	};
	saveStore();
}
