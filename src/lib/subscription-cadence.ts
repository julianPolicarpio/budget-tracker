/**
 * Cadence vocabulary, shared by both sides.
 *
 * Lives outside `$lib/server` because the subscriptions page renders these
 * labels in the browser, and importing the server module to reach them would
 * pull better-sqlite3 into the client bundle — SvelteKit blocks that, correctly.
 */

export type Cadence = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';

/**
 * Cadence acquires a kind (Spec §5.1).
 *
 * A whole-months divisor (the old `CADENCE_MONTHS`) cannot express a weekly or
 * fortnightly cycle without producing a fractional month index, and every
 * consumer of that figure — `advanceCharge()`, `annualisedMinor()`,
 * `commitmentsPerPeriod()` — divided by it. Day-based cadences advance with
 * `addDays` and never touch a month at all; calendar-based ones keep
 * `addMonths`. There is deliberately no shared divisor between the two kinds:
 * that shared divisor is the bug this table replaces.
 *
 * `CADENCE_MONTHS` is gone, not kept alongside — two sources of truth for one
 * fact is how the fractional-month bug comes back.
 */
export type CadenceKind = 'days' | 'months';

export const CADENCE_STEP: Record<Cadence, { kind: CadenceKind; n: number }> = {
	weekly: { kind: 'days', n: 7 },
	fortnightly: { kind: 'days', n: 14 },
	monthly: { kind: 'months', n: 1 },
	quarterly: { kind: 'months', n: 3 },
	semiannual: { kind: 'months', n: 6 },
	annual: { kind: 'months', n: 12 }
};

export const CADENCE_LABELS: Record<Cadence, string> = {
	weekly: 'Weekly',
	fortnightly: 'Fortnightly',
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
 *
 * Weekly and fortnightly carry the same reasoning taken further: a lead of
 * 1 and 2 days respectively is proportionally similar to the monthly lead
 * (roughly a quarter of the cycle) and cannot be 0 — `migrations/0005`
 * declares `CHECK (lead_days > 0)`. Silencing a weekly commitment is not that
 * column's job anyway: `pendingAlerts()` only alerts when `cancelByOn` is
 * set, so a non-negotiable with no cancel-by date never alerts regardless of
 * lead.
 */
export const DEFAULT_LEAD_DAYS: Record<Cadence, number> = {
	weekly: 1,
	fortnightly: 2,
	monthly: 7,
	quarterly: 14,
	semiannual: 30,
	annual: 30
};
