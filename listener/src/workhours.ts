/**
 * Work hours enforcement.
 *
 * Each agent's config.json may declare `work_hours` (enabled/start/end/days/
 * off_hours_behavior). When enabled, the listener decides whether to dispatch
 * a message to the agent immediately, queue it for later, ignore it, or post
 * a deferred-response notice — based on the current time in the container TZ.
 */

import type { AgentWorkHours } from "./runner";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function tzNow(tz: string): { day: string; minutes: number } {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const parts = fmt.formatToParts(new Date());
	const weekday = (parts.find((p) => p.type === "weekday")?.value || "").toLowerCase().slice(0, 3);
	const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
	const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
	return { day: weekday, minutes: hour * 60 + minute };
}

function parseHHMM(s: string): number {
	const [h, m] = s.split(":").map((n) => parseInt(n, 10));
	if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
	return h * 60 + m;
}

/**
 * Returns true if `now` falls within the agent's declared working hours.
 * If `enabled` is false, always returns true (no enforcement).
 */
export function isWithinWorkHours(workHours: AgentWorkHours): boolean {
	if (!workHours.enabled) return true;
	const tz = process.env.TZ || "UTC";
	const now = tzNow(tz);
	const allowedDays = new Set(workHours.days.map((d) => d.toLowerCase().slice(0, 3)));
	if (!allowedDays.has(now.day)) return false;
	const startMin = parseHHMM(workHours.start);
	const endMin = parseHHMM(workHours.end);
	if (startMin <= endMin) {
		return now.minutes >= startMin && now.minutes < endMin;
	}
	// overnight window (end < start) — allow wrap-around
	return now.minutes >= startMin || now.minutes < endMin;
}

/** Format a one-line off-hours notice for the agent's Slack channel. */
export function offHoursNotice(workHours: AgentWorkHours): string {
	const tz = process.env.TZ || "UTC";
	return `_(off-hours — back at ${workHours.start} ${tz}, days ${workHours.days.join("/")})_`;
}

// Re-exported for tests / external introspection.
export const _internal = { tzNow, parseHHMM, DAY_NAMES };
