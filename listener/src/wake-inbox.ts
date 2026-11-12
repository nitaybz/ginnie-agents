/**
 * Wake inbox (Nitay 2026-11-12: an order or an email that comes in must be handled right away, not
 * at the next schedule). A host job with no model (an order or mail watcher) writes
 * <agent dir>/data/wake/<name>.json = {"id": "<short id>", "message": "<prompt>"} (write a hidden
 * .tmp file, then rename). The listener polls the folder, moves each file to done/ BEFORE waking, so
 * a file wakes the agent once, and runs it like a schedule fire. Opt-in per agent: config.json
 * "wake_inbox": true.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "fs";
import path from "path";

export interface WakeEntry { id: string; message: string; file: string }

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_MESSAGE = 30000;
const KEEP_DONE_MS = 7 * 864e5;

function moveTo(dir: string, sub: string, name: string): boolean {
	const target = path.join(dir, sub);
	mkdirSync(target, { recursive: true });
	try {
		renameSync(path.join(dir, name), path.join(target, name));
		return true;
	} catch {
		return false; // another poll took it
	}
}

export function takeWakeFiles(dir: string, now = Date.now()): WakeEntry[] {
	if (!existsSync(dir)) return [];
	const names = readdirSync(dir)
		.filter((n) => n.endsWith(".json") && !n.startsWith("."))
		.map((n) => { try { return { n, t: statSync(path.join(dir, n)).mtimeMs }; } catch { return null; } })
		.filter((x): x is { n: string; t: number } => x !== null)
		.sort((a, b) => a.t - b.t || a.n.localeCompare(b.n))
		.map((x) => x.n);
	const out: WakeEntry[] = [];
	for (const name of names) {
		let entry: { id?: unknown; message?: unknown } | null = null;
		try {
			entry = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
		} catch {
			entry = null;
		}
		const ok = entry && typeof entry.id === "string" && ID.test(entry.id)
			&& typeof entry.message === "string" && entry.message.trim() !== "" && entry.message.length <= MAX_MESSAGE;
		if (!ok) {
			moveTo(dir, "rejected", name);
			continue;
		}
		if (moveTo(dir, "done", name)) out.push({ id: entry!.id as string, message: entry!.message as string, file: name });
	}
	// done/ and rejected/ are a short audit trail, not an archive.
	for (const sub of ["done", "rejected"]) {
		const d = path.join(dir, sub);
		if (!existsSync(d)) continue;
		for (const n of readdirSync(d)) {
			const p = path.join(d, n);
			try { if (now - statSync(p).mtimeMs > KEEP_DONE_MS) unlinkSync(p); } catch { /* gone */ }
		}
	}
	return out;
}

export class WakeInbox {
	private timer: NodeJS.Timeout | null = null;
	constructor(private readonly opts: {
		agentName: string;
		dir: string;
		onWake: (entry: WakeEntry) => void;
		intervalMs?: number;
		log?: (line: string) => void;
	}) {}

	pollOnce(): void {
		const log = this.opts.log || console.log;
		let entries: WakeEntry[] = [];
		try {
			entries = takeWakeFiles(this.opts.dir);
		} catch (err) {
			log(`[${this.opts.agentName}] wake inbox read failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		for (const e of entries) {
			log(`[${this.opts.agentName}] wake inbox: ${e.id} (${e.file})`);
			this.opts.onWake(e);
		}
	}

	start(): void {
		mkdirSync(this.opts.dir, { recursive: true });
		this.pollOnce();
		this.timer = setInterval(() => this.pollOnce(), this.opts.intervalMs ?? 10000);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}
}
