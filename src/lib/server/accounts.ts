/**
 * The five accounts, the IOU rule, and named goals (Spec §8.3).
 *
 * Balances are user-asserted, not derived from logged flows (Spec §14 Q3).
 * Deriving them sounds cleaner and drifts within a month, because you will not
 * log every bank fee — and the weekly act of typing the number is itself part
 * of the intervention (F7).
 */

import { and, asc, desc, eq, isNull, isNotNull } from 'drizzle-orm';
import { forUser, schema } from './db';
import { assertNotEatingReserved } from './reservations';
import { openPeriodOn } from './rollover';
import type { Account, Goal, Transfer } from './db/schema';
import type { TxnSource } from './entry';

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

export function listAccounts(userId: number): Account[] {
	const { db, owns } = forUser(userId);
	return db
		.select()
		.from(schema.account)
		.where(and(owns(schema.account), isNull(schema.account.archivedAt)))
		.orderBy(asc(schema.account.sortOrder))
		.all();
}

export function accountByKind(userId: number, kind: Account['kind']): Account | null {
	const { db, owns } = forUser(userId);
	return (
		db
			.select()
			.from(schema.account)
			.where(and(owns(schema.account), eq(schema.account.kind, kind)))
			.get() ?? null
	);
}

export interface NewAccount {
	name: string;
	kind: Account['kind'];
	institution?: string | null;
	hasCard?: boolean;
	isCommitted?: boolean;
	/** Opening balance. Defaults to 0. */
	balanceMinor?: number;
}

/**
 * Turn a free-typed name into a slug: lowercase, every run of non-alphanumeric
 * characters collapses to one hyphen, ends trimmed. Collision resolution is
 * the caller's job — this only proposes the bare form.
 */
function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return s || 'account';
}

/**
 * Add an account (Spec A2 "Add an account"). This creates a *bucket* — one of
 * the six fixed purposes `kind` enumerates, never a seventh. A bucket is
 * where money is physically held; it is not the same thing as a goal, which
 * subdivides the savings side only and must not be counted as a second
 * account holding the same money (Spec A0). Multiple accounts may share a
 * `kind` — a second card under Spend, say — distinguished by `slug`.
 *
 * Slug derivation and de-duplication happen inside the transaction, so two
 * concurrent creates of the same name cannot both read "free" and then race
 * to insert it — `idx_account_user_slug` would only catch that afterward, as
 * a crash rather than a clean `-2` suffix.
 *
 * `asOf` arrives as an argument rather than being derived here, exactly as
 * `assertBalance` takes it. Resolving a local date needs settings, and
 * importing `today.ts` to read them would close an
 * `accounts -> today -> trips -> accounts` import cycle. Every caller already
 * holds settings by the time it gets here; the date is one more argument.
 */
export function createAccount(userId: number, input: NewAccount, asOf: string): number {
	const name = input.name.trim();
	if (!name) throw new Error('Name it something you will recognise.');

	const balanceMinor = input.balanceMinor ?? 0;
	if (!Number.isInteger(balanceMinor) || balanceMinor < 0) {
		throw new Error('Opening balance must be zero or more.');
	}

	// Only a real opening balance gets an as-of date — a zero-balance account
	// has nothing yet asserted about it, same as a bucket before its first
	// correction in assertBalance.
	const balanceAsOf = balanceMinor > 0 ? asOf : null;

	const { db, owns } = forUser(userId);
	const base = slugify(name);

	return db.transaction((tx) => {
		const existing = tx
			.select({ slug: schema.account.slug, sortOrder: schema.account.sortOrder })
			.from(schema.account)
			.where(owns(schema.account))
			.all();

		const taken = new Set(existing.map((r) => r.slug));
		let slug = base;
		for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;

		const sortOrder = existing.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 1;

		return tx
			.insert(schema.account)
			.values({
				slug,
				name,
				kind: input.kind,
				institution: input.institution ?? null,
				isCommitted: input.isCommitted ? 1 : 0,
				hasCard: input.hasCard ? 1 : 0,
				balanceMinor,
				balanceAsOf,
				sortOrder,
				userId
			})
			.returning({ id: schema.account.id })
			.get().id;
	});
}

export interface AssertBalanceResult {
	accountId: number;
	oldMinor: number;
	newMinor: number;
	correctionId: number;
}

