/**
 * Replay CLI: run past cases through several model and effort settings, one
 * sandbox per run (replay.ts), and write one result line per case and setting.
 *
 *   node dist/replay-cli.js --agent <name> --cases <file.jsonl> --settings <file.json> --out <dir>
 *
 * cases.jsonl, one per line: { "id": "case-1", "prompt": "..." }
 * settings.json:
 *   {
 *     "replyMarker": "regex source",  "replyMarkerFlags": "i",       (optional flags)
 *     "profile": "chat",                (optional; a key of the agent's run_profiles)
 *     "env": { "NAME": "value" },       (optional; no secrets)
 *     "credentials": { ... },           (optional; the sandbox's whole credentials.json)
 *     "keepData": ["folder"],           (optional; data/ subfolders copied in)
 *     "outputDir": "data/out",          (optional; read into each result, then the sandbox is deleted)
 *     "settings": [ { "model": "...", "effort": "low", "label": "..." }, ... ]
 *   }
 * <dir>/results.jsonl is written fresh (refused if it exists), private to this
 * user, one line per run. The prompt itself is not repeated there; join on "case".
 * Progress lines carry ids and times only.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, appendFileSync, writeFileSync } from "fs";
import path from "path";
import { loadAgents, type AgentConfig } from "./runner";
import { replayOne, type ReplayDeps } from "./replay";

const MAX_OUTPUT_BYTES = 256 * 1024;

interface Setting { model: string; effort?: string; label?: string }
interface SettingsFile {
	replyMarker: string;
	replyMarkerFlags?: string;
	profile?: string;
	env?: Record<string, string>;
	credentials?: object;
	keepData?: string[];
	outputDir?: string;
	settings: Setting[];
}

function arg(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
}

// Every file under dir (relative "a/b" keys), text up to MAX_OUTPUT_BYTES each.
function readOutputs(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(dir)) return out;
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			const key = path.relative(dir, p).split(path.sep).join("/");
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) {
				const size = statSync(p).size;
				out[key] = size > MAX_OUTPUT_BYTES ? `(${size} bytes, not read)` : readFileSync(p, "utf-8");
			}
		}
	};
	walk(dir);
	return out;
}

function checkSettings(raw: any): string | null {
	if (!raw || typeof raw !== "object") return "settings file is not a JSON object";
	if (typeof raw.replyMarker !== "string" || !raw.replyMarker) return "settings.replyMarker (a regex source) is required";
	try { new RegExp(raw.replyMarker, raw.replyMarkerFlags || ""); } catch (e) { return `settings.replyMarker: ${String(e)}`; }
	if (!Array.isArray(raw.settings) || !raw.settings.length) return "settings.settings must be a non-empty list";
	for (const s of raw.settings) if (!s || typeof s.model !== "string") return "each setting needs a model";
	if (raw.outputDir !== undefined) {
		const o = raw.outputDir;
		if (typeof o !== "string" || !o || path.isAbsolute(o) || o.split(/[\\/]/).includes("..")) return "settings.outputDir must be a relative path inside the agent folder";
	}
	return null;
}

/** Returns the process exit code. deps.agents replaces the agents/ folder lookup (tests). */
export interface CliDeps extends ReplayDeps {
	agents?: AgentConfig[];
	/** The .env read for Claude accounts (default: the framework root .env, as the listener reads it). */
	envFile?: string;
}

export async function runReplayCli(argv: string[], deps: CliDeps = {}): Promise<number> {
	const say = (line: string) => console.error(`[replay] ${line}`);
	const name = arg(argv, "--agent"), casesFile = arg(argv, "--cases"), settingsFile = arg(argv, "--settings"), outDir = arg(argv, "--out");
	if (!name || !casesFile || !settingsFile || !outDir) {
		say("usage: replay-cli.js --agent <name> --cases <file.jsonl> --settings <file.json> --out <dir>");
		return 2;
	}
	const agent = (deps.agents ?? loadAgents()).find((a) => a.name === name);
	if (!agent) { say(`no agent named ${name}`); return 2; }

	let cfg: SettingsFile;
	let cases: { id: string; prompt: string }[];
	try {
		cfg = JSON.parse(readFileSync(settingsFile, "utf-8"));
		const bad = checkSettings(cfg);
		if (bad) { say(bad); return 2; }
		cases = readFileSync(casesFile, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
		for (const c of cases) if (!c || typeof c.id !== "string" || typeof c.prompt !== "string") { say("each case needs a string id and prompt"); return 2; }
	} catch (err) {
		say(`cannot read the cases or settings: ${String((err as Error)?.message ?? err)}`);
		return 2;
	}

	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	chmodSync(outDir, 0o700);
	const resultsFile = path.join(outDir, "results.jsonl");
	if (existsSync(resultsFile)) { say(`${resultsFile} already exists; use a new --out folder`); return 2; }
	writeFileSync(resultsFile, "", { mode: 0o600 });

	const marker = new RegExp(cfg.replyMarker, cfg.replyMarkerFlags || "");
	let failed = 0;
	for (const c of cases) {
		for (const s of cfg.settings) {
			const r = await replayOne(agent, {
				prompt: c.prompt,
				model: s.model,
				effort: s.effort,
				profile: cfg.profile,
				env: cfg.env,
				credentials: cfg.credentials,
				keepData: cfg.keepData,
				replyMarker: marker,
			}, deps);
			let outputs: Record<string, string> = {};
			try {
				if (r.sandbox && cfg.outputDir) outputs = readOutputs(path.join(r.sandbox, cfg.outputDir));
			} finally {
				if (r.sandbox) rmSync(r.sandbox, { recursive: true, force: true });
			}
			const { sandbox: _sandbox, ...rest } = r;
			appendFileSync(resultsFile, JSON.stringify({ case: c.id, ...(s.label ? { label: s.label } : {}), ...rest, outputs }) + "\n");
			if (!r.ok) failed++;
			say(`${c.id} ${s.model}/${r.effort ?? "default"}: ${r.ok ? `ok, reply written ${r.toReplyMs == null ? "never" : `${(r.toReplyMs / 1000).toFixed(1)} s`}, run ${((r.totalMs ?? 0) / 1000).toFixed(1)} s` : "failed"}`);
		}
	}
	say(`${cases.length * cfg.settings.length} runs, ${failed} failed; results in ${resultsFile}`);
	return 0;
}

if (require.main === module) {
	runReplayCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
		console.error(`[replay] ${String(err?.stack ?? err)}`);
		process.exitCode = 1;
	});
}
