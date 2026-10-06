/**
 * Income sources, and the two honest paths that come from them.
 *
 * Invariant 7 names `projectArrivals()` as the only path to a claim about
 * arrival DATES, and this file is where it lives. Until it existed,
 * `projectArrivals()` was only a warning in a comment about a function nobody
 * had written, which is why `spend_alloc_minor` had to be hand-typed at setup
 * and three of the five transfer instructions on the
 * Accounts page were never computed.
 *
 * Spec §3.3 adds a second path, deliberately, after the first version of this
 * file's allocation logic got it wrong: `sustainableIncomeMinor()` derives the
 * daily band from each source's own cycle length rather than from arrivals
 * landing inside a window, because a fortnightly salary against a seven-day
 * window holds one whole arrival or none, and the old approach made the
 * allocation depend on which week the user signed up. That is not a violation
 * of invariant 7 — it is still `projectArrivals()`'s job to say what date an
 * arrival lands on, and `sustainableIncomeMinor()` never makes that claim. It
 * answers a different question: what can be spent per day, not when money
 * shows up.
 *
 * ── The rule the whole file exists to protect ───────────────────────────
 *
 * **Never multiply or divide an income figure by 12.** Pay cycles do not
 * divide the year evenly:
 *
 *   weekly       52 arrivals
 *   biweekly     26   every 14 DAYS, drifts, lands 3x in some months
 *   semimonthly  24   two fixed DATES, never drifts
 *   monthly      12
 *
 * Spec §4.1 calls bi-weekly versus semi-monthly "different by ~8% and
 * conflated constantly, including by people who have been paid bi-weekly for a
 * decade". Treating 26 as 24 understates a year's income by roughly a month's
 * worth of one paycheque, and every allocation built on it is quietly too
 * small, for ever, with nothing to show that it is. `sustainableIncomeMinor()`
 * keeps the same ~8% distinction alive through cycle length (14 days versus
 * 15.22) instead of arrival count — see its own docstring below.
 *
 * For anything that asks "what lands, and when," arrivals are PROJECTED as
 * dates, never derived from a rate. A window's expectation is the sum of the
 * arrivals that actually land in it — which is why bi-weekly correctly
 * produces a three-paycheque month twice a year instead of averaging it away.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { forUser, schema } from './db';
import { addDays, daysBetweenInclusive } from './clock';

export type IncomeCadence =
	| 'daily'
	| 'weekly'
	| 'biweekly'
	| 'semimonthly'
	| 'monthly'
	| 'irregular';

export type IncomeSource = typeof schema.incomeSource.$inferSelect;

export interface Arrival {
	/** YYYY-MM-DD, inside the requested window. */
	on: string;
	amountMinor: number;
	sourceId: number;
	label: string;
}

/** Arrivals per year, for display only. Never used to derive an allocation. */
export const ARRIVALS_PER_YEAR: Record<Exclude<IncomeCadence, 'irregular'>, number> = {
	daily: 365,
	weekly: 52,
	biweekly: 26,
	semimonthly: 24,
	monthly: 12
};

export const CADENCES: readonly string[] = [
	'daily',
	'weekly',
	'biweekly',
	'semimonthly',
	'monthly',
	'irregular'
];

export interface NewIncomeSource {
	label: string;
	amountMinor: number;
	cadence: string;
	anchorOn: string | null;
	secondDay: number | null;
	baselineMinor: number | null;
}

export function addIncomeSource(userId: number, input: NewIncomeSource, now = new Date()): number {
	const { db } = forUser(userId);
	const row = db
		.insert(schema.incomeSource)
		.values({ ...input, createdAt: now.toISOString(), userId })
		.returning({ id: schema.incomeSource.id })
		.get();
	return row.id;
}

/** Archived, never deleted: a past allocation was derived from it. */
export function archiveIncomeSource(userId: number, id: number, now = new Date()): void {
	const { db, owns } = forUser(userId);
	db.update(schema.incomeSource)
		.set({ archivedAt: now.toISOString() })
		.where(and(owns(schema.incomeSource), eq(schema.incomeSource.id, id)))
		.run();
}

export function listIncomeSources(userId: number, includeArchived = false): IncomeSource[] {
	const { db, owns } = forUser(userId);
	const q = db.select().from(schema.incomeSource);
	return includeArchived
		? q.where(owns(schema.incomeSource)).all()
		: q.where(and(owns(schema.incomeSource), isNull(schema.incomeSource.archivedAt))).all();
}

