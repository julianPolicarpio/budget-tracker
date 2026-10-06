/**
 * Trip Mode (Spec §4.5).
 *
 * A trip is the canonical exceptional expense: perfectly predictable in
 * aggregate, and systematically excluded from budgets because each individual
 * one feels like a one-off (F10). It also arrives with the pain of paying at
 * its weakest — unfamiliar currency and heavier card use working against you at
 * once (F11). So travel needs the *most* structure at exactly the moment it
 * feels like the moment to relax.
 *
 *     A trip is not a spending period. It is a funded irregular being drawn
 *     down.
 *
 * Trip spending never touches `period.spend_alloc_minor`, and it never touches
 * the ongoing metrics — see the quarantine in metrics.ts.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { forUser, schema } from './db';
import { addDays, daysBetween } from './clock';
import { paddedAmount } from './irregulars';
import { IouRequired, accountByKind, recordTransfer } from './accounts';
import type { Trip } from './db/schema';

/** The funding check fires this far before departure (Spec §4.5 stage 3). */
export const FUNDING_CHECK_DAYS = 14;

/** Anything past this is a relocation, not a trip (Spec §1 non-goals). */
export const MAX_TRIP_DAYS = 42;

export class TripTooLong extends Error {
	constructor(days: number) {
		super(
			`${days} days is a relocation, not a trip. That is a new cost of living: ` +
				`close the period, re-run the 90-day calibration against local prices, and ` +
				`re-enter the phase ladder. Modelling it as a very large envelope produces a ` +
				`buffer drain you discover four months late.`
		);
		this.name = 'TripTooLong';
	}
}

export function activeTrip(userId: number): Trip | null {
	const { db, owns } = forUser(userId);
	return (
		db
			.select()
			.from(schema.trip)
			.where(and(owns(schema.trip), eq(schema.trip.status, 'active')))
			.get() ?? null
	);
}

export function tripById(userId: number, id: number): Trip | null {
	const { db, owns } = forUser(userId);
	return (
		db
			.select()
			.from(schema.trip)
			.where(and(owns(schema.trip), eq(schema.trip.id, id)))
			.get() ?? null
	);
}

export function listTrips(userId: number): Trip[] {
	const { db, owns } = forUser(userId);
	return db.select().from(schema.trip).where(owns(schema.trip)).orderBy(desc(schema.trip.startsOn)).all();
}

/** Σ of what has been logged against a trip, in home currency. */
export function tripSpentMinor(userId: number, tripId: number): number {
	const { db, owns } = forUser(userId);
	return (
		db
			.select({
				n: sql<number>`coalesce(sum(case when ${schema.txn.refundOf} is not null then -${schema.txn.amountMinor} else ${schema.txn.amountMinor} end), 0)`
			})
			.from(schema.txn)
			.where(and(owns(schema.txn), eq(schema.txn.tripId, tripId)))
			.get()?.n ?? 0
	);
}

/** Σ in the trip's own currency — what the user actually typed. */
export function tripSpentLocalMinor(userId: number, tripId: number): number {
	const { db, owns } = forUser(userId);
	return (
		db
			.select({ n: sql<number>`coalesce(sum(${schema.txn.amountLocalMinor}), 0)` })
			.from(schema.txn)
			.where(and(owns(schema.txn), eq(schema.txn.tripId, tripId)))
			.get()?.n ?? 0
	);
}

export interface DeclareInput {
	label: string;
	startsOn: string;
	endsOn: string;
	tripTz: string;
	currencyCode: string;
	currencySymbol: string;
	localMinorUnits: number;
	fxRateToHome: number;
	/** The unpadded estimate, in home currency. Padding is applied here. */
	estimateMinor: number;
	paddingPct?: number;
}

/**
 * Declare a trip (cue: the booking moment).
 *
 * Creates a `one_off` irregular plus its instance, then the trip linked to it.
 * A planned trip with no linked instance is a validation error at declare time,
 * not a warning — an unfunded trip silently eats the next two periods of Spend,
 * and that is the default failure this whole path exists to prevent.
 *
 * The booking moment is the only reliable cue. An hour later the trip exists
 * emotionally but not financially, and that gap is where the cost goes
 * unfunded.
 */
