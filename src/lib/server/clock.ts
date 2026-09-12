/**
 * The day boundary.
 *
 * Everything user-facing is a local 'YYYY-MM-DD' string, never a UTC timestamp
 * (Spec §12, timezone row). Keying on the string is what makes a 23- or
 * 25-hour day an ordinary row instead of a special case.
 */

/** Today's date in the given IANA timezone, as 'YYYY-MM-DD'. */
export function localToday(timezone: string, now: Date = new Date()): string {
	// 'en-CA' formats as YYYY-MM-DD, which is the format we store.
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(now);
}

/** Shift a 'YYYY-MM-DD' string by whole days. Calendar arithmetic, no clocks. */
export function addDays(isoDate: string, days: number): string {
	const [y, m, d] = isoDate.split('-').map(Number);
	const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
	return new Date(t).toISOString().slice(0, 10);
}

/** Inclusive day count between two 'YYYY-MM-DD' strings. */
export function daysBetweenInclusive(from: string, to: string): number {
	return daysBetween(from, to) + 1;
}

/** Exclusive day count: how many days you step from `from` to reach `to`. */
export function daysBetween(from: string, to: string): number {
	const [y1, m1, d1] = from.split('-').map(Number);
	const [y2, m2, d2] = to.split('-').map(Number);
	return (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000;
}

/** Day of week for a 'YYYY-MM-DD' string. 0 = Sunday, matching settings. */
export function dayOfWeek(isoDate: string): number {
	const [y, m, d] = isoDate.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
