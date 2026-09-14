/**
 * Income cadence vocabulary, shared by both sides.
 *
 * Lives outside `$lib/server` for the same reason `subscription-cadence.ts`
 * does: the Accounts page renders these labels in the browser, and importing
 * the server module to reach them would pull better-sqlite3 into the client
 * bundle. SvelteKit blocks that, correctly.
 */

export type IncomeCadence =
	| 'daily'
	| 'weekly'
	| 'biweekly'
	| 'semimonthly'
	| 'monthly'
	| 'irregular';

export const CADENCES: readonly IncomeCadence[] = [
	'daily',
	'weekly',
	'biweekly',
	'semimonthly',
	'monthly',
	'irregular'
];

/**
 * Arrivals per year. **Display only** — never used to derive an allocation.
 *
 * `projectArrivals()` works in dates, because a rate cannot express that a
 * bi-weekly source lands three times in some months. These numbers exist so a
 * person can sanity-check a figure, and the two that matter are next to each
 * other on purpose: 26 and 24 are the pair Spec §4.1 calls "different by ~8%
 * and conflated constantly".
 */
export const ARRIVALS_PER_YEAR: Record<Exclude<IncomeCadence, 'irregular'>, number> = {
	daily: 365,
	weekly: 52,
	biweekly: 26,
	semimonthly: 24,
	monthly: 12
};

/**
 * What each cadence is called on screen.
 *
 * Bi-weekly and semi-monthly are never both described as "twice a month", even
 * though that is how people say them, because that phrase is exactly the
 * conflation that costs 8% a year. Each says what it actually does.
 */
export const CADENCE_LABEL: Record<IncomeCadence, string> = {
	daily: 'Day',
	weekly: 'Week',
	biweekly: '2 weeks',
	semimonthly: 'Twice a month',
	monthly: 'Month',
	irregular: 'No schedule'
};

export function arrivalsPerYear(cadence: string): number | null {
	return cadence in ARRIVALS_PER_YEAR
		? ARRIVALS_PER_YEAR[cadence as Exclude<IncomeCadence, 'irregular'>]
		: null;
}
