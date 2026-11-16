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
 *
 * Trust: the agent can write into its own run's folder (never another thread's or agent's). A
 * message read back from it is therefore worth no more than the agent's own word: it is only ever
 * given to the model as user text, and nothing may treat it as an approval or a verified sender.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
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
		// 0700, owned by the listener's user. The container must run as that same uid (1000, the
		// image's "node" user) to move files here; if it does not, docker/midrun.mjs turns the
		// feed off for the run and messages wait in line as before.
		for (const sub of ["inbox", "claimed", "seen"]) mkdirSync(path.join(this.dir, sub), { mode: 0o700 });
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

let complained = false;

/** A run's inbox, or undefined when the folder cannot be made: the run then goes exactly the old way. Says so once. */
export function openMidRunInbox<M>(root: string, agentName: string, log: (line: string) => void = console.warn): MidRunInbox<M> | undefined {
	try {
		return new MidRunInbox<M>(root, agentName);
	} catch (err) {
		if (!complained) {
			complained = true;
			log(`[midrun] cannot create an inbox under ${root} (${err instanceof Error ? err.message : err}); messages that arrive mid-run wait for the run to end, as before`);
		}
		return undefined;
	}
}
