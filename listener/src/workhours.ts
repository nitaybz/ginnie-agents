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

function tzNow(tz: string, at: Date = new Date()): { day: string; minutes: number } {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const parts = fmt.formatToParts(at);
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

/** The day abbreviation before `day` ("mon" -> "sun"). Returns "" if unknown. */
function previousDay(day: string): string {
	const idx = DAY_NAMES.indexOf(day);
	if (idx < 0) return "";
	return DAY_NAMES[(idx + DAY_NAMES.length - 1) % DAY_NAMES.length];
}

/**
 * Returns true if `now` falls within the agent's declared working hours.
 * If `enabled` is false, always returns true (no enforcement).
 *
 * `days` names the day a shift STARTS on. That distinction only matters for an
 * overnight window (`end` < `start`, e.g. 22:00–06:00): a Mon–Fri night shift
 * runs Fri 22:00 → Sat 06:00, so Saturday 02:00 is inside it even though "sat"
 * is not in `days`; and Monday 02:00 is outside it, because the Sunday-night
 * shift never started. Gating on the current calendar day alone gets both of
 * those backwards.
 */
export function isWithinWorkHours(workHours: AgentWorkHours, at: Date = new Date()): boolean {
	if (!workHours.enabled) return true;
	const tz = process.env.TZ || "UTC";
	const now = tzNow(tz, at);
	const allowedDays = new Set(workHours.days.map((d) => d.toLowerCase().slice(0, 3)));
	const startMin = parseHHMM(workHours.start);
	const endMin = parseHHMM(workHours.end);

	if (startMin <= endMin) {
		// Same-day window. The shift starts and ends today.
		if (!allowedDays.has(now.day)) return false;
		return now.minutes >= startMin && now.minutes < endMin;
	}

	// Overnight window. Attribute the moment to the day its shift began.
	if (now.minutes >= startMin) return allowedDays.has(now.day);
	if (now.minutes < endMin) return allowedDays.has(previousDay(now.day));
	return false;
}

/** Format a one-line off-hours notice for the agent's Slack channel. */
export function offHoursNotice(workHours: AgentWorkHours): string {
	const tz = process.env.TZ || "UTC";
	return `_(off-hours — back at ${workHours.start} ${tz}, days ${workHours.days.join("/")})_`;
}

// Re-exported for tests / external introspection.
export const _internal = { tzNow, parseHHMM, previousDay, DAY_NAMES };
