#!/usr/bin/env node
// Shared Ginnie Studio link for agents that open developer tasks themselves (Adam, Shai).
// Nitay 2026-11-23: Adam and Shai open dev tasks in Studio directly, not through Sally.
// The logic is ./studio-core.mjs, a byte-identical copy of Omer's (agents/omer/skills/studio-tasks);
// only the agent's wording, title prefix, idempotency key and the way Nitay hears about it live here.
//
// Mounted read-only in every agent container at /workspace/.framework/skills/studio-tasks.
//
//   node studio.mjs projects                                       Studio projects this key can see
//   node studio.mjs open --project <slug> --title "<t>" --body-file <f> [--nitay "<Hebrew>"]
//   node studio.mjs check                                          new Studio replies (news)
//   node studio.mjs pending | list
//   node studio.mjs reply --id <id> --text "<answer>"              answer Studio in its chat
//   node studio.mjs skip  --id <id>                                nothing worth telling
//   node studio.mjs tell|ask --id <id> --text "<Hebrew>"           Shai only: one line to Nitay through Adam
// The agent comes from --agent or $AGENT_NAME (set by the listener).
//
// Key: each agent has its own Studio access key, created by Nitay only, in that agent's
// credentials.json as "studio_mcp_token". Never printed. State: /workspace/data/studio-tasks.json.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import * as core from "./studio-core.mjs";

const PROFILES = {
	adam: { name: "Adam", role: "office agent: books, iCount, office mail, suppliers", he: "אדם", relay: false },
	shai: { name: "Shai", role: "SmartShop customer and shop-orders agent", he: "שי", relay: true },
};

export function buildStudioMessage(profile, { title, body, slackLink }) {
	return [
		`Developer task from ${profile.displayName} (${profile.role}): ${title}`,
		"",
		String(body || "").trim(),
		...(slackLink ? ["", `Context: ${slackLink}`] : []),
		"",
		`If you need anything (data, examples, a decision), reply here and ${profile.displayName} will answer or ask Nitay.`,
		`${profile.displayName} reads your replies regularly and tells Nitay what you did.`,
		"When it is done, merged and deployed, end your final message with a line that starts with",
		"STUDIO-STATUS, a colon, and then the word FIXED. If you decide it needs no change, use WONTFIX",
		"instead, followed by one short reason.",
	].join("\n");
}

export function profileFor(agent) {
	const p = PROFILES[String(agent || "").toLowerCase()];
	if (!p) throw new Error(`studio-tasks: unknown agent "${agent}" (use adam or shai)`);
	const key = String(agent).toLowerCase();
	const profile = {
		agent: key,
		displayName: p.name,
		role: p.role,
		relay: p.relay,
		logTag: `studio-tasks(${key})`,
		stateFile: "/workspace/data/studio-tasks.json",
		titlePrefix: p.name,
		keyPrefix: `${key}-task`,
		defaultOpenText: (title) => `פתחתי משימה למפתחים ב-Studio: ${core.plainLine(title)}`,
		statusNote: (bug, status) => (status === "fixed" ? `Studio says it is fixed: ${bug.title}.` : `Studio closed it as won't fix: ${bug.title}.`),
		alertLine: (errors) => `${p.name}: Studio check failed for ${errors.length} task(s): ${errors[0].replace(/\s+/g, " ").slice(0, 200)}`,
		noTokenMessage: `studio-tasks: no Studio key for ${p.name}. Nitay creates one in Studio and pastes it into agents/${key}/credentials.json as "studio_mcp_token". Until then tell Nitay in one plain line that the Studio key is missing.`,
	};
	profile.buildStudioMessage = (m) => buildStudioMessage(profile, m);
	return profile;
}

// The core keys a task by a Slack message. A task opened without one gets a stable stand-in from its
// title, so the same task is never opened twice.
export function anchorFor(title) {
	return { channel: "no-slack", ts: createHash("sha256").update(String(title)).digest("hex").slice(0, 16), permalink: null };
}

