/**
 * Income arrivals — effect-matrix op 2 (A3.3, A6).
 *
 * Until this file existed, money entered Split only by the user asserting a
 * balance on the Income account. A3.3 closes that gap: an arrival records a
 * real payment landing in a chosen account.
 *
 * What an arrival is NOT, and this is the whole design:
 * - Not a `txn` row. It is not income *reporting*; reports describe activity,
 *   and "money arrived" is not activity.
 * - Not a schedule event. `income_source` rows stay untouched; an arrival may
 *   optionally name the schedule it fulfils (`source_id`) for the records,
 *   but the schedule itself is never advanced, and `projectArrivals()` never
 *   learns anything from it (invariant 7 stays intact).
 * - Not an allowance change. The daily band comes from the period's frozen
 *   `daily_allowance_minor` and never moves because money showed up
 *   (invariant 10). What the money is *for* is decided by the allocation
 *   operation (op 4), which is separate and visible.
 *
 * Effects, exactly: +amount on the chosen account's balance, one
 * `income_arrival` row. Nothing else. The arrival row is its own audit
 * trail — `balance_correction` is for op 9 corrections, not for this.
 */

import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { forUser, schema } from './db';
import { localToday } from './clock';
import { loadSettings } from './today';

export interface ArrivalInput {
	/** The money's own date (YYYY-MM-DD). Never future-dated. */
	arrivedOn: string;
	amountMinor: number;
	/** Where the money physically landed. Must be a live, owned account. */
	accountId: number;
	/** Optional: which income schedule this fulfils, for the records only. */
	sourceId?: number | null;
	note?: string | null;
	clientUuid?: string | null;
}

/** Thrown with a plain-language message the route can show as-is. */
export class ArrivalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ArrivalError';
	}
}

export interface ArrivalResult {
	id: number;
	/** True when this submission was a replay of one already recorded. */
	replayed: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(iso: string): boolean {
	if (!ISO_DATE.test(iso)) return false;
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function recordArrival(
	userId: number,
	input: ArrivalInput,
	now: Date = new Date()
): ArrivalResult {
	if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
		throw new ArrivalError('Enter an amount above zero.');
	}
	if (!isRealDate(input.arrivedOn)) {
		throw new ArrivalError('Enter a real date.');
	}

	const settings = loadSettings(userId);
	if (!settings) throw new ArrivalError('Split is not initialised yet.');

	// Recording tomorrow's salary books money that does not exist. The whole
	// system trusts balances to be physical, so an arrival cannot pre-date its
	// own cash. (Recording yesterday's, late, is normal life — allowed.)
	const today = localToday(settings.timezone, now);
	if (input.arrivedOn > today) {
		throw new ArrivalError('An arrival cannot be dated in the future.');
	}

	const { db, owns } = forUser(userId);

	// Idempotency first: an uncertain response retried with the same UUID
	// returns the recorded outcome instead of creating money twice.
	if (input.clientUuid) {
		const existing = db
			.select({ id: schema.incomeArrival.id })
			.from(schema.incomeArrival)
			.where(
				and(owns(schema.incomeArrival), eq(schema.incomeArrival.clientUuid, input.clientUuid))
			)
			.get();
		if (existing) return { id: existing.id, replayed: true };
	}

	const result = db.transaction((tx) => {
		const account = tx
			.select()
			.from(schema.account)
			.where(and(owns(schema.account), eq(schema.account.id, input.accountId)))
			.get();
		if (!account) throw new ArrivalError('Pick where the money landed.');
		if (account.archivedAt) throw new ArrivalError('That account is archived.');

		const inserted = tx
			.insert(schema.incomeArrival)
			.values({
				arrivedOn: input.arrivedOn,
				amountMinor: input.amountMinor,
				accountId: input.accountId,
				sourceId: input.sourceId ?? null,
				note: input.note ?? null,
				clientUuid: input.clientUuid ?? null,
				enteredAt: now.toISOString(),
				userId
			})
			.returning({ id: schema.incomeArrival.id })
			.get();

		// The one balance effect. balanceAsOf moves to the arrival's own date —
		// the money exists from that day, and the assertion date says so.
		tx.update(schema.account)
			.set({ balanceMinor: account.balanceMinor + input.amountMinor, balanceAsOf: input.arrivedOn })
			.where(and(owns(schema.account), eq(schema.account.id, account.id)))
			.run();

		return inserted;
	});

	return { id: result.id, replayed: false };
}

/** Arrivals for a date range, newest first — the review view reads these. */
export function listArrivals(userId: number, from: string, to: string) {
	const { db, owns } = forUser(userId);
	return db
		.select()
		.from(schema.incomeArrival)
		.where(
			and(
				owns(schema.incomeArrival),
				gte(schema.incomeArrival.arrivedOn, from),
				lte(schema.incomeArrival.arrivedOn, to)
			)
		)
		.orderBy(desc(schema.incomeArrival.arrivedOn), desc(schema.incomeArrival.id))
		.all();
}
