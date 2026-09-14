/**
 * The transfer checklist (Spec §4.1, §8.3.4).
 *
 * Where the bank cannot automate the split, the app emits the exact moves to
 * make by hand. An `allocation` row with no `executed_at` is money the app
 * believes is somewhere it is not — which silently invalidates every number
 * downstream of it, so it surfaces on Today after 48 hours rather than waiting
 * to be noticed.
 *
 * Phase 3 knows two of the five allocations for certain: the Spend allocation
 * is frozen on the period row, and the Irregulars accrual is computed from the
 * instance schedule. Bills, Buffer and Grow need the income split, which needs
 * income sources — see the note at the bottom of migration 0003. Rather than
 * invent them, the checklist shows what it actually knows and says so.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { forUser, schema } from './db';
import { requiredAccrualPerPeriod } from './irregulars';
import { commitmentsPerPeriod } from './subscriptions';
import { expectedIncome, waterfall } from './income';
import { daysBetween } from './clock';
import type { Period } from './db/schema';

/** Older than this and an unexecuted allocation is a problem, not a to-do. */
export const STALE_AFTER_DAYS = 2;

export interface ChecklistItem {
	id: number;
	accountId: number;
	accountName: string;
	amountMinor: number;
	executedAt: string | null;
	/** Days since the period opened — drives the Today prompt. */
	ageDays: number;
}

/**
 * Create this period's known allocations if they are not there yet.
 * Idempotent via the unique index on (period_id, account_id).
 */
export function ensureAllocations(userId: number, period: Period, today: string): void {
	const { db, owns } = forUser(userId);
	const spend = db
		.select()
		.from(schema.account)
		.where(and(owns(schema.account), eq(schema.account.kind, 'spend')))
		.get();
	const irregulars = db
		.select()
		.from(schema.account)
		.where(and(owns(schema.account), eq(schema.account.kind, 'irregulars')))
		.get();
	if (!spend || !irregulars) return;

	const rows = [{ accountId: spend.id, amountMinor: period.spendAllocMinor }];

	const accrual = requiredAccrualPerPeriod(userId, today, period.days);
	if (accrual > 0) rows.push({ accountId: irregulars.id, amountMinor: accrual });

	// Bills: the steady cost of every live recurring commitment (Spec §158).
	// Without this row the bucket exists on the money map and is never funded,
	// so a subscription or a phone plan is silently paid out of Spend — which
	// puts a cost you cannot decline inside the number that means "money you
	// chose to spend", and quietly breaks the daily band.
	const bills = db
		.select()
		.from(schema.account)
		.where(and(owns(schema.account), eq(schema.account.kind, 'bills')))
		.get();
	const committed = commitmentsPerPeriod(userId, period.days, today);
	if (bills && committed > 0) rows.push({ accountId: bills.id, amountMinor: committed });

	/*
	 * Emergency fund and Savings, which had no row at all until income sources
	 * existed (migration 0014).
	 *
	 * The Accounts page said so out loud for four phases: "Only two of the five
	 * are known here." Bills and Big bills come from real commitments, and
	 * Spend is frozen on the period row — but the two savings buckets are
	 * whatever is LEFT, and nothing could compute "left" without knowing what
	 * was expected to arrive.
	 *
	 * Rule 1's waterfall, in order: Bills full, Big bills full, Emergency fund
	 * minimum, remainder to Spending. Only the Emergency fund step is added
	 * here, because Bills, Big bills and Spend already have their rows above —
	 * recomputing them from the waterfall would fight invariant 6, which says
	 * the period's frozen figure is the one that governs.
	 *
	 * A shortfall funds nothing rather than part-funding: putting a token
	 * amount into the emergency fund while Big bills is short is how a known
	 * cost becomes a raided emergency fund three months later.
	 */
	const expected = expectedIncome(userId, period.startsOn, period.endsOn);
	if (expected > 0) {
		const split = waterfall(expected, committed, accrual, Number.MAX_SAFE_INTEGER);
		if (!split.short && split.bufferMinor > 0) {
			const buffer = db
				.select()
				.from(schema.account)
				.where(and(owns(schema.account), eq(schema.account.kind, 'buffer')))
				.get();
			// Whatever is left after the three funded buckets. Spend is already
			// claimed above at its frozen figure, so this is the true remainder.
			const left = expected - committed - accrual - period.spendAllocMinor;
			if (buffer && left > 0) rows.push({ accountId: buffer.id, amountMinor: left });
		}
	}

	for (const r of rows) {
		db.insert(schema.allocation)
			.values({ periodId: period.id, accountId: r.accountId, amountMinor: r.amountMinor, userId })
			.onConflictDoNothing()
			.run();
	}

	/*
	 * Recompute the Bills row while the transfer is still unmade.
	 *
	 * `onConflictDoNothing` above is right for Spend and Irregulars, whose
	 * figures are fixed when the period opens (invariant 6 — recording income
	 * must not rewrite an open period's allowance). Bills is different: adding
	 * a subscription mid-week changes what the transfer should be, and leaving
	 * the row stale means the Bills page and the money map quote two different
	 * numbers for the same transfer.
	 *
	 * Strictly guarded to executedAt IS NULL. Once you have actually moved the
	 * money, the row is a record of what happened and is not up for revision.
	 */
	if (bills) {
		db.update(schema.allocation)
			.set({ amountMinor: committed })
			.where(
				and(
					owns(schema.allocation),
					eq(schema.allocation.periodId, period.id),
					eq(schema.allocation.accountId, bills.id),
					isNull(schema.allocation.executedAt)
				)
			)
			.run();
	}
}

