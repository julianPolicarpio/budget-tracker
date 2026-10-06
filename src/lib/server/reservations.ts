/**
 * The reservation ledger (migration 0015, Spec A3.2) — money promised to one
 * planned expense.
 *
 * A reservation never moves money between buckets. It partitions ONE bucket's
 * balance: `unassigned = balance − reserved`, checked server-side inside the
 * same transaction that writes the row, so the same money can never fund two
 * expenses — not through racing submissions either (better-sqlite3 runs one
 * transaction at a time; the check and the insert are atomic together).
 *
 * Funding history is these rows, read back in order — never reconstructed.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { forUser, schema } from './db';
import { formatMoney } from '$lib/money';

/** Thrown when a funding request asks for money that is already promised. */
export class FundingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FundingError';
	}
}

/**
 * Currency shape for the messages below, read straight off `settings`.
 *
 * These errors quote a figure, and until now they built it by hand as
 * `₱${minor / 100}`. That is wrong twice over: dividing minor units by a
 * literal 100 is exactly the float arithmetic Invariant 5 keeps out of
 * everything but `$lib/money`, and both the symbol and the two decimals are
 * assumptions — JPY, KRW and VND have zero decimal places, which the trip
 * rules already depend on (Invariant 8). `formatMoney` knows all of that.
 *
 * Read here rather than through `loadSettings` in `today.ts`, because
 * importing that would close a `reservations -> today -> trips -> accounts
 * -> reservations` cycle. It is two columns; the cycle is not worth them.
 */
function moneyShape(
	userId: number,
	db: Tx | ReturnType<typeof forUser>['db']
): { minorUnits: number; symbol: string } {
	const row = db
		.select({
			minorUnits: schema.settings.minorUnits,
			symbol: schema.settings.currencySymbol
		})
		.from(schema.settings)
		.where(eq(schema.settings.userId, userId))
		.get();
	return { minorUnits: row?.minorUnits ?? 2, symbol: row?.symbol ?? '' };
}

/**
 * Buckets whose outflow normally demands an IOU (same list as
 * `IOU_REQUIRED_FROM` in accounts.ts — kept local because accounts.ts imports
 * this module's correction guard, and a cycle would not help anyone).
 */
const IOU_KINDS = ['irregulars', 'buffer', 'grow'] as const;

type Tx = Parameters<Parameters<ReturnType<typeof forUser>['db']['transaction']>[0]>[0];

export interface FundInput {
	irregularId: number;
	/** The bucket whose balance the reservation partitions. */
	accountId: number;
	amountMinor: number;
	/** A3.2 case 1: also move the money from this bucket in the same transaction. */
	sourceAccountId?: number | null;
	note?: string | null;
	clientUuid?: string | null;
}

export interface ReservationEventInput {
	irregularId: number;
	accountId: number;
	amountMinor: number;
	note?: string | null;
	clientUuid?: string | null;
}

/** Outstanding reservation for one expense inside one bucket. */
export function outstandingFor(
	userId: number,
	irregularId: number,
	accountId: number,
	db: Tx | ReturnType<typeof forUser>['db'] = forUser(userId).db
): number {
	const rows = db
		.select({ kind: schema.expenseReservation.kind, amountMinor: schema.expenseReservation.amountMinor })
		.from(schema.expenseReservation)
		.where(
			and(
				eq(schema.expenseReservation.userId, userId),
				eq(schema.expenseReservation.irregularId, irregularId),
				eq(schema.expenseReservation.accountId, accountId)
			)
		)
		.all();
	return rows.reduce(
		(sum, r) => sum + (r.kind === 'fund' ? r.amountMinor : -r.amountMinor),
		0
	);
}

/** Everything promised inside one bucket, across all expenses. */
export function reservedInBucket(
	userId: number,
	accountId: number,
	db: Tx | ReturnType<typeof forUser>['db'] = forUser(userId).db
): number {
	const rows = db
		.select({ kind: schema.expenseReservation.kind, amountMinor: schema.expenseReservation.amountMinor })
		.from(schema.expenseReservation)
		.where(
			and(
				eq(schema.expenseReservation.userId, userId),
				eq(schema.expenseReservation.accountId, accountId)
			)
		)
		.all();
	return rows.reduce(
		(sum, r) => sum + (r.kind === 'fund' ? r.amountMinor : -r.amountMinor),
		0
	);
}