export function declareTrip(userId: number, input: DeclareInput, now: Date = new Date()): Trip {
	const { db, owns } = forUser(userId);
	const days = daysBetween(input.startsOn, input.endsOn) + 1;
	if (days > MAX_TRIP_DAYS) throw new TripTooLong(days);
	if (input.estimateMinor <= 0) throw new Error('The estimate must be above zero');
	if (input.fxRateToHome <= 0) throw new Error('The rate must be above zero');

	const paddingPct = input.paddingPct ?? 25;
	const envelopeMinor = paddedAmount(input.estimateMinor, paddingPct);

	return db.transaction((tx) => {
		const irregularId = tx
			.insert(schema.irregular)
			.values({
				label: input.label,
				amountMinor: input.estimateMinor,
				isEstimate: 1,
				cadence: 'one_off',
				cadenceN: null,
				nextDueOn: input.startsOn,
				category: 'other',
				paddingPct,
				createdAt: now.toISOString(),
				userId
			})
			.returning({ id: schema.irregular.id })
			.get().id;

		const instanceId = tx
			.insert(schema.irregularInstance)
			.values({
				irregularId,
				dueOn: input.startsOn,
				expectedMinor: envelopeMinor,
				status: 'projected',
				userId
			})
			.returning({ id: schema.irregularInstance.id })
			.get().id;

		const id = tx
			.insert(schema.trip)
			.values({
				label: input.label,
				startsOn: input.startsOn,
				endsOn: input.endsOn,
				tripTz: input.tripTz,
				currencyCode: input.currencyCode,
				currencySymbol: input.currencySymbol,
				localMinorUnits: input.localMinorUnits,
				fxRateToHome: input.fxRateToHome,
				envelopeMinor,
				irregularInstanceId: instanceId,
				status: 'planned',
				createdAt: now.toISOString(),
				userId
			})
			.returning({ id: schema.trip.id })
			.get().id;

		return tx
			.select()
			.from(schema.trip)
			.where(and(owns(schema.trip), eq(schema.trip.id, id)))
			.get()!;
	});
}

export interface FundingCheck {
	due: boolean;
	daysToDeparture: number;
	fundedMinor: number;
	envelopeMinor: number;
	shortfallMinor: number;
}

/**
 * Fires 14 days out. If the envelope is not funded there are exactly three
 * honest options — shorten it, downgrade it, or draw from Buffer with a
 * mandatory IOU. There is no fourth option and no dismiss button; letting the
 * shortfall quietly consume the next two periods of Spend is the default
 * failure this check exists to prevent.
 */
export function fundingCheck(userId: number, trip: Trip, today: string): FundingCheck {
	const daysToDeparture = daysBetween(today, trip.startsOn);
	const fundedMinor = Math.min(
		trip.envelopeMinor,
		(accountByKind(userId, 'irregulars')?.balanceMinor ?? 0) + trip.bufferDrawMinor
	);

	return {
		due: daysToDeparture <= FUNDING_CHECK_DAYS && trip.status === 'planned',
		daysToDeparture,
		fundedMinor,
		envelopeMinor: trip.envelopeMinor,
		shortfallMinor: Math.max(0, trip.envelopeMinor - fundedMinor)
	};
}

/**
 * Option three: cover the shortfall from Buffer. Rule 3 applies without
 * exception, so this throws without a note.
 */
export function coverShortfall(
	userId: number,
	tripId: number,
	amountMinor: number,
	iouReason: string,
	iouRepayBy: string | null,
	movedOn: string
): void {
	const { db, owns } = forUser(userId);
	const buffer = accountByKind(userId, 'buffer');
	const irregulars = accountByKind(userId, 'irregulars');
	if (!buffer || !irregulars) throw new Error('Accounts are not set up');
	if (!iouReason.trim()) throw new IouRequired(buffer.name);

	db.transaction((tx) => {
		recordTransfer(userId, {
			fromAccountId: buffer.id,
			toAccountId: irregulars.id,
			amountMinor,
			movedOn,
			iouReason,
			iouRepayBy
		});
		tx.update(schema.trip)
			.set({ bufferDrawMinor: sql`${schema.trip.bufferDrawMinor} + ${amountMinor}` })
			.where(and(owns(schema.trip), eq(schema.trip.id, tripId)))
			.run();
	});
}

