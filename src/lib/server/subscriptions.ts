/**
 * Subscriptions — Bills items that keep charging until a human stops them
 * (Spec §158, §267, §374).
 *
 * The money here is the small half of the problem. The large half is that a
 * recurring charge stops being a decision after the first month: F12's
 * snowball is assembled entirely from amounts too small to argue with
 * individually. So the surface this module feeds is a *deadline*, not a
 * balance, and the weekly review gets a cull step rather than a total.
 *
 * Nothing in here touches Spend, the daily figure, or the eight categories'
 * weekly totals. Bills never do (Spec §158) — `category` is carried only so
 * the review can group the cull.
 */

import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { forUser, schema } from './db';
import { addDays, daysBetween } from './clock';
import { addMonths } from './irregulars';
import { CADENCE_STEP, FINAL_ALERT_DAYS, type Cadence } from '$lib/subscription-cadence';

export type { Cadence };

// Re-exported for callers that already read the constant off this module —
// the value itself lives in subscription-cadence.ts now, alongside
// `trialAlertDays()`, which needs it and must stay importable from the
// browser (see that module's doc).
export { FINAL_ALERT_DAYS };

export type Subscription = typeof schema.subscription.$inferSelect;

/**
 * What this costs over a year.
 *
 * The `× 12` here is NOT the bug invariant 7 forbids. That rule is about
 * income: pay cycles do not divide the year evenly, so bi-weekly is 26
 * arrivals and `projectArrivals()` is the only honest path to an allocation.
 * A monthly *subscription* genuinely bills twelve times a year, and this
 * figure never becomes an allocation — it exists to be read aloud during the
 * cull, where "₱285 a month" and "₱3,420 a year" are the same fact told at two
 * very different volumes.
 *
 * Day-based cadences annualise the same way, against a 52-week year (364
 * days) rather than the calendar's 365/365.25: a weekly charge bills exactly
 * 52 times and a fortnightly one exactly 26, matching how a payroll cycle is
 * normally described. Never `× 12` on a weekly figure and never `× 24` on a
 * fortnightly one — both are the fractional-month bug wearing a different
 * divisor.
 */
export function annualisedMinor(sub: Pick<Subscription, 'amountMinor' | 'cadence'>): number {
	const step = CADENCE_STEP[sub.cadence as Cadence];
	return step.kind === 'days' ? sub.amountMinor * (364 / step.n) : sub.amountMinor * (12 / step.n);
}

/**
 * The next charge after this one, at the subscription's own cadence.
 *
 * Cadence has a kind (Spec §5.1): a day-based cadence advances with
 * `addDays`, a calendar-based one with `addMonths`. `addMonths(date, 12/52)`
 * — the old behaviour — produced a fractional month index for a weekly
 * subscription, which is why the two kinds no longer share a code path.
 */
export function advanceCharge(sub: Pick<Subscription, 'nextChargeOn' | 'cadence'>): string {
	const step = CADENCE_STEP[sub.cadence as Cadence];
	return step.kind === 'days'
		? addDays(sub.nextChargeOn, step.n)
		: addMonths(sub.nextChargeOn, step.n);
}

export function listSubscriptions(userId: number, includeCancelled = false): Subscription[] {
	const { db, owns } = forUser(userId);
	const q = db.select().from(schema.subscription);
	const rows = includeCancelled
		? q.where(owns(schema.subscription)).orderBy(asc(schema.subscription.nextChargeOn)).all()
		: q
				.where(and(owns(schema.subscription), isNull(schema.subscription.cancelledAt)))
				.orderBy(asc(schema.subscription.nextChargeOn))
				.all();
	return rows;
}

export function getSubscription(userId: number, id: number): Subscription | undefined {
	const { db, owns } = forUser(userId);
	return db
		.select()
		.from(schema.subscription)
		.where(and(owns(schema.subscription), eq(schema.subscription.id, id)))
		.get();
}

