/**
 * Debt payments (Spec A3.3, effect matrix op 7).
 *
 * The payment has an explicit source: money really leaves that account, so
 * its recorded balance falls. The principal never becomes a spending txn —
 * logging the purchase and the repayment must not both count as spending
 * (the credit-card rule). Debt balance falls in the same transaction; the
 * debt closes when it reaches zero.
 */

import { and, eq } from 'drizzle-orm';
import { forUser, schema } from './db';

export interface DebtPaymentResult {
	paymentId: number;
	remainingMinor: number;
	closed: boolean;
}

export function recordDebtPayment(
	userId: number,
	input: { debtId: number; paidOn: string; amountMinor: number; sourceAccountId?: number | null },
	now: Date = new Date()
): DebtPaymentResult {
	if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
		throw new Error('Enter an amount above zero.');
	}

	const { db, owns } = forUser(userId);
	return db.transaction((tx) => {
		const debt = tx
			.select()
			.from(schema.debt)
			.where(and(owns(schema.debt), eq(schema.debt.id, input.debtId)))
			.get();
		if (!debt) throw new Error('Unknown debt.');
		if (debt.closedOn) throw new Error('That debt is already paid off.');

		if (input.sourceAccountId) {
			const source = tx
				.select({ id: schema.account.id })
				.from(schema.account)
				.where(and(owns(schema.account), eq(schema.account.id, input.sourceAccountId)))
				.get();
			if (!source) throw new Error('Unknown source bucket.');

			// The money really left this bucket. A plain subtraction, like a
			// transfer — if it goes negative, that is true until corrected.
			const current = tx
				.select({ balanceMinor: schema.account.balanceMinor })
				.from(schema.account)
				.where(and(owns(schema.account), eq(schema.account.id, source.id)))
				.get();
			tx.update(schema.account)
				.set({
					balanceMinor: (current?.balanceMinor ?? 0) - input.amountMinor,
					balanceAsOf: input.paidOn
				})
				.where(and(owns(schema.account), eq(schema.account.id, source.id)))
				.run();
		}

		const paymentId = tx
			.insert(schema.debtPayment)
			.values({
				debtId: debt.id,
				paidOn: input.paidOn,
				amountMinor: input.amountMinor,
				sourceAccountId: input.sourceAccountId ?? null,
				userId
			})
			.returning({ id: schema.debtPayment.id })
			.get().id;

		const remaining = Math.max(0, debt.balanceMinor - input.amountMinor);
		tx.update(schema.debt)
			.set({ balanceMinor: remaining, closedOn: remaining === 0 ? input.paidOn : null })
			.where(and(owns(schema.debt), eq(schema.debt.id, debt.id)))
			.run();

		void now;
		return { paymentId, remainingMinor: remaining, closed: remaining === 0 };
	});
}