/** Money in the bucket that no reservation claims. */
export function unassignedInBucket(
	userId: number,
	accountId: number,
	db: Tx | ReturnType<typeof forUser>['db'] = forUser(userId).db
): number {
	const account = db
		.select({ balanceMinor: schema.account.balanceMinor })
		.from(schema.account)
		.where(and(eq(schema.account.userId, userId), eq(schema.account.id, accountId)))
		.get();
	if (!account) throw new FundingError('Unknown bucket.');
	return account.balanceMinor - reservedInBucket(userId, accountId, db);
}

/** The funding history of one expense, oldest first — read, never rebuilt. */
export function fundingHistory(userId: number, irregularId: number) {
	const { db, owns } = forUser(userId);
	return db
		.select()
		.from(schema.expenseReservation)
		.where(owns(schema.expenseReservation))
		.orderBy(asc(schema.expenseReservation.id))
		.all()
		.filter((r) => r.irregularId === irregularId);
}

/**
 * Fund a planned expense (A3.2).
 *
 * Case 2 (`sourceAccountId` null): assign money already in the bucket — no
 * balance moves, the unassigned remainder shrinks. Case 1: a balanced move
 * from the source bucket, then the reservation. Savings-kind sources satisfy
 * the IOU rule with an auto-filled note — the set-aside IS the reason.
 */
export function fundPlannedExpense(
	userId: number,
	input: FundInput,
	now: Date = new Date()
): { id: number; moved: boolean } {
	const { db, owns } = forUser(userId);

	if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
		throw new FundingError('Enter an amount above zero.');
	}

	const expense = db
		.select({ id: schema.irregular.id, label: schema.irregular.label, archivedAt: schema.irregular.archivedAt })
		.from(schema.irregular)
		.where(owns(schema.irregular))
		.all()
		.find((r) => r.id === input.irregularId);
	if (!expense || expense.archivedAt) throw new FundingError('Unknown planned expense.');

	const destination = db
		.select()
		.from(schema.account)
		.where(owns(schema.account))
		.all()
		.find((r) => r.id === input.accountId);
	if (!destination) throw new FundingError('Unknown bucket.');

	const source = input.sourceAccountId
		? db.select().from(schema.account).where(owns(schema.account)).all().find((r) => r.id === input.sourceAccountId)
		: null;
	if (input.sourceAccountId && !source) throw new FundingError('Unknown source bucket.');
	if (source && source.id === destination.id) input.sourceAccountId = null;

	// Idempotency: a retried submit must not fund twice. A unique violation on
	// client_uuid aborts the transaction, so the existing row is read after.
	if (input.clientUuid) {
		const existing = db
			.select({ id: schema.expenseReservation.id })
			.from(schema.expenseReservation)
			.where(
				and(
					eq(schema.expenseReservation.userId, userId),
					eq(schema.expenseReservation.clientUuid, input.clientUuid)
				)
			)
			.get();
		if (existing) return { id: existing.id, moved: false };
	}

	try {
		return db.transaction((tx: Tx) => {
			// The check and the insert are one transaction — a concurrent fund
			// of the same money cannot slip between them.
			const available = unassignedInBucket(
				userId,
				source ? source.id : destination.id,
				tx
			);
			if (available < input.amountMinor) {
				throw new FundingError(
					`That bucket has ${formatMoney(available, moneyShape(userId, tx))} not yet promised. Release or add money first.`
				);
			}

			let moved = false;
			if (source) {
				tx.update(schema.account)
					.set({
						balanceMinor: source.balanceMinor - input.amountMinor,
						balanceAsOf: now.toISOString().slice(0, 10)
					})
					.where(and(eq(schema.account.userId, userId), eq(schema.account.id, source.id)))
					.run();
				tx.update(schema.account)
					.set({
						balanceMinor: destination.balanceMinor + input.amountMinor,
						balanceAsOf: now.toISOString().slice(0, 10)
					})
					.where(and(eq(schema.account.userId, userId), eq(schema.account.id, destination.id)))
					.run();
				moved = true;
			}

			// A3.2: taking money out of a savings-kind bucket normally demands an
			// IOU, but the set-aside IS the reason — auto-fill the note instead of
			// asking for one.
			const note =
				input.note ??
				(source && (IOU_KINDS as readonly string[]).includes(source.kind)
					? `Set aside for ${expense.label}`
					: null);

			const id = tx
				.insert(schema.expenseReservation)
				.values({
					irregularId: expense.id,
					accountId: destination.id,
					kind: 'fund',
					amountMinor: input.amountMinor,
					note,
					clientUuid: input.clientUuid ?? null,
					createdAt: now.toISOString(),
					userId
				})
				.returning({ id: schema.expenseReservation.id })
				.get().id;

			return { id, moved };
		});
	} catch (err) {
		if (err instanceof FundingError) throw err;
		// Unique violation on client_uuid: the first submit won. Return its row.
		const existing = input.clientUuid
			? db
					.select({ id: schema.expenseReservation.id })
					.from(schema.expenseReservation)
					.where(
						and(
							eq(schema.expenseReservation.userId, userId),
							eq(schema.expenseReservation.clientUuid, input.clientUuid)
						)
					)
					.get()
			: null;
		if (existing) return { id: existing.id, moved: false };
		throw err;
	}
}