/** Last day of the month containing `iso`. */
function lastDayOfMonth(year: number, month1: number): number {
	return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * A day-of-month clamped to a month that is shorter than it.
 *
 * 31 means "the last day", because February has no 31st and a pay date does
 * not skip a month. Silently dropping that arrival is the failure this
 * prevents, and it is invisible: the total is simply lower.
 */
function dateOn(year: number, month1: number, day: number): string {
	const d = Math.min(day, lastDayOfMonth(year, month1));
	return `${year}-${String(month1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Every arrival from every live source landing in `[from, to]`, ordered.
 *
 * Dates, not a rate. See the module comment for why that distinction is the
 * whole point of this file.
 */
export function projectArrivals(userId: number, from: string, to: string): Arrival[] {
	const out: Arrival[] = [];

	for (const s of listIncomeSources(userId)) {
		const cadence = s.cadence as IncomeCadence;

		// Irregular income has no schedule at all, so it produces no dated
		// arrivals. It reaches an expectation through `expectedIncome()`, using
		// the lowest of the last three months (Rule 1) rather than a guess.
		if (cadence === 'irregular' || !s.anchorOn) continue;

		if (cadence === 'daily' || cadence === 'weekly' || cadence === 'biweekly') {
			// DAY-STEPPED. These drift through the calendar on purpose: a
			// bi-weekly source genuinely lands three times in some months, and
			// averaging that away is the 8% error.
			const step = cadence === 'daily' ? 1 : cadence === 'weekly' ? 7 : 14;

			// Walk forward from the anchor to the window rather than looping from
			// the anchor itself, which could be years back.
			let d = s.anchorOn;
			if (d < from) {
				const gap = daysBetweenInclusive(d, from) - 1;
				d = addDays(d, Math.floor(gap / step) * step);
				while (d < from) d = addDays(d, step);
			}
			for (; d <= to; d = addDays(d, step)) {
				out.push({ on: d, amountMinor: s.amountMinor, sourceId: s.id, label: s.label });
			}
			continue;
		}

		// DATE-REPEATED. Same day-of-month every month, so these never drift.
		const days =
			cadence === 'semimonthly'
				? [Number(s.anchorOn.slice(8, 10)), s.secondDay!].sort((a, b) => a - b)
				: [Number(s.anchorOn.slice(8, 10))];

		let year = Number(from.slice(0, 4));
		let month = Number(from.slice(5, 7));
		const endYear = Number(to.slice(0, 4));
		const endMonth = Number(to.slice(5, 7));

		while (year < endYear || (year === endYear && month <= endMonth)) {
			for (const day of days) {
				const on = dateOn(year, month, day);
				if (on >= from && on <= to && on >= s.anchorOn) {
					out.push({ on, amountMinor: s.amountMinor, sourceId: s.id, label: s.label });
				}
			}
			month += 1;
			if (month > 12) {
				month = 1;
				year += 1;
			}
		}
	}

	return out.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
}

/**
 * Average days in a month. Used for irregular baselines below, and by
 * `sustainableIncomeMinor()` and `monthlyToWindowMinor()` further down.
 */
const AVG_DAYS_PER_MONTH = 365.25 / 12;

/**
 * What to expect in `[from, to]`.
 *
 * Scheduled sources contribute the arrivals that actually land in the window.
 * Irregular ones contribute their baseline, pro-rated by days.
 *
 * That pro-rating is NOT the conversion invariant 7 forbids. The forbidden one
 * turns a per-arrival figure into a yearly one by assuming pay cycles divide
 * the year evenly. `baseline_minor` is already a monthly figure by definition
 * — the lowest of the last three months — so scaling it by days is the same
 * arithmetic `commitmentsPerPeriod()` does for a monthly bill, and it makes no
 * claim about arrival dates because an irregular source has none.
 *
 * An irregular source with no baseline yet contributes NOTHING. Three months
 * of history is the price of budgeting on it, and a guess in the meantime
 * would be an allocation built on a number nobody has observed.
 */
export function expectedIncome(userId: number, from: string, to: string): number {
	const scheduled = projectArrivals(userId, from, to).reduce((sum, a) => sum + a.amountMinor, 0);

	const days = daysBetweenInclusive(from, to);
	const irregular = listIncomeSources(userId)
		.filter((s) => s.cadence === 'irregular' && s.baselineMinor !== null)
		.reduce((sum, s) => sum + (s.baselineMinor! * days) / AVG_DAYS_PER_MONTH, 0);

	return scheduled + Math.round(irregular);
}

/**
 * Days per cycle, per cadence.
 *
 * Fortnightly is 14. Twice-monthly is 365.25/24 = 15.22. That ~8% gap is the
 * distinction Spec §4.1 says is "conflated constantly, including by people who
 * have been paid bi-weekly for a decade" — it survives here because each
 * cadence carries its own real cycle length, not a shared monthly assumption.
 */
const CADENCE_DAYS: Record<Exclude<IncomeCadence, 'irregular'>, number> = {
	daily: 1,
	weekly: 7,
	biweekly: 14,
	semimonthly: AVG_DAYS_PER_MONTH / 2,
	monthly: AVG_DAYS_PER_MONTH
};

/**
 * What can be spent per day, sustainably, expressed over `windowDays`.
 *
 * NOT the same question as `expectedIncome()`, and the difference is the whole
 * reason this exists. `expectedIncome()` answers "what money actually lands in
 * this window" — the Accounts page needs that unsmoothed, because three
 * paycheques in a month means three transfers and averaging would misstate
 * where the money physically is.
 *
 * An ALLOCATION needs the opposite. A fortnightly salary against a seven-day
 * window holds one whole arrival or none, never half, so deriving the band
 * from arrivals-in-window made the daily figure depend on which week the user
 * happened to sign up: roughly double if it contained a payday, exactly zero
 * if it did not. `openNext()` copies `spend_alloc_minor` forward verbatim, so
 * that first figure would have stood for the life of the account.
 *
 * So this reads each source's own cycle instead of the calendar. Invariant 7
 * holds: `ARRIVALS_PER_YEAR` is still display-only and unused here, and
 * `projectArrivals()` remains the only path to any claim about arrival DATES.
 */
export function sustainableIncomeMinor(userId: number, windowDays: number): number {
	let perDay = 0;

	for (const s of listIncomeSources(userId)) {
		if (s.cadence === 'irregular') {
			// Three months of history is the price of budgeting on an irregular
			// source; until then it contributes nothing, exactly as it does in
			// expectedIncome(). A guess here would be an allocation built on a
			// figure nobody has observed.
			if (s.baselineMinor !== null) perDay += s.baselineMinor / AVG_DAYS_PER_MONTH;
			continue;
		}

		// `IncomeSource.cadence` is typed `string`, so the cast below is load-
		// bearing: nothing at the type level stops a cadence outside
		// `CADENCE_DAYS` from reaching this point. `income_source`'s CHECK
		// constraint (migration 0014) makes it unreachable today — it lists
		// exactly the six cadences `CADENCE_DAYS` plus 'irregular' cover — but
		// 0010 previously widened two other tables' cadence CHECKs, so a future
		// migration doing the same here is not far-fetched. A silent `if
		// (cycleDays)` would drop the source instead: the band comes out too
		// small, frozen for the life of the account by `openNext()`, with
		// nothing logged. Throwing turns that into a loud failure at the
		// boundary instead.
		const cycleDays = CADENCE_DAYS[s.cadence as Exclude<IncomeCadence, 'irregular'>];
		if (cycleDays === undefined) {
			throw new Error(`sustainableIncomeMinor: unknown income cadence "${s.cadence}"`);
		}
		perDay += s.amountMinor / cycleDays;
	}

	// One rounding, at the end — the same integer-first discipline as
	// dailyAllowance(). A per-source round would drift with the source count.
	return Math.round(perDay * windowDays);
}

