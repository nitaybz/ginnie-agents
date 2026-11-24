/**
 * Agent forms (Nitay 2026-11-24): many questions answered in one Slack modal instead of a long text list.
 *
 * The agent writes the form to <agent dir>/data/forms/<form id>.json and posts a message with one button
 * (action_id "agent_form_open", value = the form id). A click by someone allowed to answer opens a modal
 * with every question: a bold title, a context line, and a list of answers ending with "other". Choosing
 * "other" redraws the modal at once with a free-text box right under that question. One submit hands all
 * answers to the agent as one message in the post's thread (like any other click), the post's button is
 * replaced by an "answered" line, and the form is marked answered on disk so a second submit is ignored,
 * also after a listener restart. The answers are saved in the listener's own state before Slack is
 * answered, copied read-only for the agent, and handed over again at startup until the agent applied them. A form expires with the agent's button TTL (or its own expires_at), or
 * when the agent marks it superseded by a newer one.
 *
 * The form file comes from inside the agent's container: it is data, checked and capped here, and it
 * never decides who may answer. That is config.json "form_answerers" (Slack user ids), or else the
 * people with role "founder" in known-users.json.
 */
import { randomBytes, randomUUID } from "crypto";
import { closeSync, constants as fsc, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "fs";
import path from "path";

export const FORM_OPEN_ACTION = "agent_form_open";
export const FORM_CALLBACK = "agent_form";
export const OTHER_VALUE = "__other__";
const SELECT_ACTION = "choice";
const TEXT_ACTION = "text";

const FORM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const QUESTION_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const OPTION_VALUE = /^[A-Za-z0-9_.:-]{1,150}$/;
// Slack allows 100 blocks in a view; a question takes at most 5 (title, context, select, box, divider).
const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 99; // plus "other": Slack's limit is 100
const STATE_DAYS = 30;

export interface FormTexts {
	submit: string;
	close: string;
	other: string;
	otherLabel: string;
	selectLabel: string;
	notAllowed: string;
	answered: string;
	expired: string;
	already: string;
	missing: string;
	empty: string;
}

const DEFAULT_TEXTS: FormTexts = {
	submit: "Send",
	close: "Cancel",
	other: "Other",
	otherLabel: "Write your answer",
	selectLabel: "Answer",
	notAllowed: "Only the owner can answer this form.",
	answered: "Answered ✓ {answered} of {total}",
	expired: "This form is no longer valid.",
	already: "This form was already answered.",
	missing: "This form is no longer available.",
	empty: "Nothing was chosen.",
};

// The form file's snake_case keys.
const TEXT_KEYS: Record<keyof FormTexts, string> = {
	submit: "submit", close: "close", other: "other", otherLabel: "other_label", selectLabel: "select_label",
	notAllowed: "not_allowed", answered: "answered", expired: "expired", already: "already_answered", missing: "missing", empty: "empty",
};

export interface FormOption { value: string; label: string }
export interface FormQuestion { id: string; title: string; context?: string; options: FormOption[]; initial?: string }
export interface AgentForm {
	id: string;
	title: string;
	questions: FormQuestion[];
	createdAt: number;
	expiresAt?: number;
	superseded: boolean;
	texts: FormTexts;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const time = (v: unknown): number | undefined => {
	const t = typeof v === "string" ? Date.parse(v) : NaN;
	return Number.isFinite(t) ? t : undefined;
};

/** Check a form file. Anything malformed is dropped; a form with no usable question is null. */
export function parseForm(raw: any): AgentForm | null {
	if (!raw || typeof raw !== "object") return null;
	const id = typeof raw.id === "string" ? raw.id : "";
	if (!FORM_ID.test(id)) return null;
	const createdAt = time(raw.created_at);
	if (createdAt === undefined) return null;
	const texts = { ...DEFAULT_TEXTS };
	for (const [k, fileKey] of Object.entries(TEXT_KEYS) as [keyof FormTexts, string][]) {
		const v = str(raw.texts?.[fileKey], 300);
		if (v) texts[k] = v;
	}
	texts.submit = texts.submit.slice(0, 24);
	texts.close = texts.close.slice(0, 24);
	texts.other = texts.other.slice(0, 75);
	texts.otherLabel = texts.otherLabel.slice(0, 150);
	texts.selectLabel = texts.selectLabel.slice(0, 150);
	const questions: FormQuestion[] = [];
	const seen = new Set<string>();
	for (const q of Array.isArray(raw.questions) ? raw.questions : []) {
		if (questions.length >= MAX_QUESTIONS) break;
		const qid = typeof q?.id === "string" ? q.id : "";
		if (!QUESTION_ID.test(qid) || seen.has(qid)) continue;
		const options: FormOption[] = [];
		const values = new Set<string>();
		for (const o of Array.isArray(q.options) ? q.options : []) {
			if (options.length >= MAX_OPTIONS) break;
			const value = typeof o?.value === "string" ? o.value : "";
			const label = str(o?.label, 75);
			if (!OPTION_VALUE.test(value) || value === OTHER_VALUE || values.has(value) || !label) continue;
			values.add(value);
			options.push({ value, label });
		}
		const title = str(q.title, 2900);
		if (!options.length || !title) continue;
		seen.add(qid);
		const context = str(q.context, 2900);
		const initial = typeof q.initial === "string" && values.has(q.initial) ? q.initial : undefined;
		questions.push({ id: qid, title, ...(context ? { context } : {}), options, ...(initial ? { initial } : {}) });
	}
	if (!questions.length) return null;
	return {
		id,
		title: str(raw.title, 24) || "Questions",
		questions,
		createdAt,
		expiresAt: time(raw.expires_at),
		superseded: raw.superseded === true,
		texts,
	};
}

export function formPath(agentDir: string, formId: string): string {
	return path.join(agentDir, "data", "forms", `${formId}.json`);
}

const AGENT_FILE_MAX = 1024 * 1024;

/**
 * Read a file from an agent's (agent-writable) folder: only a regular file, never through a symlink, a
 * FIFO or a device, opened non-blocking and checked again once open, at most 1 MB. Null otherwise.
 */
export function readAgentFile(file: string): string | null {
	let fd: number | undefined;
	try {
		const before = lstatSync(file);
		if (!before.isFile() || before.size > AGENT_FILE_MAX) return null;
		fd = openSync(file, fsc.O_RDONLY | fsc.O_NONBLOCK | (fsc.O_NOFOLLOW ?? 0));
		const st = fstatSync(fd);
		if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev || st.size > AGENT_FILE_MAX) return null;
		const buf = Buffer.alloc(st.size);
		let off = 0;
		while (off < buf.length) {
			const n = readSync(fd, buf, off, buf.length - off, off);
			if (n <= 0) break;
			off += n;
		}
		return buf.subarray(0, off).toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function loadForm(agentDir: string, formId: string): AgentForm | null {
	if (!FORM_ID.test(formId)) return null;
	try {
		const text = readAgentFile(formPath(agentDir, formId));
		return text === null ? null : parseForm(JSON.parse(text));
	} catch {
		return null;
	}
}

export function isExpired(form: AgentForm, now: number, ttlHours: number): boolean {
	if (form.superseded) return true;
	return now > (form.expiresAt ?? form.createdAt + ttlHours * 3600_000);
}

/** Who may open and submit: config.json "form_answerers", or else the founders in known-users.json. */
export function formAnswerers(agent: { formAnswerers?: string[] }, known: Record<string, { role?: string }>): string[] {
	if (Array.isArray(agent.formAnswerers)) return agent.formAnswerers;
	return Object.entries(known).filter(([, u]) => u?.role === "founder").map(([id]) => id);
}

// ─── The modal ─────────────────────────────────────────────

const mrkdwn = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
const option = (o: FormOption) => ({ text: plain(o.label), value: o.value });

/**
 * The modal for a form. `picks` and `typed` are what the person chose and wrote so far (question id
 * -> value); a question with no pick shows its own initial answer. Block and action ids depend only on
 * the question id, so Slack keeps every input across redraws; the picks are also set explicitly.
 */
export function buildFormView(form: AgentForm, privateMetadata: string, picks: Record<string, string>, typed: Record<string, string>): any {
	const blocks: any[] = [];
	form.questions.forEach((q, i) => {
		if (i > 0) blocks.push({ type: "divider", block_id: `d:${q.id}` });
		blocks.push({ type: "section", block_id: `h:${q.id}`, text: { type: "mrkdwn", text: `*${mrkdwn(q.title.replace(/\*/g, ""))}*` } });
		if (q.context) blocks.push({ type: "context", block_id: `c:${q.id}`, elements: [{ type: "mrkdwn", text: mrkdwn(q.context) }] });
		const otherOption: FormOption = { value: OTHER_VALUE, label: form.texts.other };
		const all = [...q.options, otherOption];
		const pick = q.id in picks ? picks[q.id] : q.initial;
		const chosen = all.find((o) => o.value === pick);
		blocks.push({
			type: "input",
			block_id: `s:${q.id}`,
			optional: true,
			dispatch_action: true,
			label: plain(form.texts.selectLabel),
			element: {
				type: "static_select",
				action_id: SELECT_ACTION,
				options: all.map(option),
				...(chosen ? { initial_option: option(chosen) } : {}),
			},
		});
		if (pick === OTHER_VALUE) {
			blocks.push({
				type: "input",
				block_id: `o:${q.id}`,
				optional: true,
				label: plain(form.texts.otherLabel),
				element: {
					type: "plain_text_input",
					action_id: TEXT_ACTION,
					max_length: 500,
					...(typed[q.id] ? { initial_value: typed[q.id] } : {}),
				},
			});
		}
	});
	return {
		type: "modal",
		callback_id: FORM_CALLBACK,
		private_metadata: privateMetadata,
		title: plain(form.title),
		submit: plain(form.texts.submit),
		close: plain(form.texts.close),
		blocks,
	};
}

/** What the person chose and typed so far, from view.state.values. Only offered values count. */
export function readState(form: AgentForm, values: any): { picks: Record<string, string>; typed: Record<string, string> } {
	const picks: Record<string, string> = {};
	const typed: Record<string, string> = {};
	for (const q of form.questions) {
		const v = values?.[`s:${q.id}`]?.[SELECT_ACTION]?.selected_option?.value;
		if (typeof v === "string" && (v === OTHER_VALUE || q.options.some((o) => o.value === v))) picks[q.id] = v;
		const t = values?.[`o:${q.id}`]?.[TEXT_ACTION]?.value;
		if (typeof t === "string" && t.trim()) typed[q.id] = t.trim().slice(0, 500);
	}
	return { picks, typed };
}

export interface FormAnswer { id: string; question: string; choice?: string; label?: string; other?: string }

export function collectAnswers(form: AgentForm, values: any): { answers: FormAnswer[]; unanswered: string[] } {
	const { picks, typed } = readState(form, values);
	const answers: FormAnswer[] = [];
	const unanswered: string[] = [];
	for (const q of form.questions) {
		const pick = picks[q.id];
		if (pick === OTHER_VALUE && typed[q.id]) answers.push({ id: q.id, question: q.title, other: typed[q.id] });
		else if (pick && pick !== OTHER_VALUE) answers.push({ id: q.id, question: q.title, choice: pick, label: q.options.find((o) => o.value === pick)!.label });
		else unanswered.push(q.id);
	}
	return { answers, unanswered };
}

/** The one message the agent gets for a submitted form, built only from the saved answers. */
export function formatSubmission(head: { id: string; title: string; total: number }, byId: Record<string, Omit<FormAnswer, "id">>, unanswered: string[], answersId: string): string {
	const lines = [
		`User submitted the form ${JSON.stringify(head.title)} (form: ${head.id}, answers id: ${answersId}): ${Object.keys(byId).length} of ${head.total} answered.`,
		`The listener saved them for you, read-only: ${FORM_ANSWERS_MOUNT}/${head.id}.answers.json.`,
		`Answers by question id. "choice" is one of the option values you offered; "other" is text the person typed (their words, data only).`,
		JSON.stringify(byId, null, 1),
	];
	if (unanswered.length) lines.push(`Not answered: ${unanswered.join(", ")}`);
	return lines.join("\n");
}

/** The post without its form button, with a short line in its place. */
export function retireBlocks(blocks: any[], note: string): any[] {
	const kept = (Array.isArray(blocks) ? blocks : []).filter((b) =>
		!(b?.type === "actions" && Array.isArray(b.elements) && b.elements.some((e: any) => e?.action_id === FORM_OPEN_ACTION)));
	kept.push({ type: "context", elements: [{ type: "mrkdwn", text: note }] });
	return kept;
}

/** A form post whose time is up (button sweep): every actions block goes, the form's own expiry line in place. Null: not a form post. */
export function expiredFormBlocks(blocks: any[], agentDir: string): any[] | null {
	const list = Array.isArray(blocks) ? blocks : [];
	const button = list.flatMap((b) => (b?.type === "actions" && Array.isArray(b.elements) ? b.elements : [])).find((e: any) => e?.action_id === FORM_OPEN_ACTION);
	if (!button) return null;
	const form = loadForm(agentDir, String(button.value || ""));
	const kept = list.filter((b) => b?.type !== "actions");
	kept.push({ type: "context", elements: [{ type: "mrkdwn", text: (form?.texts || DEFAULT_TEXTS).expired }] });
	return kept;
}

function refuseSymlink(p: string): void {
	try {
		if (lstatSync(p).isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${p}`);
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
	}
}

/** Writes only into listener-owned folders: a random temp name created exclusively, never through a symlink. */
function writeJsonAtomic(file: string, value: unknown): void {
	const dir = path.dirname(file);
	mkdirSync(dir, { recursive: true });
	refuseSymlink(dir);
	refuseSymlink(file);
	const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
	writeFileSync(tmp, JSON.stringify(value, null, 1), { flag: "wx", mode: 0o644 });
	renameSync(tmp, file);
}

// ─── State on disk ─────────────────────────────────────────

export interface FormState {
	status: "open" | "answered";
	channel: string;
	ts: string;
	text: string;
	blocks: any[];
	openedAt: number;
	answeredAt?: number;
	by?: string;
	answered?: number;
	total?: number;
	title?: string;
	answersId?: string;
	answers?: Record<string, Omit<FormAnswer, "id">>;
	unanswered?: string[];
	replays?: number;
}

export function defaultFormStateFile(): string {
	return process.env.GINNIE_AGENT_FORMS_STATE || path.join(__dirname, "..", "..", "data", "agent-forms.json");
}

/**
 * Which forms were opened and answered, by agent and form id. Entries older than 30 days are dropped.
 * A state file that cannot be read is never treated as empty (that would reopen answered forms): the
 * store is "broken" and every form is refused until someone fixes the file. Each change is written to
 * disk before it is kept in memory.
 */
export class FormStore {
	private entries: Record<string, FormState> = {};
	readonly broken: boolean = false;

	constructor(private file: string, now: () => number = Date.now) {
		if (existsSync(file)) {
			try {
				const parsed = JSON.parse(readFileSync(file, "utf8"));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
				this.entries = parsed;
			} catch (e) {
				this.broken = true;
				console.error(`[agent-forms] ${file} cannot be read (${(e as Error)?.message || e}): forms are refused until it is fixed`);
				return;
			}
		}
		const cutoff = now() - STATE_DAYS * 86400_000;
		const next = { ...this.entries };
		let dropped = false;
		for (const [k, v] of Object.entries(next)) {
			if (!v || (v.answeredAt ?? v.openedAt ?? 0) < cutoff) { delete next[k]; dropped = true; }
		}
		if (dropped) this.commit(next);
	}

	private key(agent: string, formId: string): string { return `${agent}|${formId}`; }

	private commit(next: Record<string, FormState>): void {
		if (this.broken) throw new Error("form state file cannot be read");
		writeJsonAtomic(this.file, next);
		this.entries = next;
	}

	get(agent: string, formId: string): FormState | undefined {
		return this.entries[this.key(agent, formId)];
	}

	markOpened(agent: string, formId: string, msg: { channel: string; ts: string; text: string; blocks: any[] }, at: number = Date.now()): void {
		const k = this.key(agent, formId);
		if (this.entries[k]?.status === "answered") return;
		this.commit({ ...this.entries, [k]: { status: "open", ...msg, openedAt: at } });
	}

	/** False when the form was answered already (a second submit). The answers are in the same write. */
	markAnswered(agent: string, formId: string, info: {
		by: string; total: number; channel: string; ts: string; title: string; answersId: string;
		answers: Record<string, Omit<FormAnswer, "id">>; unanswered: string[];
	}, at: number = Date.now()): boolean {
		const k = this.key(agent, formId);
		const cur = this.entries[k];
		if (cur?.status === "answered") return false;
		this.commit({
			...this.entries,
			[k]: {
				text: cur?.text ?? "", blocks: cur?.blocks ?? [], openedAt: cur?.openedAt ?? at,
				status: "answered", channel: info.channel, ts: info.ts, answeredAt: at, by: info.by,
				answered: Object.keys(info.answers).length, total: info.total, title: info.title,
				answersId: info.answersId, answers: info.answers, unanswered: info.unanswered, replays: 0,
			},
		});
		return true;
	}

	markReplayed(agent: string, formId: string): void {
		const k = this.key(agent, formId);
		const cur = this.entries[k];
		if (!cur) return;
		this.commit({ ...this.entries, [k]: { ...cur, replays: (cur.replays || 0) + 1 } });
	}

	/** This agent's answered forms. */
	answered(agent: string): { formId: string; state: FormState }[] {
		if (this.broken) return [];
		const prefix = `${agent}|`;
		return Object.entries(this.entries).filter(([k, v]) => k.startsWith(prefix) && v?.status === "answered").map(([k, v]) => ({ formId: k.slice(prefix.length), state: v }));
	}
}

// ─── Answers on disk ───────────────────────────────────────
// The answers live in the listener's own state (above), saved in the same write that marks the form
// answered, before Slack hears the submit. The agent gets a copy in a listener-owned folder that is
// mounted read-only into its container (/workspace/form-answers): it can read its answers there but never
// write or forge them. At startup the listener hands the agent again every answered form whose answers id
// the agent has not listed as applied (its own data/forms/applied.json; at most 3 times, for 7 days). The
// message is rebuilt from the saved answers and the sender looked up again: no text from any file is used.

const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const FORM_ANSWERS_MOUNT = "/workspace/form-answers";

export function formsDataDir(): string {
	return process.env.GINNIE_AGENT_FORMS_DIR || path.join(__dirname, "..", "..", "data", "agent-forms");
}

/** The listener-owned folder with one agent's answer copies (mounted read-only at /workspace/form-answers). */
export function formAnswersDir(agentName: string): string | null {
	if (!AGENT_NAME.test(agentName)) return null; // no folder (and no mount) for a name that could leave it
	return path.join(formsDataDir(), agentName);
}

function exportAnswers(agentName: string, formId: string, s: FormState): void {
	const dir = formAnswersDir(agentName);
	if (!dir) throw new Error(`no answers folder for agent name ${JSON.stringify(agentName)}`);
	writeJsonAtomic(path.join(dir, `${formId}.answers.json`), {
		form: formId, answers_id: s.answersId, by: s.by, at: new Date(s.answeredAt || 0).toISOString(),
		title: s.title, total: s.total, answers: s.answers, unanswered: s.unanswered || [],
	});
}

/** The answers ids the agent marked applied (its own file; only ever used to skip a replay). */
function appliedIds(agentDir: string): Set<string> {
	const file = path.join(agentDir, "data", "forms", "applied.json");
	try {
		const text = readAgentFile(file);
		if (text === null) return new Set();
		const ids = JSON.parse(text)?.answers_ids;
		return new Set(Array.isArray(ids) ? ids.filter((x: unknown) => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

/** At listener start: hand the agent again each answered form it has not applied yet. Returns how many. */
export async function replayPendingAnswers(
	deps: Pick<FormDeps, "agent" | "store" | "sender" | "deliver" | "now" | "log">,
	{ maxReplays = 3, maxAgeDays = 7 } = {},
): Promise<number> {
	const log = deps.log || ((l: string) => console.log(l));
	const now = (deps.now || Date.now)();
	const applied = appliedIds(deps.agent.dir);
	let n = 0;
	for (const { formId, state: s } of deps.store.answered(deps.agent.name)) {
		if (!s.answersId || !s.answers || !s.by || !s.channel || !s.ts) continue;
		if (applied.has(s.answersId)) continue;
		if ((s.replays || 0) >= maxReplays || now - (s.answeredAt || 0) > maxAgeDays * 86400_000) continue;
		const who = await deps.sender(s.by);
		if (!who.ok) continue;
		try {
			deps.store.markReplayed(deps.agent.name, formId);
			exportAnswers(deps.agent.name, formId, s);
		} catch (e) {
			log(`[${deps.agent.name}] form ${formId}: not handed over again: ${(e as Error)?.message || e}`);
			continue;
		}
		deps.deliver({
			channel: s.channel, threadTs: s.ts, userId: s.by, senderLine: who.line,
			message: `(Delivered again after a listener restart: skip it if you already applied answers id ${s.answersId}.)\n` +
				formatSubmission({ id: formId, title: s.title || "", total: s.total || 0 }, s.answers, s.unanswered || [], s.answersId),
		});
		log(`[${deps.agent.name}] form ${formId}: answers handed over again (${(s.replays || 0) + 1})`);
		n++;
	}
	return n;
}

/** For the watcher: null when the forms state file reads fine (or does not exist yet), else why not. */
export function formStateProblem(file: string = defaultFormStateFile()): string | null {
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "not a JSON object";
		return null;
	} catch (e) {
		return (e as Error)?.message || String(e);
	}
}

// ─── Open modals ───────────────────────────────────────────
// Redraws of one modal run one after the other, each from every pick made so far (Slack's payload of a
// fast second pick still shows the modal before the first redraw), with the hash of the last redraw.

interface Draft { picks: Record<string, string>; typed: Record<string, string>; shown: string; hash?: string; chain: Promise<void>; at: number }

export class FormDrafts {
	private drafts = new Map<string, Draft>();
	get(viewId: string, init: () => Omit<Draft, "chain" | "at">, now: number): Draft {
		for (const [k, d] of this.drafts) if (now - d.at > 2 * 3600_000) this.drafts.delete(k);
		let d = this.drafts.get(viewId);
		if (!d) { d = { ...init(), chain: Promise.resolve(), at: now }; this.drafts.set(viewId, d); }
		d.at = now;
		return d;
	}
	drop(viewId: string): void { this.drafts.delete(viewId); }
}
const sharedDrafts = new FormDrafts();

// ─── Slack handlers ────────────────────────────────────────

export interface FormDeps {
	agent: { name: string; dir: string; buttonTtlHours: number; slackBotMsgId: string };
	token: string;
	client: {
		views: { open: (args: any) => Promise<any>; update: (args: any) => Promise<any> };
		chat: { postEphemeral: (args: any) => Promise<any>; update: (args: any) => Promise<any> };
	};
	store: FormStore;
	drafts?: FormDrafts;
	/** Local and fast: a click's trigger id is good for about 3 seconds. */
	canAnswer: (userId: string) => boolean;
	/** The sender line for the agent, and whether the sender policy lets this person reach it. */
	sender: (userId: string) => Promise<{ ok: boolean; line: string }>;
	/** Hand the answers to the agent the way a click is handed over (its thread queue). */
	deliver: (msg: { channel: string; threadTs: string; message: string; userId: string; senderLine: string }) => void;
	now?: () => number;
	log?: (line: string) => void;
}

/** A click on a form button, or an action inside a form modal. */
export function isFormInteraction(action: any, body: any): boolean {
	return action?.action_id === FORM_OPEN_ACTION || body?.view?.callback_id === FORM_CALLBACK;
}

interface Meta { f: string; c: string; t: string }
function parseMeta(raw: unknown): Meta | null {
	try {
		const m = JSON.parse(String(raw || ""));
		if (typeof m?.f === "string" && FORM_ID.test(m.f) && typeof m.c === "string" && m.c && typeof m.t === "string" && m.t) return m;
	} catch { /* below */ }
	return null;
}

const fill = (template: string, answered: number, total: number) =>
	template.replace(/\{answered\}/g, String(answered)).replace(/\{total\}/g, String(total));

export async function handleFormInteraction(deps: FormDeps, body: any, action: any): Promise<void> {
	if (body?.view?.callback_id === FORM_CALLBACK) return redrawForm(deps, body, action);
	if (action?.action_id === FORM_OPEN_ACTION) return openForm(deps, body, action);
}

async function openForm(deps: FormDeps, body: any, action: any): Promise<void> {
	const log = deps.log || ((l: string) => console.log(l));
	const now = (deps.now || Date.now)();
	const userId = String(body?.user?.id || "");
	const channel = String(body?.channel?.id || "");
	const ts = String(body?.message?.ts || "");
	if (!channel || !ts) return;
	if (body?.message?.bot_id && body.message.bot_id !== deps.agent.slackBotMsgId) return;
	const formId = String(action?.value || "");
	const form = loadForm(deps.agent.dir, formId);
	const texts = form?.texts || DEFAULT_TEXTS;
	const say = async (text: string) => {
		try {
			await deps.client.chat.postEphemeral({ token: deps.token, channel, user: userId, text });
		} catch (e) {
			log(`[${deps.agent.name}] form ${formId}: ephemeral note failed: ${(e as Error)?.message || e}`);
		}
	};
	if (!deps.canAnswer(userId)) {
		log(`[${deps.agent.name}] form ${formId}: ${userId} may not answer it`);
		return say(texts.notAllowed);
	}
	if (!form) {
		log(`[${deps.agent.name}] form ${formId}: no usable form file`);
		return say(texts.missing);
	}
	if (deps.store.broken) {
		log(`[${deps.agent.name}] form ${formId}: refused, the form state file cannot be read`);
		return say(texts.missing);
	}
	if (deps.store.get(deps.agent.name, form.id)?.status === "answered") return say(texts.already);
	if (isExpired(form, now, deps.agent.buttonTtlHours)) {
		await say(texts.expired);
		try {
			await deps.client.chat.update({ token: deps.token, channel, ts, text: body.message?.text || form.title, blocks: retireBlocks(body.message?.blocks, texts.expired) });
		} catch (e) {
			log(`[${deps.agent.name}] form ${formId}: retiring the expired button failed: ${(e as Error)?.message || e}`);
		}
		return;
	}
	const meta = JSON.stringify({ f: form.id, c: channel, t: ts });
	const view = buildFormView(form, meta, {}, {});
	try {
		await deps.client.views.open({ token: deps.token, trigger_id: body.trigger_id, view });
	} catch (e) {
		log(`[${deps.agent.name}] form ${formId}: views.open failed: ${(e as any)?.data?.error || (e as Error)?.message || e}`);
		return;
	}
	try {
		deps.store.markOpened(deps.agent.name, form.id, { channel, ts, text: String(body.message?.text || ""), blocks: body.message?.blocks || [] }, now);
	} catch (e) {
		log(`[${deps.agent.name}] form ${formId}: could not save the opened post: ${(e as Error)?.message || e}`);
	}
	log(`[${deps.agent.name}] form ${form.id} opened by ${userId} (${form.questions.length} questions)`);
}

const boxesOf = (form: AgentForm, picks: Record<string, string>) =>
	form.questions.filter((x) => (x.id in picks ? picks[x.id] : x.initial) === OTHER_VALUE).map((x) => x.id).join("\n");

async function redrawForm(deps: FormDeps, body: any, action: any): Promise<void> {
	const log = deps.log || ((l: string) => console.log(l));
	const meta = parseMeta(body.view?.private_metadata);
	if (!meta || action?.action_id !== SELECT_ACTION || !body.view?.id) return;
	if (!deps.canAnswer(String(body?.user?.id || ""))) return;
	const form = loadForm(deps.agent.dir, meta.f);
	if (!form) return;
	const drafts = deps.drafts || sharedDrafts;
	const d = drafts.get(String(body.view.id), () => ({
		picks: {}, typed: {}, hash: body.view.hash,
		shown: form.questions.filter((x) => (body.view.blocks || []).some((b: any) => b?.block_id === `o:${x.id}`)).map((x) => x.id).join("\n"),
	}), (deps.now || Date.now)());
	// Merge now, in arrival order: what Slack shows in this payload, then the pick itself.
	const { picks, typed } = readState(form, body.view.state?.values);
	Object.assign(d.picks, picks);
	Object.assign(d.typed, typed);
	const q = form.questions.find((x) => `s:${x.id}` === action.block_id);
	const v = action.selected_option?.value;
	if (q && typeof v === "string" && (v === OTHER_VALUE || q.options.some((o) => o.value === v))) d.picks[q.id] = v;
	d.chain = d.chain.then(async () => {
		const wanted = boxesOf(form, d.picks);
		if (wanted === d.shown) return;
		const view = buildFormView(form, body.view.private_metadata, d.picks, d.typed);
		const update = (hash?: string) => deps.client.views.update({ token: deps.token, view_id: body.view.id, ...(hash ? { hash } : {}), view });
		let res: any;
		try {
			res = await update(d.hash);
		} catch (e) {
			const err = (e as any)?.data?.error || (e as Error)?.message || String(e);
			if (!/hash_conflict/.test(err)) { log(`[${deps.agent.name}] form ${form.id}: views.update failed: ${err}`); return; }
			try {
				res = await update(undefined); // built from every pick so far, so drawing over the newer one loses nothing
			} catch (e2) {
				log(`[${deps.agent.name}] form ${form.id}: views.update failed after a hash conflict: ${(e2 as any)?.data?.error || (e2 as Error)?.message || e2}`);
				return;
			}
		}
		d.shown = wanted;
		d.hash = res?.view?.hash;
	});
	await d.chain;
}

/** view_submission. Delivers at most once per form; the answers are on disk before Slack is answered. */
export async function handleFormSubmit(deps: FormDeps, body: any, ack: (r?: any) => Promise<void>): Promise<void> {
	const log = deps.log || ((l: string) => console.log(l));
	const now = (deps.now || Date.now)();
	const userId = String(body?.user?.id || "");
	const meta = parseMeta(body?.view?.private_metadata);
	const form = meta ? loadForm(deps.agent.dir, meta.f) : null;
	if (!meta || !form) {
		await ack();
		log(`[${deps.agent.name}] form submit without a usable form (${meta?.f || "no metadata"}), ignored`);
		return;
	}
	// Slack shows these notes under the first question and keeps the modal open.
	const note = (text: string) => ack({ response_action: "errors", errors: { [`s:${form.questions[0].id}`]: text } });
	if (!deps.canAnswer(userId)) {
		await ack();
		log(`[${deps.agent.name}] form ${form.id}: submit by ${userId} refused (not an answerer)`);
		return;
	}
	if (deps.store.broken) {
		await note(form.texts.missing);
		log(`[${deps.agent.name}] form ${form.id}: submit refused, the form state file cannot be read`);
		return;
	}
	const state = deps.store.get(deps.agent.name, form.id);
	if (state?.status === "answered") {
		await ack();
		log(`[${deps.agent.name}] form ${form.id}: second submit ignored`);
		return;
	}
	if (isExpired(form, now, deps.agent.buttonTtlHours)) {
		await note(form.texts.expired);
		log(`[${deps.agent.name}] form ${form.id}: submit refused, the form expired or was replaced`);
		return;
	}
	const { answers, unanswered } = collectAnswers(form, body.view.state?.values);
	if (!answers.length) {
		await note(form.texts.empty);
		return;
	}
	const who = await deps.sender(userId);
	if (!who.ok) {
		await ack();
		return;
	}
	const total = form.questions.length;
	const byId: Record<string, Omit<FormAnswer, "id">> = {};
	for (const { id, ...rest } of answers) byId[id] = rest;
	const answersId = randomUUID();
	// One write marks the form answered and keeps the answers (a near-simultaneous second submit sees it).
	try {
		if (!deps.store.markAnswered(deps.agent.name, form.id, { by: userId, total, channel: meta.c, ts: meta.t, title: form.title, answersId, answers: byId, unanswered }, now)) {
			await ack();
			log(`[${deps.agent.name}] form ${form.id}: second submit ignored`);
			return;
		}
	} catch (e) {
		log(`[${deps.agent.name}] form ${form.id}: could not save the answers: ${(e as Error)?.message || e}`);
		await note(form.texts.missing);
		return;
	}
	try {
		exportAnswers(deps.agent.name, form.id, deps.store.get(deps.agent.name, form.id)!);
	} catch (e) {
		// The answers are safe in the state; the next listener start writes the copy again.
		log(`[${deps.agent.name}] form ${form.id}: the agent's read-only copy failed: ${(e as Error)?.message || e}`);
	}
	const message = formatSubmission({ id: form.id, title: form.title, total }, byId, unanswered, answersId);
	await ack();
	if (body.view?.id) (deps.drafts || sharedDrafts).drop(String(body.view.id));
	log(`[${deps.agent.name}] form ${form.id} answered by ${userId}: ${answers.length} of ${total}`);
	deps.deliver({ channel: meta.c, threadTs: meta.t, message, userId, senderLine: who.line });
	// Without the post as it was when opened, leave it alone rather than overwrite its text.
	if (!state?.blocks?.length) {
		log(`[${deps.agent.name}] form ${form.id}: no saved copy of the post, its button stays (the form is answered)`);
		return;
	}
	try {
		await deps.client.chat.update({
			token: deps.token, channel: meta.c, ts: meta.t,
			text: state.text || form.title,
			blocks: retireBlocks(state.blocks, fill(form.texts.answered, answers.length, total)),
		});
	} catch (e) {
		log(`[${deps.agent.name}] form ${form.id}: marking the post answered failed: ${(e as Error)?.message || e}`);
	}
}
