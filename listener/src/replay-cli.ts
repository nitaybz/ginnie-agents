// Replay CLI (stub: the tests come first).
import type { AgentConfig } from "./runner";
import type { ReplayDeps } from "./replay";

export async function runReplayCli(_argv: string[], _deps: ReplayDeps & { agents?: AgentConfig[] } = {}): Promise<number> {
	throw new Error("not implemented");
}
