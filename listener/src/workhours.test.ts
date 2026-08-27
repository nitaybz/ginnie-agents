/**
 * Tests for work-hours window evaluation.
 *
 * The documented contract (framework/skills + .claude/skills/manage-work-hours,
 * ARCHITECTURE.md "Work hours") is:
 *
 *   - `days` lists the days the agent works.
 *   - `start`/`end` are HH:MM in the listener TZ.
 *   - "If `end < start`, the window wraps midnight (e.g. start 22:00, end 06:00
 *     means a night shift)."
 *
 * A night shift is named by the day it STARTS. A Mon–Fri 22:00–06:00 shift is
 * five shifts: Mon 22:00→Tue 06:00 … Fri 22:00→Sat 06:00. Saturday 02:00 is
 * inside the Friday shift even though "sat" is not in `days`, and Monday 02:00
 * is NOT inside any shift because the Sunday-night shift never started.
 *
 * Run: cd listener && npx tsc && node --test dist/workhours.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isWithinWorkHours, offHoursNotice } from "./workhours";
import type { AgentWorkHours } from "./runner";

process.env.TZ = "UTC";

function wh(over: Partial<AgentWorkHours> = {}): AgentWorkHours {
	return {
		enabled: true,
		start: "09:00",
		end: "18:00",
		days: ["mon", "tue", "wed", "thu", "fri"],
		off_hours_behavior: "queue",
		...over,
	};
}

// Anchor dates, all UTC. Verified weekdays:
//   2026-05-08 Friday, 2026-05-09 Saturday, 2026-05-10 Sunday, 2026-05-11 Monday
function at(iso: string): Date {
	return new Date(iso);
}

describe("isWithinWorkHours — disabled", () => {
	test("enabled:false always returns true", () => {
		assert.equal(isWithinWorkHours(wh({ enabled: false }), at("2026-05-09T03:00:00Z")), true);
	});
});

describe("isWithinWorkHours — normal daytime window (start < end)", () => {
	test("inside the window on a work day", () => {
		assert.equal(isWithinWorkHours(wh(), at("2026-05-11T10:00:00Z")), true);
	});

	test("before start on a work day", () => {
		assert.equal(isWithinWorkHours(wh(), at("2026-05-11T08:59:00Z")), false);
	});

	test("end is exclusive", () => {
		assert.equal(isWithinWorkHours(wh(), at("2026-05-11T18:00:00Z")), false);
	});

	test("non-work day inside the clock window", () => {
		assert.equal(isWithinWorkHours(wh(), at("2026-05-09T10:00:00Z")), false);
	});
});

describe("isWithinWorkHours — overnight window (end < start)", () => {
	const night = wh({ start: "22:00", end: "06:00" });

	test("Friday 23:00 is inside the Friday-night shift", () => {
		assert.equal(isWithinWorkHours(night, at("2026-05-08T23:00:00Z")), true);
	});

	test("Saturday 02:00 is inside the Friday-night shift, even though sat is not a work day", () => {
		assert.equal(isWithinWorkHours(night, at("2026-05-09T02:00:00Z")), true);
	});

	test("Saturday 07:00 is after the Friday-night shift ended", () => {
		assert.equal(isWithinWorkHours(night, at("2026-05-09T07:00:00Z")), false);
	});

	test("Saturday 23:00 is not a shift — sat is not a work day", () => {
		assert.equal(isWithinWorkHours(night, at("2026-05-09T23:00:00Z")), false);
	});

	test("Monday 02:00 is NOT a shift — the Sunday-night shift never started", () => {
		assert.equal(isWithinWorkHours(night, at("2026-05-11T02:00:00Z")), false);
	});

	test("Monday 22:30 starts the Monday-night shift", () => {
		assert.equal(isWithinWorkHours(night, at("2026-05-11T22:30:00Z")), true);
	});

	test("Tuesday 05:59 is still inside the Monday-night shift", () => {
		assert.equal(isWithinWorkHours(night, at("2026-05-12T05:59:00Z")), true);
	});

	test("Tuesday 06:00 — end is exclusive", () => {
		assert.equal(isWithinWorkHours(night, at("2026-05-12T06:00:00Z")), false);
	});
});

describe("isWithinWorkHours — full-day window (start === end)", () => {
	test("start === end is treated as a zero-length window, never open", () => {
		const w = wh({ start: "09:00", end: "09:00" });
		assert.equal(isWithinWorkHours(w, at("2026-05-11T09:00:00Z")), false);
		assert.equal(isWithinWorkHours(w, at("2026-05-11T12:00:00Z")), false);
	});
});

describe("offHoursNotice", () => {
	test("mentions the return time and the work days", () => {
		const msg = offHoursNotice(wh({ start: "09:00", days: ["mon", "tue"] }));
		assert.match(msg, /09:00/);
		assert.match(msg, /mon\/tue/);
	});
});