export interface NewSubscription {
	label: string;
	vendor?: string | null;
	amountMinor: number;
	taxMinor?: number | null;
	cadence: Cadence;
	nextChargeOn: string;
	trialEndsOn?: string | null;
	cancelByOn?: string | null;
	leadDays?: number;
	/** Stage 2's own threshold (Spec §7.3, migration 0012). Defaults to
	 * `FINAL_ALERT_DAYS` — the constant every subscription used before a
	 * trial's own length could scale it down via `trialAlertDays()`. */
	finalLeadDays?: number;
	category?: string | null;
	note?: string | null;
	isEssential?: boolean;
}

/**
 * The steady per-period cost of every live commitment.
 *
 * Deliberately NOT the irregulars accrual shape. `requiredAccrualPerPeriod()`
 * divides by whole periods remaining until a dated instance, which is right
 * for a one-off lump you must have ready by a deadline — the figure rises as
 * the date closes in. A recurring bill has no deadline to converge on; it just
 * keeps arriving. Using that shape would make the wifi allocation lurch from
 * ₱150 to ₱187 to ₱250 to ₱375 across a month and then reset, which describes
 * nothing real.
 *
 * So this is the long-run rate: what the commitment costs per day, times the
 * days in a period. The `× 12` implicit in AVG_DAYS_PER_MONTH is not the bug
 * invariant 7 forbids — that rule governs INCOME, where pay cycles genuinely
 * do not divide the year evenly. A monthly bill genuinely bills twelve times a
 * year, and this figure is a cost reservation, never an arrival projection.
 *
 * A day-based cadence needs none of this averaging: a weekly bill is due
 * every 7 days, exactly, not every `1 * (365.25/12)` = 30.4 days. Using the
 * calendar-month approximation there was the original bug — `0.23 months *
 * AVG_DAYS_PER_MONTH` is 7.02 days, not 7 — so day-based cadences take their
 * step directly and skip the average entirely.
 */
const AVG_DAYS_PER_MONTH = 365.25 / 12;

export function commitmentsPerPeriod(
	userId: number,
	daysPerPeriod: number,
	today?: string
): number {
	return Math.round(
		listSubscriptions(userId).reduce((sum, sub) => {
			// A commitment still inside its free trial costs nothing yet. Reserving
			// for it would park real money against a charge that may never arrive
			// — the entire point of the deadline is that you get to say no. It
			// starts costing on the day it starts charging, and the alert exists
			// to make sure that day is not a surprise.
			if (today && sub.trialEndsOn !== null && sub.trialEndsOn > today) return sum;

			const step = CADENCE_STEP[sub.cadence as Cadence];
			const daysBetweenCharges = step.kind === 'days' ? step.n : step.n * AVG_DAYS_PER_MONTH;
			return sum + (sub.amountMinor * daysPerPeriod) / daysBetweenCharges;
		}, 0)
	);
}

/** Split by whether cancelling is even an option — the cull only hunts one side. */
export function commitmentsByKind(userId: number): {
	essential: Subscription[];
	discretionary: Subscription[];
} {
	const live = listSubscriptions(userId);
	return {
		essential: live.filter((s) => s.isEssential === 1),
		discretionary: live.filter((s) => s.isEssential !== 1)
	};
}

export function createSubscription(
	userId: number,
	input: NewSubscription,
	now: Date = new Date()
): number {
	const { db } = forUser(userId);
	const row = db
		.insert(schema.subscription)
		.values({
			label: input.label,
			vendor: input.vendor ?? null,
			amountMinor: input.amountMinor,
			taxMinor: input.taxMinor ?? null,
			cadence: input.cadence,
			nextChargeOn: input.nextChargeOn,
			trialEndsOn: input.trialEndsOn ?? null,
			cancelByOn: input.cancelByOn ?? null,
			leadDays: input.leadDays ?? 30,
			finalLeadDays: input.finalLeadDays ?? FINAL_ALERT_DAYS,
			alertStage: 0,
			alertedAt: null,
			lastUsedOn: null,
			category: input.category ?? null,
			note: input.note ?? null,
			createdAt: now.toISOString(),
			cancelledAt: null,
			isEssential: input.isEssential ? 1 : 0,
			userId
		})
		.returning({ id: schema.subscription.id })
		.get();
	return row.id;
}