/** Activate on `starts_on`. The day boundary moves to trip_tz from here. */
export function activateTrip(userId: number, tripId: number): Trip {
	const { db, owns } = forUser(userId);
	const already = activeTrip(userId);
	if (already && already.id !== tripId) {
		throw new Error(
			`"${already.label}" is still active. Overlapping trips are a data-entry error, not a feature.`
		);
	}
	db.update(schema.trip)
		.set({ status: 'active' })
		.where(and(owns(schema.trip), eq(schema.trip.id, tripId)))
		.run();
	return tripById(userId, tripId)!;
}

/**
 * Editing the rate recomputes every home-currency figure for this trip and
 * leaves the local amounts the user actually typed byte-identical. Local is
 * the source of truth; getting this backwards means a rate correction silently
 * rewrites history.
 */
export function setRate(userId: number, tripId: number, fxRateToHome: number, homeMinorUnits: number): void {
	if (fxRateToHome <= 0) throw new Error('The rate must be above zero');

	const { db, owns } = forUser(userId);
	const trip = tripById(userId, tripId);
	if (!trip) throw new Error(`No trip ${tripId}`);

	// The scale factor is NOT optional. ¥3,800 is 3800 minor units at zero
	// decimals and ₱1,558.00 is 155800 at two, so multiplying by the rate alone
	// is off by 100 — silently, on every home figure, the moment the user
	// corrects their rate. This is the same scale bug as localToHome() and it
	// has to be applied in both places.
	const scale = 10 ** (homeMinorUnits - trip.localMinorUnits);

	db.transaction((tx) => {
		tx.update(schema.trip)
			.set({ fxRateToHome })
			.where(and(owns(schema.trip), eq(schema.trip.id, tripId)))
			.run();

		tx.update(schema.txn)
			.set({
				amountMinor: sql`cast(round(${schema.txn.amountLocalMinor} * ${fxRateToHome} * ${scale}) as integer)`,
				fxRateUsed: fxRateToHome
			})
			.where(and(owns(schema.txn), eq(schema.txn.tripId, tripId)))
			.run();
	});
}

/**
 * Convert a local amount to home currency at the trip's locked rate.
 *
 * Minor-unit scales differ: ¥1,000 is 1000 minor units at 0 decimals, and the
 * home equivalent needs the home scale. Doing this in one place is what keeps
 * a zero-decimal currency from becoming a 100x error.
 */
export function localToHome(
	localMinor: number,
	trip: Pick<Trip, 'fxRateToHome' | 'localMinorUnits'>,
	homeMinorUnits: number
): number {
	const scale = 10 ** (homeMinorUnits - trip.localMinorUnits);
	return Math.round(localMinor * trip.fxRateToHome * scale);
}

export interface Settlement {
	loggedMinor: number;
	envelopeMinor: number;
	actualMinor: number;
	/** envelope − logged: did the trip cost what I thought? Tunes next year's estimate. */
	estimateErrorMinor: number;
	/** actual − logged: was my rate right? Tunes next trip's rate. */
	fxErrorMinor: number;
}

/**
 * Settle takes two numbers, and their difference is the point.
 *
 * The user enters what the bank actually charged, from statements; the app
 * already knows what was logged at the locked rate. Those are different
 * failures with different fixes — the first tunes next year's estimate, the
 * second tunes next trip's rate — and conflating them into one number means
 * neither improves.
 */
