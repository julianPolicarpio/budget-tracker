/**
 * The five accounts, the IOU rule, and named goals (Spec §8.3).
 *
 * Balances are user-asserted, not derived from logged flows (Spec §14 Q3).
 * Deriving them sounds cleaner and drifts within a month, because you will not
 * log every bank fee — and the weekly act of typing the number is itself part
 * of the intervention (F7).
 */

import { and, asc, desc, eq, isNull, isNotNull } from 'drizzle-orm';
import { db, schema } from './db';
import type { Account, Goal, Transfer } from './db/schema';

/**
 * Moving money *out* of one of these requires an IOU. Straight from the
 * winning arm of the Drexler trial: date, amount, why, and when it comes back.
 * No approval, no guilt — just the note (Rule 3).
 */
const IOU_REQUIRED_FROM = ['irregulars', 'buffer', 'grow'] as const;

export class IouRequired extends Error {
	constructor(fromName: string) {
		super(`Moving money out of ${fromName} needs a one-line IOU: why, and when it comes back.`);
		this.name = 'IouRequired';
	}
}

export function listAccounts(): Account[] {
	return db
		.select()
		.from(schema.account)
		.where(isNull(schema.account.archivedAt))
		.orderBy(asc(schema.account.sortOrder))
		.all();
}

export function accountByKind(kind: Account['kind']): Account | null {
	return db.select().from(schema.account).where(eq(schema.account.kind, kind)).get() ?? null;
}

export function assertBalance(accountId: number, balanceMinor: number, asOf: string): void {
	db.update(schema.account)
		.set({ balanceMinor, balanceAsOf: asOf })
		.where(eq(schema.account.id, accountId))
		.run();
}

export interface TransferInput {
	fromAccountId: number;
	toAccountId: number;
	amountMinor: number;
	movedOn: string;
	iouReason?: string | null;
	iouRepayBy?: string | null;
}

/**
 * Record a transfer, moving both asserted balances.
 *
 * Throws `IouRequired` when money leaves a savings account without a note.
 * That is not paperwork: the note converts an invisible leak into a visible,
 * countable event, and reading four of them in a row at the quarterly review
 * does more than any rule prohibiting the transfer would have.
 */
export function recordTransfer(input: TransferInput, now: Date = new Date()): Transfer {
	const from = db
		.select()
		.from(schema.account)
		.where(eq(schema.account.id, input.fromAccountId))
		.get();
	const to = db.select().from(schema.account).where(eq(schema.account.id, input.toAccountId)).get();

	if (!from || !to) throw new Error('Unknown account');
	if (from.id === to.id) throw new Error('An account cannot transfer to itself');
	if (input.amountMinor <= 0) throw new Error('Transfer amount must be above zero');

	const needsIou = (IOU_REQUIRED_FROM as readonly string[]).includes(from.kind);
	const reason = input.iouReason?.trim() || null;
	if (needsIou && !reason) throw new IouRequired(from.name);

	return db.transaction((tx) => {
		const id = tx
			.insert(schema.transfer)
			.values({
				movedOn: input.movedOn,
				fromAccountId: from.id,
				toAccountId: to.id,
				amountMinor: input.amountMinor,
				iouReason: needsIou ? reason : (reason ?? null),
				iouRepayBy: input.iouRepayBy?.trim() || null,
				createdAt: now.toISOString()
			})
			.returning({ id: schema.transfer.id })
			.get().id;

		tx.update(schema.account)
			.set({ balanceMinor: from.balanceMinor - input.amountMinor, balanceAsOf: input.movedOn })
			.where(eq(schema.account.id, from.id))
			.run();
		tx.update(schema.account)
			.set({ balanceMinor: to.balanceMinor + input.amountMinor, balanceAsOf: input.movedOn })
			.where(eq(schema.account.id, to.id))
			.run();

		return tx.select().from(schema.transfer).where(eq(schema.transfer.id, id)).get()!;
	});
}

export interface OpenIou {
	id: number;
	movedOn: string;
	amountMinor: number;
	fromName: string;
	toName: string;
	reason: string;
	repayBy: string | null;
	overdue: boolean;
}

/**
 * Every unrepaid IOU, oldest first.
 *
 * Do not summarise this into a count. Reading four in a row is the mechanism;
 * "4 open IOUs" is a number you scroll past (Spec §8.3.5).
 */
export function openIous(today: string): OpenIou[] {
	const fromAcc = schema.account;
	return db
		.select({
			id: schema.transfer.id,
			movedOn: schema.transfer.movedOn,
			amountMinor: schema.transfer.amountMinor,
			fromName: fromAcc.name,
			reason: schema.transfer.iouReason,
			repayBy: schema.transfer.iouRepayBy,
			toAccountId: schema.transfer.toAccountId
		})
		.from(schema.transfer)
		.innerJoin(fromAcc, eq(fromAcc.id, schema.transfer.fromAccountId))
		.where(and(isNotNull(schema.transfer.iouReason), isNull(schema.transfer.repaidAt)))
		.orderBy(asc(schema.transfer.movedOn))
		.all()
		.map((r) => {
			const to = db
				.select({ name: schema.account.name })
				.from(schema.account)
				.where(eq(schema.account.id, r.toAccountId))
				.get();
			return {
				id: r.id,
				movedOn: r.movedOn,
				amountMinor: r.amountMinor,
				fromName: r.fromName,
				toName: to?.name ?? '—',
				reason: r.reason ?? '',
				repayBy: r.repayBy,
				overdue: r.repayBy !== null && r.repayBy < today
			};
		});
}

export function repayIou(transferId: number, now: Date = new Date()): void {
	db.update(schema.transfer)
		.set({ repaidAt: now.toISOString() })
		.where(eq(schema.transfer.id, transferId))
		.run();
}

export function recentTransfers(limit = 10) {
	return db
		.select()
		.from(schema.transfer)
		.orderBy(desc(schema.transfer.movedOn), desc(schema.transfer.id))
		.limit(limit)
		.all();
}

// ─── Goals ────────────────────────────────────────────────────────────────

export function listGoals(): (Goal & { accountName: string })[] {
	return db
		.select({
			id: schema.goal.id,
			accountId: schema.goal.accountId,
			label: schema.goal.label,
			targetMinor: schema.goal.targetMinor,
			savedMinor: schema.goal.savedMinor,
			imageRef: schema.goal.imageRef,
			targetDate: schema.goal.targetDate,
			status: schema.goal.status,
			createdAt: schema.goal.createdAt,
			accountName: schema.account.name
		})
		.from(schema.goal)
		.innerJoin(schema.account, eq(schema.account.id, schema.goal.accountId))
		.where(eq(schema.goal.status, 'active'))
		.orderBy(asc(schema.goal.id))
		.all();
}

export function upsertGoal(
	g: {
		id?: number;
		accountId: number;
		label: string;
		targetMinor: number | null;
		savedMinor: number;
		targetDate: string | null;
	},
	now: Date = new Date()
): void {
	if (g.id) {
		db.update(schema.goal)
			.set({
				accountId: g.accountId,
				label: g.label,
				targetMinor: g.targetMinor,
				savedMinor: g.savedMinor,
				targetDate: g.targetDate
			})
			.where(eq(schema.goal.id, g.id))
			.run();
		return;
	}
	db.insert(schema.goal)
		.values({ ...g, status: 'active', createdAt: now.toISOString() })
		.run();
}