export interface SubscriptionEdit extends NewSubscription {
	leadDays: number;
}

/**
 * Revise a recorded commitment.
 *
 * The one non-obvious rule: **moving the deadline re-arms the alerts.** A
 * warning already sent describes a date that no longer exists, so leaving
 * `alertStage` where it was would mean a trial you just pushed from September
 * to next August never warns you again. Editing any other field leaves the
 * alert state alone, so correcting a typo in a label does not re-nag you about
 * a decision you have already been warned about.
 */
export function updateSubscription(userId: number, id: number, input: SubscriptionEdit): void {
	const { db, owns } = forUser(userId);
	const before = getSubscription(userId, id);
	if (!before) return;

	const deadlineMoved =
		(before.cancelByOn ?? null) !== (input.cancelByOn ?? null) ||
		(before.trialEndsOn ?? null) !== (input.trialEndsOn ?? null);

	db.update(schema.subscription)
		.set({
			label: input.label,
			vendor: input.vendor ?? null,
			amountMinor: input.amountMinor,
			taxMinor: input.taxMinor ?? null,
			cadence: input.cadence,
			nextChargeOn: input.nextChargeOn,
			trialEndsOn: input.trialEndsOn ?? null,
			cancelByOn: input.cancelByOn ?? null,
			leadDays: input.leadDays,
			// Not on the edit form (see SubscriptionEdit.svelte) — preserved
			// rather than reset, so a plain label/amount correction cannot
			// silently widen a trial-scaled stage-2 threshold back to the
			// constant default.
			finalLeadDays: input.finalLeadDays ?? before.finalLeadDays,
			category: input.category ?? null,
			note: input.note ?? null,
			isEssential: input.isEssential ? 1 : 0,
			...(deadlineMoved ? { alertStage: 0, alertedAt: null } : {})
		})
		.where(and(owns(schema.subscription), eq(schema.subscription.id, id)))
		.run();
}

/** Undo an "Ended it" — the button is one click and mistakes are cheap to make. */
export function restoreSubscription(userId: number, id: number): void {
	const { db, owns } = forUser(userId);
	db.update(schema.subscription)
		.set({ cancelledAt: null })
		.where(and(owns(schema.subscription), eq(schema.subscription.id, id)))
		.run();
}

export function cancelSubscription(userId: number, id: number, now: Date = new Date()): void {
	const { db, owns } = forUser(userId);
	db.update(schema.subscription)
		.set({ cancelledAt: now.toISOString() })
		.where(and(owns(schema.subscription), eq(schema.subscription.id, id)))
		.run();
}

/**
 * Keep it: clear the trial, roll to the next charge, and re-arm the alerts.
 *
 * Re-arming matters. A subscription you decided to keep in 2027 is one you
 * should be asked about again in 2028 — the cull is not a one-time gate.
 */
export function keepSubscription(userId: number, id: number, today: string): void {
	const { db, owns } = forUser(userId);
	const sub = getSubscription(userId, id);
	if (!sub) return;

	const nextCharge = sub.nextChargeOn <= today ? advanceCharge(sub) : sub.nextChargeOn;
	db.update(schema.subscription)
		.set({
			nextChargeOn: nextCharge,
			trialEndsOn: null,
			// The next decision point is the next renewal, not the dead trial date.
			cancelByOn: nextCharge,
			alertStage: 0,
			alertedAt: null,
			lastUsedOn: today
		})
		.where(and(owns(schema.subscription), eq(schema.subscription.id, id)))
		.run();
}

export function markUsed(userId: number, id: number, today: string): void {
	const { db, owns } = forUser(userId);
	db.update(schema.subscription)
		.set({ lastUsedOn: today })
		.where(and(owns(schema.subscription), eq(schema.subscription.id, id)))
		.run();
}

export interface PendingAlert {
	sub: Subscription;
	stage: 1 | 2;
	daysLeft: number;
}

/**
 * Live subscriptions whose deadline has entered a window they have not yet
 * been alerted for.
 *
 * Read the whole live set and filter in TypeScript rather than expressing the
 * window in SQL: the set is a handful of rows, and the date arithmetic stays
 * next to the rule it implements instead of being split across two languages.
 */
