/**
 * Refunds — effect matrix op 8 (A3.3).
 *
 * A refund is money coming back from something already recorded as spending.
 * It lowers spending on the original expense's category. It is NEVER earned
 * income: income means money arriving from outside the system, and a refund
 * is the system giving you your own money back. Mixing the two inflates both
 * income and the band — exactly the double-count the spec forbids.
 *
 * Why the row is a positive amount with `refund_of` set:
 * `txn.amount_minor` carries `CHECK (amount_minor > 0)` from migration 0001,
 * and relaxing it means a table rebuild. So the refund row is a normal
 * positive spending row in the original's category with `refund_of` pointing
 * at the original. Every place that sums spending nets refunds out in the SUM
 * expression — sum sites change in one sweep, the shared WHERE never does.
 *
 * Effects, exactly (effect matrix, op 8):
 * - Physical accounts: +amount on the account the refund lands in, chosen
 *   explicitly. The refund is physically back, so the balance reflects it.
 * - Reports: one linked spending row, netted out of every spending sum.
 * - Reservations / obligations: none.
 * - Daily guide: a refund may raise today's remaining band; that is
 *   arithmetic, not a reward.
 *
 * Rules: partial and repeated refunds are allowed; the sum of one txn's
 * refunds can never exceed the txn's amount; the refund's own date governs
 * its report effect — historical reports are never rewritten.
 */

import { and, eq, sql } from 'drizzle-orm';
import { forUser, schema } from './db';
import { openPeriodOn } from './rollover';
import { localToday } from './clock';
import { loadSettings } from './today';

export interface RefundInput {
	/** The spending txn the money is coming back from. */
	originalTxnId: number;
	amountMinor: number;
	/** Where the money physically landed back. */
	accountId: number;
	/** The refund's own date; the refund row's `spent_on`. */
	refundedOn: string;
	note?: string | null;
	clientUuid?: string | null;
}

/** Thrown with a plain-language message the route can show as-is. */
export class RefundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RefundError';
	}
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(iso: string): boolean {
	if (!ISO_DATE.test(iso)) return false;
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export interface RefundResult {
	id: number;
	/** The original txn's id, echoed for the UI. */
	refundOf: number;
}

export function recordRefund(
	userId: number,
	input: RefundInput,
	now: Date = new Date()
): RefundResult {
	if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
		throw new RefundError('Enter an amount above zero.');
	}
	if (!isRealDate(input.refundedOn)) {
		throw new RefundError('Enter a real date.');
	}

	const settings = loadSettings(userId);
	if (!settings) throw new RefundError('Split is not initialised yet.');

	const { db, owns } = forUser(userId);

	if (input.refundedOn > localToday(settings.timezone, now)) {
		throw new RefundError('A refund cannot be dated in the future.');
	}

	const result = db.transaction((tx) => {
		if (input.clientUuid) {
			const existing = tx.select().from(schema.txn)
				.where(and(owns(schema.txn), eq(schema.txn.clientUuid, input.clientUuid))).get();
			if (existing) {
				if (existing.refundOf !== input.originalTxnId) {
					throw new RefundError('That submission was already used for a different entry.');
				}
				return { id: existing.id };
			}
		}
		const original = tx
			.select()
			.from(schema.txn)
			.where(and(owns(schema.txn), eq(schema.txn.id, input.originalTxnId)))
			.get();
		if (!original) throw new RefundError('That expense is not in your records.');
		if (original.refundOf !== null) {
			throw new RefundError('Refunds go on the original expense, not on another refund.');
		}

		if (input.refundedOn < original.spentOn) {
			throw new RefundError('A refund cannot be dated before the expense.');
		}

		const alreadyBack =
			tx
				.select({ n: sql<number>`coalesce(sum(${schema.txn.amountMinor}), 0)` })
				.from(schema.txn)
				.where(and(owns(schema.txn), eq(schema.txn.refundOf, original.id)))
				.get()?.n ?? 0;
		if (alreadyBack + input.amountMinor > original.amountMinor) {
			const left = original.amountMinor - alreadyBack;
			throw new RefundError(
				left <= 0
					? 'That expense is already fully refunded.'
					: `Only ${left} centavos of that expense is left to refund.`
			);
		}

		const account = tx
			.select()
			.from(schema.account)
			.where(and(owns(schema.account), eq(schema.account.id, input.accountId)))
			.get();
		if (!account) throw new RefundError('Pick where the money landed back.');
		if (account.archivedAt) throw new RefundError('That account is archived.');

		const inserted = tx
			.insert(schema.txn)
			.values({
				spentOn: input.refundedOn,
				amountMinor: input.amountMinor,
				category: original.category,
				planned: original.planned,
				note: input.note ?? null,
				// Same period binding as every other entry (entry.ts:259): the
				// sweep must net this row inside its own period.
				periodId: openPeriodOn(userId, input.refundedOn)?.id ?? null,
				// A refund follows the money back to its trip so home-currency
				// trip sums net. Local-currency sums stay gross: the refund is
				// typed in home currency and carries no amount_local_minor.
				tripId: original.tripId,
				enteredAt: now.toISOString(),
				clientUuid: input.clientUuid ?? null,
				refundOf: original.id,
				userId
			})
			.returning({ id: schema.txn.id })
			.get();

		// The one balance effect: the money is physically back in that account.
		tx.update(schema.account)
			.set({
				balanceMinor: account.balanceMinor + input.amountMinor,
				balanceAsOf: input.refundedOn
			})
			.where(and(owns(schema.account), eq(schema.account.id, account.id)))
			.run();

		return inserted;
	});

	return { id: result.id, refundOf: input.originalTxnId };
}
