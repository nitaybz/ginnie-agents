/**
 * Mid-run messages (Nitay 2026-11-16: "if I send a message in the middle, it goes in between her
 * turns and does not wait for her to finish"). A message for a thread whose run is still working
 * is written into that run's inbox folder, which is mounted into the container; the entrypoint
 * hands it to the running session between tool calls (docker/midrun.mjs).
 *
 * One folder per run, a file moves by rename only:
 *   inbox/ (written here) -> claimed/ (taken by the run) -> seen/ (the model got it)
 * When the run is done the entrypoint renames inbox/ to closed/, so a write that comes too late
 * fails and offer() returns false: the caller queues the message as a normal next run. finish()
 * returns every message that did not reach seen/, to be run the same way. So a message is run
 * exactly once: inside the working run, or as the next run.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import path from "path";

export const MIDRUN_ROOT = path.join(__dirname, "..", "..", "data", "midrun");
export const MIDRUN_CONTAINER_DIR = "/workspace/.midrun";

export class MidRunInbox<M> {
	readonly dir: string;
	private readonly sent = new Map<string, M>(); // file name -> message, in arrival order
	private seenAtEnd: M[] | null = null;

	constructor(root: string, agentName: string) {
		mkdirSync(root, { recursive: true });
		this.dir = mkdtempSync(path.join(root, `${agentName.replace(/[^A-Za-z0-9._-]/g, "_")}-`)); // one folder per run
		for (const sub of ["inbox", "claimed", "seen"]) {
			const d = path.join(this.dir, sub);
			mkdirSync(d, { recursive: true });
			chmodSync(d, 0o777); // the container user renames files between these folders
		}
		chmodSync(this.dir, 0o777);
	}

	/** Hand a message to the working run. False = the run no longer takes messages; queue it instead. */
	offer(msg: M, text: string): boolean {
		if (this.seenAtEnd) return false;
		const name = `${String(this.sent.size + 1).padStart(4, "0")}.json`;
		const tmp = path.join(this.dir, `.tmp-${name}`);
		try {
			writeFileSync(tmp, JSON.stringify({ text }));
			renameSync(tmp, path.join(this.dir, "inbox", name)); // fails once inbox/ was renamed to closed/
		} catch {
			rmSync(tmp, { force: true });
			return false;
		}
		this.sent.set(name, msg);
		return true;
	}

	/** Messages the model has got so far. */
	seen(): M[] {
		if (this.seenAtEnd) return this.seenAtEnd;
		const dir = path.join(this.dir, "seen");
		const names = new Set(existsSync(dir) ? readdirSync(dir) : []);
		return [...this.sent].filter(([name]) => names.has(name)).map(([, msg]) => msg);
	}

	/** The run is over. Returns the messages it did not get, oldest first, and removes the folder. */
	finish(): M[] {
		if (this.seenAtEnd) return [];
		const seen = this.seen();
		this.seenAtEnd = seen;
		const left = [...this.sent.values()].filter((msg) => !seen.includes(msg));
		rmSync(this.dir, { recursive: true, force: true });
		return left;
	}
}

/** Docker args that give a run its inbox. No inbox = no args, the container runs exactly as before. */
export function midrunDockerArgs(dir?: string): string[] {
	return dir ? ["-e", `MIDRUN_DIR=${MIDRUN_CONTAINER_DIR}`, "-v", `${dir}:${MIDRUN_CONTAINER_DIR}`] : [];
}