export function pendingAlerts(userId: number, today: string): PendingAlert[] {
	const { db, owns } = forUser(userId);
	const live = db
		.select()
		.from(schema.subscription)
		.where(
			and(
				owns(schema.subscription),
				isNull(schema.subscription.cancelledAt),
				isNotNull(schema.subscription.cancelByOn)
			)
		)
		.all();

	const out: PendingAlert[] = [];
	for (const sub of live) {
		const deadline = sub.cancelByOn!;
		const daysLeft = daysBetween(today, deadline);

		// Past the deadline there is nothing left to decide, and a notification
		// about a charge that already landed is noise.
		if (daysLeft < 0) continue;

		if (sub.alertStage < 1 && daysLeft <= sub.leadDays) {
			out.push({ sub, stage: 1, daysLeft });
			// `finalLeadDays` (Spec §7.3, migration 0012) replaces the constant
			// `FINAL_ALERT_DAYS` here: a trial's own length can put its second
			// alert closer than 7 days out, and reading it off the row is what
			// lets `trialAlertDays()` set a threshold shorter than the default.
		} else if (sub.alertStage < 2 && daysLeft <= sub.finalLeadDays) {
			out.push({ sub, stage: 2, daysLeft });
		}
	}
	return out;
}

export function recordAlert(
	userId: number,
	id: number,
	stage: 1 | 2,
	now: Date = new Date()
): void {
	const { db, owns } = forUser(userId);
	db.update(schema.subscription)
		.set({ alertStage: stage, alertedAt: now.toISOString() })
		.where(and(owns(schema.subscription), eq(schema.subscription.id, id)))
		.run();
}

/**
 * The single most urgent deadline, for the Today screen's horizon line.
 *
 * Returns a date and a count of days — never an amount. The Today screen
 * withholds figures by design (Spec §4.2), and "₱285/month starts in 6 days"
 * on the daily surface would be a balance wearing a hat.
 */
export interface SubscriptionHorizon {
	id: number;
	label: string;
	deadline: string;
	daysLeft: number;
	isTrial: boolean;
}

export function subscriptionHorizon(userId: number, today: string): SubscriptionHorizon | null {
	const { db, owns } = forUser(userId);
	const rows = db
		.select()
		.from(schema.subscription)
		.where(
			and(
				owns(schema.subscription),
				isNull(schema.subscription.cancelledAt),
				isNotNull(schema.subscription.cancelByOn),
				lte(schema.subscription.cancelByOn, addDays(today, 30))
			)
		)
		.orderBy(asc(schema.subscription.cancelByOn))
		.all();

	for (const sub of rows) {
		const daysLeft = daysBetween(today, sub.cancelByOn!);
		if (daysLeft < 0) continue;
		return {
			id: sub.id,
			label: sub.label,
			deadline: sub.cancelByOn!,
			daysLeft,
			isTrial: sub.trialEndsOn !== null
		};
	}
	return null;
}

/**
 * The cull list (Spec §267): every live subscription, flagged by whether it
 * has been used in the last 30 days. Never used at all counts as stale — an
 * unrecorded subscription is the exact thing the cull is hunting.
 */
export interface CullRow {
	sub: Subscription;
	annualisedMinor: number;
	staleDays: number | null;
	stale: boolean;
}

export function cullList(userId: number, today: string): CullRow[] {
	// Essential commitments are excluded outright. "Used your home internet in
	// the last 30 days?" is not a question, and a cull that asks it trains you
	// to skim past the ones that are real.
	return commitmentsByKind(userId).discretionary.map((sub) => {
		const staleDays = sub.lastUsedOn === null ? null : daysBetween(sub.lastUsedOn, today);
		return {
			sub,
			annualisedMinor: annualisedMinor(sub),
			staleDays,
			stale: staleDays === null || staleDays > 30
		};
	});
}

/** What the whole live set costs per year — the cull's headline figure. */
export function annualisedTotalMinor(userId: number): number {
	return listSubscriptions(userId).reduce((sum, s) => sum + annualisedMinor(s), 0);
}
