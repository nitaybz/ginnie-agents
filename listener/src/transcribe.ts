/**
 * Voice-message transcription via whisper.cpp.
 *
 * Wired into the message handler in index.ts. When Slack delivers an audio
 * file (voice memo or attached audio clip), the transcript replaces the
 * usual "here's a download command" stub so the agent receives plain text
 * instead of a file pointer it cannot open.
 *
 * Whisper.cpp + the model are installed *eagerly* by `scripts/install-whisper.sh`
 * (run from the setup skill, on user opt-in). This module is purely a runtime
 * shim — if the binary or model is missing it logs once and returns null,
 * letting audio fall back to the standard download-stub behavior.
 *
 * Cost / privacy: zero network calls per transcription, fully local CPU.
 */

import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const WHISPER_DIR = path.join(__dirname, "..", ".whisper");
const WHISPER_REPO = path.join(WHISPER_DIR, "whisper.cpp");
const MODEL_DIR = path.join(WHISPER_REPO, "models");
// Nitay 2026-11-09: voice notes are mostly Hebrew. ivrit.ai's Hebrew
// large-v3-turbo (quantized q5_0, ~570 MB) when present, else the stock small model.
const MODEL_NAMES = ["ggml-ivrit-large-v3-turbo-q5_0.bin", "ggml-ivrit-large-v3-turbo.bin", "ggml-small.bin"];

export function pickWhisperModel(dir: string, exists: (p: string) => boolean = fs.existsSync): string | null {
	for (const n of MODEL_NAMES) {
		const p = path.join(dir, n);
		if (exists(p)) return p;
	}
	return null;
}

/**
 * whisper.cpp always encodes a 30 s window. A short clip only needs its own
 * length: on the VM a 3 s voice note took 101 s with the full window and 13 s
 * with this. 0 = whisper's default (full window), used for 28 s and longer.
 */
export function audioContextFor(seconds: number): number {
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= 28) return 0;
	const ctx = Math.ceil((seconds / 30) * 1500) + 128;
	return Math.min(1500, Math.ceil(ctx / 64) * 64);
}

const WHISPER_THREADS = String(Math.max(1, Math.min(16, os.cpus().length - 2)));
// One transcription at a time: each uses most of the CPU.
let whisperChain: Promise<unknown> = Promise.resolve();

// Modern whisper.cpp (CMake) puts the binary at build/bin/whisper-cli.
// Older Make builds produced ./main. We probe both.
const BIN_CANDIDATES = [
	path.join(WHISPER_REPO, "build", "bin", "whisper-cli"),
	path.join(WHISPER_REPO, "main"),
];

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB — well above any Slack voice memo
const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000; // 5min cap for very long audio
// ffmpeg / ffprobe: a corrupt file must never hold the one-at-a-time queue (review r1).
const TOOL_TIMEOUT_MS = 60_000;

let warnedMissing = false;

export function isAudioMime(mime: string): boolean {
	return /^audio\//i.test(mime);
}

export function whisperReady(): boolean {
	return Boolean(findBinary() && pickWhisperModel(MODEL_DIR));
}

/** Transcribe audio bytes (any format ffmpeg reads). null when whisper is missing or fails. */
export async function transcribeBuffer(audio: Buffer, opts: { language?: string } = {}): Promise<string | null> {
	const bin = findBinary();
	const model = pickWhisperModel(MODEL_DIR);
	if (!bin || !model) {
		warnMissing();
		return null;
	}
	if (audio.length > MAX_AUDIO_BYTES) {
		console.error(`[transcribe] audio too large (${audio.length} bytes, cap ${MAX_AUDIO_BYTES})`);
		return null;
	}
	const id = crypto.randomBytes(8).toString("hex");
	const audioPath = path.join(os.tmpdir(), `ginnie-voice-${id}.audio`);
	const wavPath = path.join(os.tmpdir(), `ginnie-voice-${id}.wav`);
	const job = whisperChain.then(async () => {
		try {
			fs.writeFileSync(audioPath, audio);
			await convertToWav(audioPath, wavPath);
			const seconds = await durationOf(wavPath);
			const text = await runWhisper(bin, model, wavPath, audioContextFor(seconds), opts.language || "auto");
			return text.trim() || null;
		} catch (e) {
			console.error("[transcribe] failed:", (e as Error).message);
			return null;
		} finally {
			try { fs.unlinkSync(audioPath); } catch {}
			try { fs.unlinkSync(wavPath); } catch {}
		}
	});
	whisperChain = job.catch(() => {});
	return job;
}

function warnMissing(): void {
	if (warnedMissing) return;
	warnedMissing = true;
	console.warn(
		"[transcribe] whisper.cpp or its model is not installed: audio passes through as a file " +
		"pointer. Run `scripts/install-whisper.sh`.",
	);
}

export async function transcribeAudio(
	url: string,
	slackToken: string,
): Promise<string | null> {
	const bin = findBinary();
	if (!bin || !pickWhisperModel(MODEL_DIR)) {
		warnMissing();
		return null;
	}

	try {
		const res = await fetch(url, { headers: { Authorization: `Bearer ${slackToken}` } });
		if (!res.ok) throw new Error(`Slack download HTTP ${res.status}`);
		return await transcribeBuffer(Buffer.from(await res.arrayBuffer()));
	} catch (e) {
		console.error("[transcribe] failed:", (e as Error).message);
		return null;
	}
}

function findBinary(): string | null {
	for (const p of BIN_CANDIDATES) if (fs.existsSync(p)) return p;
	return null;
}

async function convertToWav(src: string, dst: string): Promise<void> {
	// whisper.cpp requires 16kHz mono 16-bit PCM WAV.
	await run("ffmpeg", ["-y", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dst], { timeoutMs: TOOL_TIMEOUT_MS });
}

async function durationOf(wavPath: string): Promise<number> {
	try {
		const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wavPath], { timeoutMs: TOOL_TIMEOUT_MS });
		return parseFloat(out.trim());
	} catch {
		return NaN; // unknown length: full window
	}
}

async function runWhisper(bin: string, model: string, wavPath: string, audioCtx: number, lang: string): Promise<string> {
	// `-otxt` writes <wav>.txt next to the input; `-nt` suppresses timestamps.
	// Language: "he" for WhatsApp (office chats are Hebrew), "auto" elsewhere.
	const args = ["-m", model, "-f", wavPath, "-otxt", "-nt", "-np", "-l", lang, "-t", WHISPER_THREADS];
	if (audioCtx > 0) args.push("-ac", String(audioCtx));
	const out = await run(bin, args, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });

	const txtPath = wavPath + ".txt";
	if (fs.existsSync(txtPath)) {
		const text = fs.readFileSync(txtPath, "utf8");
		try { fs.unlinkSync(txtPath); } catch {}
		return text;
	}
	// Older whisper.cpp prints to stdout when -otxt isn't honored.
	return out;
}

interface RunOpts { cwd?: string; timeoutMs?: number; }

function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = opts.timeoutMs ? setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
		}, opts.timeoutMs) : null;
		child.stdout.on("data", (d) => stdout += d.toString());
		child.stderr.on("data", (d) => stderr += d.toString());
		child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 500)}`));
		});
	});
}