export function settleTrip(userId: number, tripId: number, actualMinor: number, settledOn: string): Settlement {
	const { db, owns } = forUser(userId);
	const trip = tripById(userId, tripId);
	if (!trip) throw new Error(`No trip ${tripId}`);

	const loggedMinor = tripSpentMinor(userId, tripId);

	db.transaction((tx) => {
		tx.update(schema.trip)
			.set({ status: 'settled', loggedTotalMinor: loggedMinor, actualMinor, settledOn })
			.where(and(owns(schema.trip), eq(schema.trip.id, tripId)))
			.run();

		// The linked irregular instance settles at what the trip actually cost,
		// which is what feeds the estimate-accuracy chart.
		if (trip.irregularInstanceId) {
			tx.update(schema.irregularInstance)
				.set({ status: 'settled', actualMinor, settledOn })
				.where(and(owns(schema.irregularInstance), eq(schema.irregularInstance.id, trip.irregularInstanceId)))
				.run();
		}

		tx.update(schema.account)
			.set({
				balanceMinor: sql`max(0, ${schema.account.balanceMinor} - ${actualMinor})`,
				balanceAsOf: settledOn
			})
			.where(and(owns(schema.account), eq(schema.account.kind, 'irregulars')))
			.run();
	});

	return {
		loggedMinor,
		envelopeMinor: trip.envelopeMinor,
		actualMinor,
		estimateErrorMinor: trip.envelopeMinor - loggedMinor,
		fxErrorMinor: actualMinor - loggedMinor
	};
}

export function cancelTrip(userId: number, tripId: number): void {
	const { db, owns } = forUser(userId);
	db.transaction((tx) => {
		const trip = tx
			.select()
			.from(schema.trip)
			.where(and(owns(schema.trip), eq(schema.trip.id, tripId)))
			.get();
		if (!trip) return;

		tx.update(schema.trip)
			.set({ status: 'cancelled' })
			.where(and(owns(schema.trip), eq(schema.trip.id, tripId)))
			.run();

		if (trip.irregularInstanceId) {
			tx.update(schema.irregularInstance)
				.set({ status: 'skipped' })
				.where(and(owns(schema.irregularInstance), eq(schema.irregularInstance.id, trip.irregularInstanceId)))
				.run();
		}
	});
}

export interface BurndownPoint {
	date: string;
	cumulativeMinor: number;
	paceMinor: number;
}

/** Actual cumulative spend against the straight-line pace. Two series, one unit. */
export function burndown(userId: number, trip: Trip, today: string): BurndownPoint[] {
	const { db, owns } = forUser(userId);
	const perDay = db
		.select({
			spentOn: schema.txn.spentOn,
			minor: sql<number>`sum(case when ${schema.txn.refundOf} is not null then -${schema.txn.amountMinor} else ${schema.txn.amountMinor} end)`
		})
		.from(schema.txn)
		.where(and(owns(schema.txn), eq(schema.txn.tripId, trip.id)))
		.groupBy(schema.txn.spentOn)
		.orderBy(asc(schema.txn.spentOn))
		.all();

	const byDate = new Map(perDay.map((r) => [r.spentOn, r.minor]));
	const totalDays = daysBetween(trip.startsOn, trip.endsOn) + 1;
	const envelope = trip.envelopeMinor + trip.bufferDrawMinor;
	const upTo = today < trip.endsOn ? today : trip.endsOn;

	const out: BurndownPoint[] = [];
	let cumulative = 0;
	for (let i = 0; i < totalDays; i++) {
		const date = addDays(trip.startsOn, i);
		if (date > upTo) break;
		cumulative += byDate.get(date) ?? 0;
		out.push({
			date,
			cumulativeMinor: cumulative,
			paceMinor: Math.round((envelope * (i + 1)) / totalDays)
		});
	}
	return out;
}

/** Trips whose window has arrived but which are still `planned`. */
export function tripsAwaitingActivation(userId: number, today: string): Trip[] {
	const { db, owns } = forUser(userId);
	return db
		.select()
		.from(schema.trip)
		.where(
			and(owns(schema.trip), eq(schema.trip.status, 'planned'), sql`${schema.trip.startsOn} <= ${today}`)
		)
		.all();
}
