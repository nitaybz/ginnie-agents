/**
 * Read-only extra mounts per agent (config.json "extra_mounts").
 *
 * Lets an agent read a host file or directory it does not own (another
 * app's data, a shared credentials file) without copying it into the agent
 * folder. Each entry:
 *
 *   { "host_path": "/abs/host/path", "container_path": "/workspace/mounts/name", "read_only": true }
 *
 * Rules (an entry that breaks one is logged and dropped; the rest still apply):
 *  - read_only must be exactly true. Writable extra mounts are not supported.
 *  - host_path is absolute and canonical (no "~", "..", ".", "//" or trailing "/").
 *  - container_path sits strictly under /workspace/mounts/, so it can never
 *    cover a framework mount (memory, skills, prompt, credentials, sessions).
 *  - Container paths may not repeat or nest inside each other.
 *  - No commas (docker's --mount spec is comma separated).
 * At spawn time a host_path that does not exist is skipped with one log line
 * per agent and path; the agent still runs.
 */

import path from "path";

export const EXTRA_MOUNTS_ROOT = "/workspace/mounts";

export interface ExtraMount {
	hostPath: string;
	containerPath: string;
}

function isCanonicalAbsolute(p: unknown): p is string {
	return typeof p === "string"
		&& p.length > 1
		&& path.posix.isAbsolute(p)
		&& path.posix.normalize(p) === p
		&& !p.endsWith("/");
}

function nests(a: string, b: string): boolean {
	return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

export function parseExtraMounts(raw: unknown, log: (line: string) => void): ExtraMount[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		log("extra_mounts ignored: must be a list");
		return [];
	}
	const out: ExtraMount[] = [];
	raw.forEach((entry, i) => {
		const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
		const hp = e.host_path;
		const cp = e.container_path;
		const why = (reason: string) => log(`extra_mounts[${i}] rejected: ${reason}`);
		if (e.read_only !== true) return why("read_only must be true (only read-only mounts are supported)");
		if (!isCanonicalAbsolute(hp)) return why("host_path must be an absolute, canonical path");
		if (!isCanonicalAbsolute(cp) || !cp.startsWith(EXTRA_MOUNTS_ROOT + "/")) {
			return why(`container_path must be a canonical path under ${EXTRA_MOUNTS_ROOT}/`);
		}
		if (hp.includes(",") || cp.includes(",")) return why("paths may not contain commas");
		if (out.some((m) => nests(m.containerPath, cp))) return why(`container_path overlaps an earlier entry (${cp})`);
		out.push({ hostPath: hp, containerPath: cp });
	});
	return out;
}

const loggedMissing = new Set<string>();

export function extraMountDockerArgs(
	agentName: string,
	mounts: ExtraMount[],
	exists: (p: string) => boolean,
	log: (line: string) => void,
): string[] {
	const args: string[] = [];
	for (const m of mounts) {
		if (!exists(m.hostPath)) {
			const key = `${agentName}\0${m.hostPath}`;
			if (!loggedMissing.has(key)) {
				loggedMissing.add(key);
				log(`extra mount skipped, host path missing: ${m.hostPath} (agent still runs)`);
			}
			continue;
		}
		// --mount (not -v): never auto-creates a missing host path.
		args.push("--mount", `type=bind,source=${m.hostPath},target=${m.containerPath},readonly`);
	}
	return args;
}
