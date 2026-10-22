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
 *  - No commas, double quotes or control characters (docker's --mount spec
 *    is CSV: a newline would cut off ",readonly" and mount it writable).
 * The host path is then checked against the real filesystem (at startup and
 * again on every spawn): it must not be a symlink (realpath must equal it)
 * and must not be, sit inside, or contain a sensitive location (docker
 * socket, /var/lib/docker, /etc, /proc, /sys, /dev, /run, /root, ~/.ssh,
 * ~/.claude, ~/.docker, ~/.config/gh, ~/.config/gcloud, the framework .env,
 * another agent's folder). A single file may be mounted on its own, so an
 * agent can see one file of a folder without its siblings. A host_path that does not exist
 * is skipped with one log line per agent and path; the agent still runs.
 */

import path from "path";

export const EXTRA_MOUNTS_ROOT = "/workspace/mounts";

export interface ExtraMount {
	hostPath: string;
	containerPath: string;
}

// Control characters (incl. newline, CR, tab, NUL), DEL and double quotes.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f"]/;

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
		if (UNSAFE_CHARS.test(hp) || UNSAFE_CHARS.test(cp)) return why("paths may not contain control characters or quotes");
		if (hp.includes(",") || cp.includes(",")) return why("paths may not contain commas");
		if (out.some((m) => nests(m.containerPath, cp))) return why(`container_path overlaps an earlier entry (${cp})`);
		out.push({ hostPath: hp, containerPath: cp });
	});
	return out;
}

export interface HostEnv {
	home: string;
	agentsDir: string;
	frameworkRoot: string;
	// Throws (ENOENT) when the path does not exist.
	realpath: (p: string) => string;
}

function within(p: string, root: string): boolean {
	return p === root || p.startsWith(root === "/" ? "/" : root + "/");
}

/** null when safe to mount, "missing" when absent, otherwise the reason. */
export function hostPathProblem(agentName: string, hostPath: string, host: HostEnv): string | null {
	let real: string;
	try {
		real = host.realpath(hostPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		return `cannot resolve (${(err as NodeJS.ErrnoException).code || "error"})`;
	}
	if (real !== hostPath) return "is or goes through a symlink";
	const sensitive = [
		"/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/var/lib/docker", "/root", "/boot",
		path.posix.join(host.home, ".ssh"),
		path.posix.join(host.home, ".claude"),
		path.posix.join(host.home, ".docker"),
		path.posix.join(host.home, ".config", "gh"),
		path.posix.join(host.home, ".config", "gcloud"),
		path.posix.join(host.frameworkRoot, ".env"),
	];
	for (const root of sensitive) {
		if (within(hostPath, root) || within(root, hostPath)) return `overlaps a protected location (${root})`;
	}
	const ownDir = path.posix.join(host.agentsDir, agentName);
	if (within(host.agentsDir, hostPath)) return "contains the agents folder";
	if (within(hostPath, host.agentsDir) && !within(hostPath, ownDir)) return "is inside another agent's folder";
	return null;
}

/** Startup check: drop entries whose existing host path is unsafe. Missing ones stay (checked again at spawn). */
export function checkHostPaths(agentName: string, mounts: ExtraMount[], host: HostEnv, log: (line: string) => void): ExtraMount[] {
	return mounts.filter((m) => {
		const problem = hostPathProblem(agentName, m.hostPath, host);
		if (problem && problem !== "missing") {
			log(`extra mount rejected: ${m.hostPath} ${problem}`);
			return false;
		}
		return true;
	});
}

const loggedSkips = new Set<string>();

export function extraMountDockerArgs(
	agentName: string,
	mounts: ExtraMount[],
	host: HostEnv,
	log: (line: string) => void,
): string[] {
	const args: string[] = [];
	for (const m of mounts) {
		const problem = hostPathProblem(agentName, m.hostPath, host);
		if (problem) {
			const key = `${agentName}\0${m.hostPath}\0${problem}`;
			if (!loggedSkips.has(key)) {
				loggedSkips.add(key);
				log(problem === "missing"
					? `extra mount skipped, host path missing: ${m.hostPath} (agent still runs)`
					: `extra mount skipped: ${m.hostPath} ${problem} (agent still runs)`);
			}
			continue;
		}
		// --mount (not -v): never auto-creates a missing host path.
		args.push("--mount", `type=bind,source=${m.hostPath},target=${m.containerPath},readonly`);
	}
	return args;
}
