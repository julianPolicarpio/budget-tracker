/**
 * The streak (Spec §4.6) — deliberately forgiving.
 *
 * It counts *logged days*, not spending days, because the streak's job is to
 * keep the app open nightly (F7). A zero-spend day filed as "nothing tonight"
 * is a full day of streak, and that is intended, not a loophole: Spec §11 says
 * a metric that cannot be gamed is not measuring adherence, and tells you not
 * to "fix" this one.
 *
 * One missed day does not break it if a combined catch-up is filed within 48
 * hours — the pre-authorised lossy catch-up from Method Part V, encoded,
 * because two missed days is where systems die and what kills them is the
 * guilt of the backlog, not the missing data. Two consecutive misses break it,
 * and on a break the app offers exactly one thing: start tonight. There is no
 * backfill flow, because building the backfill flow is building the guilt.
 */

import { addDays } from './clock';

export interface Streak {
	/** Consecutive logged days ending today, or yesterday if today is still open. */
	current: number;
	longest: number;
	loggedToday: boolean;
	/**
	 * Yesterday's date when a single-day gap can still be closed, else null.
	 * Rendering this is what keeps a live streak alive.
	 */
	catchUpDate: string | null;
}

export function computeStreak(loggedDays: Iterable<string>, today: string): Streak {
	const logged = loggedDays instanceof Set ? loggedDays : new Set(loggedDays);
	const loggedToday = logged.has(today);
	const yesterday = addDays(today, -1);

	// Anchor on today once it is filed; until then, yesterday, so the number
	// does not read zero from midnight until bedtime.
	const anchor = loggedToday ? today : logged.has(yesterday) ? yesterday : null;

	let current = 0;
	for (let d = anchor; d !== null && logged.has(d); d = addDays(d, -1)) current++;

	const catchUpDate =
		!logged.has(yesterday) && logged.has(addDays(yesterday, -1)) ? yesterday : null;

	return { current, longest: longestRun(logged), loggedToday, catchUpDate };
}

function longestRun(logged: Set<string>): number {
	let longest = 0;
	for (const day of logged) {
		// Only start counting from the first day of a run, so this stays linear.
		if (logged.has(addDays(day, -1))) continue;
		let run = 0;
		for (let d = day; logged.has(d); d = addDays(d, 1)) run++;
		if (run > longest) longest = run;
	}
	return longest;
}
