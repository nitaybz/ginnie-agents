// Replay harness (stub: the tests come first).
import type { AgentConfig } from "./runner";
import type { ClaudeAccount } from "./claude-accounts";

export interface RunTimings { toReplyMs: number | null; totalMs: number; modelMs: number; toolMs: number; outTokens: number; seenModel?: string; seenEffort?: string }
export interface ReplayCase { prompt: string; model: string; effort?: string; profile?: string; env?: Record<string, string>; credentials?: object; keepData?: string[]; replyMarker: RegExp }
export interface ReplayResult extends Omit<RunTimings, "toReplyMs"> { ok: boolean; reason?: string; model: string; effort: string | null; toReplyMs: number | null; sandbox: string; result?: string }
export interface ReplayDeps { accounts?: ClaudeAccount[]; cooldownFile?: string; sandboxRoot?: string }

export function makeSandbox(_agentDir: string, _opts: { credentials?: object; keepData?: string[]; root?: string }): string {
	throw new Error("not implemented");
}
export function runTimings(_jsonl: string, _marker: RegExp): RunTimings | null {
	throw new Error("not implemented");
}
export async function replayOne(_agent: AgentConfig, _c: ReplayCase, _deps: ReplayDeps = {}): Promise<ReplayResult> {
	throw new Error("not implemented");
}