/**
 * Release part of a reservation — funding reduced, reversed, or the expense
 * cancelled. Releases exactly the amount asked, never more than outstanding.
 * No balance moves: the promise dissolves, the money simply becomes
 * unassigned again.
 */
export function releaseReservation(
	userId: number,
	input: ReservationEventInput,
	now: Date = new Date()
): number {
	const { db, owns } = forUser(userId);
	if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
		throw new FundingError('Enter an amount above zero.');
	}

	if (input.clientUuid) {
		const existing = db
			.select({ id: schema.expenseReservation.id })
			.from(schema.expenseReservation)
			.where(
				and(
					eq(schema.expenseReservation.userId, userId),
					eq(schema.expenseReservation.clientUuid, input.clientUuid)
				)
			)
			.get();
		if (existing) return existing.id;
	}

	return db.transaction((tx: Tx) => {
		const outstanding = outstandingFor(userId, input.irregularId, input.accountId, tx);
		if (outstanding < input.amountMinor) {
			throw new FundingError(
				`Only ${formatMoney(outstanding, moneyShape(userId, tx))} is set aside for this expense.`
			);
		}
		const id = tx
			.insert(schema.expenseReservation)
			.values({
				irregularId: input.irregularId,
				accountId: input.accountId,
				kind: 'release',
				amountMinor: input.amountMinor,
				note: input.note ?? null,
				clientUuid: input.clientUuid ?? null,
				createdAt: now.toISOString(),
				userId
			})
			.returning({ id: schema.expenseReservation.id })
			.get().id;
		return id;
	});
}

/**
 * Consume a reservation when the expense is actually paid (matrix op 6): the
 * promise became a payment. Balance movement and spending record belong to
 * the payment operation; this only dissolves the promise.
 */
export function consumeReservation(
	userId: number,
	input: ReservationEventInput,
	now: Date = new Date()
): number | null {
	const { db, owns } = forUser(userId);
	if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return null;

	if (input.clientUuid) {
		const existing = db
			.select({ id: schema.expenseReservation.id })
			.from(schema.expenseReservation)
			.where(
				and(
					eq(schema.expenseReservation.userId, userId),
					eq(schema.expenseReservation.clientUuid, input.clientUuid)
				)
			)
			.get();
		if (existing) return existing.id;
	}

	return db.transaction((tx: Tx) => {
		const outstanding = outstandingFor(userId, input.irregularId, input.accountId, tx);
		const amount = Math.min(outstanding, input.amountMinor);
		if (amount <= 0) return null;
		return tx
			.insert(schema.expenseReservation)
			.values({
				irregularId: input.irregularId,
				accountId: input.accountId,
				kind: 'consume',
				amountMinor: amount,
				note: input.note ?? null,
				clientUuid: input.clientUuid ?? null,
				createdAt: now.toISOString(),
				userId
			})
			.returning({ id: schema.expenseReservation.id })
			.get().id;
	});
}

/**
 * The bucket a planned expense's reservations live in, for settlement
 * consumption. Planned-expense money sits in the Irregulars bucket.
 *
 * (Queries the account table directly — importing from accounts.ts would
 * create a cycle, because accounts.ts imports this module's guard.)
 */
export function reservationBucketId(userId: number): number {
	const { db, owns } = forUser(userId);
	const bucket = db
		.select({ id: schema.account.id })
		.from(schema.account)
		.where(and(owns(schema.account), eq(schema.account.kind, 'irregulars'), isNull(schema.account.archivedAt)))
		.get();
	if (!bucket) throw new FundingError('No Irregulars bucket.');
	return bucket.id;
}

/**
 * Guard for balance corrections (A3.3): a new asserted balance may not eat
 * money already promised to a planned expense. Called by accounts.ts inside
 * its correction transaction.
 */
export function assertNotEatingReserved(
	userId: number,
	accountId: number,
	newBalanceMinor: number
): void {
	const reserved = reservedInBucket(userId, accountId);
	if (newBalanceMinor < reserved) {
		const { db } = forUser(userId);
		throw new FundingError(
			`${formatMoney(reserved, moneyShape(userId, db))} of that bucket is already set aside for planned expenses. Release some first.`
		);
	}
}
