/**
 * Review weeks.
 *
 * The week is anchored on `settings.week_starts_on`, not on ISO-8601. ISO
 * weeks always start on a Monday, and the money date is a Sunday evening by
 * default (Method Part III) — pinning the artefact to a week the user does not
 * actually live in produces an off-by-one every single review. The label still
 * reads `YYYY-Www` because that is what the summary line says; it just counts
 * from the user's own week start.
 */

import { addDays, dayOfWeek, daysBetween } from './clock';

export interface Week {
	startsOn: string;
	endsOn: string;
	label: string;
}

/** The week containing `date`. */
export function weekOf(date: string, weekStartsOn: number): Week {
	const offset = (dayOfWeek(date) - weekStartsOn + 7) % 7;
	const startsOn = addDays(date, -offset);
	return { startsOn, endsOn: addDays(startsOn, 6), label: weekLabel(startsOn, weekStartsOn) };
}

/**
 * The most recently *finished* week — the one a review covers.
 *
 * Reviewing on Sunday evening covers the week that just ended, and governs the
 * week about to start. Both are true; only the first is data.
 */
export function lastCompleteWeek(today: string, weekStartsOn: number): Week {
	return weekOf(addDays(weekOf(today, weekStartsOn).startsOn, -1), weekStartsOn);
}

/** First date on or after 1 January of `year` that falls on `weekStartsOn`. */
function firstWeekStart(year: number, weekStartsOn: number): string {
	const jan1 = `${year}-01-01`;
	return addDays(jan1, (weekStartsOn - dayOfWeek(jan1) + 7) % 7);
}

/**
 * `YYYY-Www`. Days before the year's first week start belong to the previous
 * year's final week, which is how a 53-week year happens and why the year in
 * the label is not always the year in the date.
 */
export function weekLabel(startsOn: string, weekStartsOn: number): string {
	const year = Number(startsOn.slice(0, 4));
	const thisYear = firstWeekStart(year, weekStartsOn);

	if (startsOn < thisYear) {
		const prev = firstWeekStart(year - 1, weekStartsOn);
		return format(year - 1, Math.floor(daysBetween(prev, startsOn) / 7) + 1);
	}
	return format(year, Math.floor(daysBetween(thisYear, startsOn) / 7) + 1);
}

function format(year: number, n: number): string {
	return `${year}-W${String(n).padStart(2, '0')}`;
}

/** The seven dates of a week, oldest first. */
export function weekDays(week: Week): string[] {
	return Array.from({ length: 7 }, (_, i) => addDays(week.startsOn, i));
}