/**
 * A monthly figure expressed over `windowDays`, by the same rule.
 *
 * Used for the rough fixed-bills total collected at setup. Income and bills
 * convert identically on purpose: a short month then reserves proportionally
 * less of both, and Spending — the remainder — scales with them rather than
 * needing a special case for every (cadence × period kind) pair.
 */
export function monthlyToWindowMinor(monthlyMinor: number, windowDays: number): number {
	return Math.round((monthlyMinor / AVG_DAYS_PER_MONTH) * windowDays);
}

export interface Waterfall {
	expectedMinor: number;
	billsMinor: number;
	irregularsMinor: number;
	bufferMinor: number;
	spendMinor: number;
	/** True when the commitments alone exceed what is expected to arrive. */
	short: boolean;
}

/**
 * Rule 1's ordered waterfall: Bills to full, Big bills to full, Emergency fund
 * minimum, remainder to Spending.
 *
 * The order is the mechanism. A percentage split cannot work against an amount
 * you do not know yet, and it cannot work at all when the commitments are
 * already fixed — Bills is whatever the bills actually cost, not a share of
 * anything. Fixing the ORDER instead means the same rule holds whether income
 * is a salary or a good month of freelancing.
 *
 * Spending is the remainder, and that is the point: it is the only bucket that
 * absorbs a bad month, which is exactly what the daily band is for. It never
 * goes below zero — a shortfall is surfaced, never borrowed from the buckets
 * above it, because silently under-funding Big bills is how a known cost
 * becomes a raided emergency fund three months later.
 */
export function waterfall(
	expectedMinor: number,
	billsMinor: number,
	irregularsMinor: number,
	bufferMinor: number
): Waterfall {
	let left = expectedMinor;

	const bills = Math.min(left, billsMinor);
	left -= bills;

	const irregulars = Math.min(left, irregularsMinor);
	left -= irregulars;

	const buffer = Math.min(left, bufferMinor);
	left -= buffer;

	return {
		expectedMinor,
		billsMinor: bills,
		irregularsMinor: irregulars,
		bufferMinor: buffer,
		spendMinor: Math.max(0, left),
		short: bills < billsMinor || irregulars < irregularsMinor
	};
}