/**
 * Assert a bucket balance (Spec §14 Q3 — the weekly act of typing the number).
 *
 * A3.3 safe corrections: the previous value is remembered in
 * `balance_correction` (append-only), so an assertion is a correction with a
 * remembered before and after — never an inferred income or expense. A new
 * balance may not eat money already promised to a planned expense (A3.2):
 * the reservation guard runs inside the same transaction.
 */
export function assertBalance(
	userId: number,
	accountId: number,
	balanceMinor: number,
	asOf: string,
	note?: string | null,
	now: Date = new Date()
): AssertBalanceResult {
	const { db, owns } = forUser(userId);
	if (!Number.isInteger(balanceMinor) || balanceMinor < 0) {
		throw new Error('Balance must be zero or more.');
	}
	const current = db
		.select({ balanceMinor: schema.account.balanceMinor })
		.from(schema.account)
		.where(and(owns(schema.account), eq(schema.account.id, accountId)))
		.get();
	if (!current) throw new Error('Unknown account');

	return db.transaction((tx) => {
		assertNotEatingReserved(userId, accountId, balanceMinor);
		tx.update(schema.account)
			.set({ balanceMinor, balanceAsOf: asOf })
			.where(and(owns(schema.account), eq(schema.account.id, accountId)))
			.run();
		const correctionId = tx
			.insert(schema.balanceCorrection)
			.values({
				accountId,
				oldMinor: current.balanceMinor,
				newMinor: balanceMinor,
				correctedOn: asOf,
				note: note ?? null,
				createdAt: now.toISOString(),
				userId
			})
			.returning({ id: schema.balanceCorrection.id })
			.get().id;
		return { accountId, oldMinor: current.balanceMinor, newMinor: balanceMinor, correctionId };
	});
}

export interface TransferInput {
	fromAccountId: number;
	toAccountId: number;
	amountMinor: number;
	movedOn: string;
	iouReason?: string | null;
	iouRepayBy?: string | null;
	/** Optional fee (A3.1): a real spending txn linked to the transfer. */
	feeMinor?: number | null;
	feePayFrom?: TxnSource | null;
	/** A3.6: a retried submit after an uncertain response records nothing twice. */
	clientUuid?: string | null;
}

/**
 * Record a transfer, moving both asserted balances.
 *
 * Throws `IouRequired` when money leaves a savings account without a note.
 * That is not paperwork: the note converts an invisible leak into a visible,
 * countable event, and reading four of them in a row at the quarterly review
 * does more than any rule prohibiting the transfer would have.
 */