// Adam tells Nitay himself in WhatsApp, so his config has no Slack relay (a relay would go to himself).
export function configFrom(profile, credsFile) {
	const creds = credsFile && existsSync(credsFile) ? JSON.parse(readFileSync(credsFile, "utf8")) : {};
	const mcpUrl = creds.studio_mcp_url || core.DEFAULT_MCP_URL;
	return {
		mcpUrl,
		token: creds.studio_mcp_token || process.env.STUDIO_MCP_TOKEN || null,
		origin: new URL(mcpUrl).origin,
		alertChannel: profile.relay ? creds.alert_slack_user || core.NITAY_SLACK_ID : null,
		slackToken: profile.relay ? creds.slack_bot_token || null : null,
		handoffChannel: profile.relay ? creds.handoff_channel || null : null,
	};
}

export async function openTask(profile, cfg, stateFile, { project, title, body, nitayText = null, slack = null }, fetchFn = fetch) {
	return core.openBug(profile, cfg, stateFile, { project, title, body, nitayText, slack: slack || anchorFor(title) }, fetchFn);
}

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
		else out._.push(argv[i]);
	}
	return out;
}
const str = (v) => (v && v !== true ? String(v) : null);

async function main(argv) {
	const a = parseArgs(argv);
	const profile = profileFor(str(a.agent) || process.env.AGENT_NAME);
	const credsFile = str(a.creds) || "/workspace/credentials.json";
	const cfg = configFrom(profile, credsFile);
	const stateFile = str(a.state) || profile.stateFile;
	const cmd = a._[0];
	const print = (o) => console.log(JSON.stringify(o, null, 2));
	if (cmd === "list") return print(core.loadState(stateFile));
	if (cmd === "pending") return print(core.pendingWork(stateFile));
	if (cmd === "skip") return print(core.skipItems(stateFile, { id: str(a.id), keys: str(a.keys)?.split(",") || null }));
	if ((cmd === "tell" || cmd === "ask") && !profile.relay) {
		console.error(`${profile.logTag}: ${profile.displayName} tells Nitay himself (WhatsApp); tell/ask are for agents that go through Adam.`);
		process.exit(2);
	}
	if (cmd === "tell" || cmd === "ask") {
		const text = str(a["text-file"]) ? readFileSync(a["text-file"], "utf8") : str(a.text);
		return print(await (cmd === "tell" ? core.tellNitay : core.askNitay)(cfg, stateFile, { id: str(a.id), text, keys: str(a.keys)?.split(",") || null }));
	}
	if (!cfg.token) { console.error(profile.noTokenMessage); process.exit(3); }
	if (cmd === "projects") return print(await core.mcpCall(cfg, "list_projects", {}));
	if (cmd === "open") {
		for (const k of ["project", "title", "body-file"]) if (!str(a[k])) throw new Error(`open: --${k} is required`);
		const slack = str(a.channel) && str(a.ts) ? { channel: a.channel, ts: a.ts, permalink: str(a.permalink) } : null;
		const rec = await openTask(profile, cfg, stateFile, { project: a.project, title: a.title, body: readFileSync(a["body-file"], "utf8"), nitayText: str(a.nitay), slack });
		return print(rec);
	}
	if (cmd === "check") {
		const res = await core.checkBugs(profile, cfg, stateFile, { post: false });
		print({ news: res.news, answers: res.answers, errors: res.errors, warnings: res.warnings, open: res.open });
		if (res.errors.length) process.exitCode = 4;
		return;
	}
	if (cmd === "reply") {
		const text = str(a["text-file"]) ? readFileSync(a["text-file"], "utf8") : str(a.text);
		return print(await core.replyStudio(profile, cfg, stateFile, { id: str(a.id), text, keys: str(a.keys)?.split(",") || null, answer: !!a.answer }));
	}
	console.error("usage: studio.mjs projects | open --project <slug> --title \"..\" --body-file <f> [--nitay \"..\"] | check | pending | list | reply --id <id> --text \"..\" | skip --id <id> | tell|ask (Shai only)");
	process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((e) => { console.error(`studio-tasks: ${e.message}`); process.exit(1); });
}