export function checklist(userId: number, period: Period, today: string): ChecklistItem[] {
	const { db, owns } = forUser(userId);
	return db
		.select({
			id: schema.allocation.id,
			accountId: schema.allocation.accountId,
			accountName: schema.account.name,
			amountMinor: schema.allocation.amountMinor,
			executedAt: schema.allocation.executedAt
		})
		.from(schema.allocation)
		.innerJoin(schema.account, eq(schema.account.id, schema.allocation.accountId))
		.where(and(owns(schema.allocation), eq(schema.allocation.periodId, period.id)))
		.orderBy(asc(schema.account.sortOrder))
		.all()
		.map((r) => ({ ...r, ageDays: daysBetween(period.startsOn, today) }));
}

/** Unexecuted allocations old enough to be worth interrupting Today for. */
export function stalePending(userId: number, period: Period, today: string): ChecklistItem[] {
	return checklist(userId, period, today).filter(
		(i) => i.executedAt === null && i.ageDays >= STALE_AFTER_DAYS
	);
}

/**
 * Tick one item off. Moves the asserted balance too — the user just told us
 * they made the transfer, and an untouched balance would contradict them at
 * the next review.
 */
export function executeAllocation(userId: number, allocationId: number, now: Date = new Date()): void {
	const { db, owns } = forUser(userId);
	db.transaction((tx) => {
		const alloc = tx
			.select()
			.from(schema.allocation)
			.where(
				and(
					owns(schema.allocation),
					eq(schema.allocation.id, allocationId),
					isNull(schema.allocation.executedAt)
				)
			)
			.get();
		if (!alloc) return;

		tx.update(schema.allocation)
			.set({ executedAt: now.toISOString() })
			.where(and(owns(schema.allocation), eq(schema.allocation.id, allocationId)))
			.run();

		const account = tx
			.select()
			.from(schema.account)
			.where(and(owns(schema.account), eq(schema.account.id, alloc.accountId)))
			.get();
		if (!account) return;

		tx.update(schema.account)
			.set({
				balanceMinor: account.balanceMinor + alloc.amountMinor,
				balanceAsOf: now.toISOString().slice(0, 10)
			})
			.where(and(owns(schema.account), eq(schema.account.id, account.id)))
			.run();
	});
}
