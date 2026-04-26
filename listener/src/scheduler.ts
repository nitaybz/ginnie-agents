/**
 * Agent Scheduler — reads each agent's schedules.json and fires routines
 * at scheduled times. Timezone defaults to UTC; override globally with the
 * `TZ` env var. Watches files for changes so agents can modify their own
 * schedules at runtime.
 */

import cron, { ScheduledTask } from "node-cron";
import { readFileSync, existsSync, watch } from "fs";
import path from "path";
import type { AgentConfig } from "./runner";

interface ScheduleEntry {
	id: string;
	cron: string;
	message: string;
	description?: string;
	enabled?: boolean;
}

interface AgentSchedules {
	schedules: ScheduleEntry[];
}

// Tracks active scheduled tasks per agent
const activeTasks = new Map<string, Map<string, ScheduledTask>>();

export function loadAgentSchedules(
	agent: AgentConfig,
	onFire: (agent: AgentConfig, entry: ScheduleEntry) => void,
): void {
	const schedulesPath = path.join(agent.dir, "schedules.json");

	// Clear any existing tasks for this agent
	const existing = activeTasks.get(agent.name);
	if (existing) {
		for (const task of existing.values()) task.stop();
		existing.clear();
	}
	activeTasks.set(agent.name, new Map());

	if (!existsSync(schedulesPath)) {
		console.log(`[scheduler] ${agent.name}: no schedules.json (no routines)`);
		return;
	}

	let data: AgentSchedules;
	try {
		data = JSON.parse(readFileSync(schedulesPath, "utf-8"));
	} catch (err) {
		console.error(`[scheduler] ${agent.name}: failed to parse schedules.json:`, err);
		return;
	}

	if (!Array.isArray(data.schedules)) {
		console.error(`[scheduler] ${agent.name}: schedules.json missing "schedules" array`);
		return;
	}

	const tasks = activeTasks.get(agent.name)!;

	for (const entry of data.schedules) {
		if (entry.enabled === false) continue;
		if (!entry.cron || !entry.message || !entry.id) {
			console.warn(`[scheduler] ${agent.name}: skipping invalid entry`, entry);
			continue;
		}

		if (!cron.validate(entry.cron)) {
			console.error(`[scheduler] ${agent.name}: invalid cron expression "${entry.cron}" for ${entry.id}`);
			continue;
		}

		try {
			const tz = process.env.TZ || "UTC";
			const task = cron.schedule(
				entry.cron,
				() => {
					console.log(`[scheduler] ${agent.name}: firing "${entry.id}" (${entry.description || entry.cron})`);
					onFire(agent, entry);
				},
				{ timezone: tz } as any,
			);
			tasks.set(entry.id, task);
			console.log(`[scheduler] ${agent.name}: loaded "${entry.id}" @ ${entry.cron} ${tz}`);
		} catch (err) {
			console.error(`[scheduler] ${agent.name}: failed to schedule ${entry.id}:`, err);
		}
	}
}

/** Watch each agent's schedules.json for changes and reload automatically */
export function watchAgentSchedules(
	agent: AgentConfig,
	onFire: (agent: AgentConfig, entry: ScheduleEntry) => void,
): void {
	const schedulesPath = path.join(agent.dir, "schedules.json");

	// Watch the agent directory for schedules.json changes
	// (fs.watch on the file itself doesn't survive edits via rename/move)
	try {
		watch(agent.dir, (_eventType, filename) => {
			if (filename === "schedules.json") {
				// Debounce — file edits often trigger multiple events
				setTimeout(() => {
					console.log(`[scheduler] ${agent.name}: schedules.json changed, reloading...`);
					loadAgentSchedules(agent, onFire);
				}, 500);
			}
		});
	} catch (err) {
		console.error(`[scheduler] ${agent.name}: failed to watch directory:`, err);
	}
}

export type { ScheduleEntry };
