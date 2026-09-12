/**
 * Cadence vocabulary, shared by both sides.
 *
 * Lives outside `$lib/server` because the subscriptions page renders these
 * labels in the browser, and importing the server module to reach them would
 * pull better-sqlite3 into the client bundle — SvelteKit blocks that, correctly.
 */

export type Cadence = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

/** Months between charges. No 'one_off' — a charge that happens once is an Irregular. */
export const CADENCE_MONTHS: Record<Cadence, number> = {
	monthly: 1,
	quarterly: 3,
	semiannual: 6,
	annual: 12
};

export const CADENCE_LABELS: Record<Cadence, string> = {
	monthly: 'Monthly',
	quarterly: 'Quarterly',
	semiannual: 'Twice a year',
	annual: 'Yearly'
};

export const CADENCES = Object.keys(CADENCE_LABELS) as Cadence[];

/**
 * How far ahead to warn, by cadence.
 *
 * A fixed 30 days is right for a yearly renewal and nonsense for a monthly
 * one: a monthly charge is never more than ~31 days away, so a 30-day lead
 * means the warning fires the day after you record it and every month
 * thereafter. The lead has to be a fraction of the cycle, not a constant, or
 * it stops being a warning and becomes wallpaper.
 */
export const DEFAULT_LEAD_DAYS: Record<Cadence, number> = {
	monthly: 7,
	quarterly: 14,
	semiannual: 30,
	annual: 30
};