export function recordTransfer(userId: number, input: TransferInput, now: Date = new Date()): Transfer {
	const { db, owns } = forUser(userId);
	const from = db
		.select()
		.from(schema.account)
		.where(and(owns(schema.account), eq(schema.account.id, input.fromAccountId)))
		.get();
	const to = db
		.select()
		.from(schema.account)
		.where(and(owns(schema.account), eq(schema.account.id, input.toAccountId)))
		.get();

	if (!from || !to) throw new Error('Unknown account');
	if (from.id === to.id) throw new Error('An account cannot transfer to itself');
	if (input.amountMinor <= 0) throw new Error('Transfer amount must be above zero');

	const needsIou = (IOU_REQUIRED_FROM as readonly string[]).includes(from.kind);
	const reason = input.iouReason?.trim() || null;
	if (needsIou && !reason) throw new IouRequired(from.name);

	// A3.6 idempotency: a unique violation on client_uuid aborts the whole
	// transaction (including the balance moves), so the existing row is read
	// and returned after — the retried submit records nothing twice.
	if (input.clientUuid) {
		const existing = db
			.select()
			.from(schema.transfer)
			.where(and(owns(schema.transfer), eq(schema.transfer.clientUuid, input.clientUuid)))
			.get();
		if (existing) return existing;
	}

	try {
		return db.transaction((tx) => {
			const feeMinor =
				input.feeMinor !== null && input.feeMinor !== undefined && input.feeMinor > 0
					? input.feeMinor
					: null;

			// A3.1: the fee is a real spending txn on the account that paid it.
			// The principal move itself is never a txn — it is not spending.
			let feeTxnId: number | null = null;
			if (feeMinor !== null) {
				const periodId = openPeriodOn(userId, input.movedOn)?.id ?? null;
				feeTxnId = tx
					.insert(schema.txn)
					.values({
						spentOn: input.movedOn,
						amountMinor: feeMinor,
						category: 'other',
						planned: 0,
						note: 'Transfer fee',
						periodId,
						enteredAt: now.toISOString(),
						label: 'Transfer fee',
						source: input.feePayFrom ?? 'unknown',
						leafId: null,
						userId
					})
					.returning({ id: schema.txn.id })
					.get().id;
			}

			const id = tx
				.insert(schema.transfer)
				.values({
					movedOn: input.movedOn,
					fromAccountId: from.id,
					toAccountId: to.id,
					amountMinor: input.amountMinor,
					feeTxnId,
					clientUuid: input.clientUuid ?? null,
					iouReason: needsIou ? reason : (reason ?? null),
					iouRepayBy: input.iouRepayBy?.trim() || null,
					createdAt: now.toISOString(),
					userId
				})
				.returning({ id: schema.transfer.id })
				.get().id;

			// The fee leaves the same source bucket: total outflow is the
			// principal plus the fee. Conservation holds to the centavo.
			tx.update(schema.account)
				.set({
					balanceMinor: from.balanceMinor - input.amountMinor - (feeMinor ?? 0),
					balanceAsOf: input.movedOn
				})
				.where(and(owns(schema.account), eq(schema.account.id, from.id)))
				.run();
			tx.update(schema.account)
				.set({ balanceMinor: to.balanceMinor + input.amountMinor, balanceAsOf: input.movedOn })
				.where(and(owns(schema.account), eq(schema.account.id, to.id)))
				.run();

			return tx
				.select()
				.from(schema.transfer)
				.where(and(owns(schema.transfer), eq(schema.transfer.id, id)))
				.get()!;
		});
	} catch (err) {
		if (input.clientUuid) {
			const existing = db
				.select()
				.from(schema.transfer)
				.where(and(owns(schema.transfer), eq(schema.transfer.clientUuid, input.clientUuid)))
				.get();
			if (existing) return existing;
		}
		throw err;
	}
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
export function openIous(userId: number, today: string): OpenIou[] {
	const { db, owns } = forUser(userId);
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
		.where(
			and(owns(schema.transfer), isNotNull(schema.transfer.iouReason), isNull(schema.transfer.repaidAt))
		)
		.orderBy(asc(schema.transfer.movedOn))
		.all()
		.map((r) => {
			const to = db
				.select({ name: schema.account.name })
				.from(schema.account)
				.where(and(owns(schema.account), eq(schema.account.id, r.toAccountId)))
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

export function repayIou(userId: number, transferId: number, now: Date = new Date()): void {
	const { db, owns } = forUser(userId);
	db.update(schema.transfer)
		.set({ repaidAt: now.toISOString() })
		.where(and(owns(schema.transfer), eq(schema.transfer.id, transferId)))
		.run();
}

export function recentTransfers(userId: number, limit = 10) {
	const { db, owns } = forUser(userId);
	return db
		.select()
		.from(schema.transfer)
		.where(owns(schema.transfer))
		.orderBy(desc(schema.transfer.movedOn), desc(schema.transfer.id))
		.limit(limit)
		.all();
}

// ─── Goals ────────────────────────────────────────────────────────────────

export function listGoals(userId: number): (Goal & { accountName: string })[] {
	const { db, owns } = forUser(userId);
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
			userId: schema.goal.userId,
			accountName: schema.account.name
		})
		.from(schema.goal)
		.innerJoin(schema.account, eq(schema.account.id, schema.goal.accountId))
		.where(and(owns(schema.goal), eq(schema.goal.status, 'active')))
		.orderBy(asc(schema.goal.id))
		.all();
}

export function upsertGoal(
	userId: number,
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
	const { db, owns } = forUser(userId);
	if (g.id) {
		db.update(schema.goal)
			.set({
				accountId: g.accountId,
				label: g.label,
				targetMinor: g.targetMinor,
				savedMinor: g.savedMinor,
				targetDate: g.targetDate
			})
			.where(and(owns(schema.goal), eq(schema.goal.id, g.id)))
			.run();
		return;
	}
	db.insert(schema.goal)
		.values({ ...g, status: 'active', createdAt: now.toISOString(), userId })
		.run();
}
