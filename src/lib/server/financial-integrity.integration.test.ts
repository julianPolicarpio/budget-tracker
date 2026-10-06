/**
 * Financial-integrity regression tests (Spec A3, effect matrix ops 4/5/6/7/8/9/11).
 *
 * The invariants under test:
 * - A transfer with a fee is one transaction: both balances move, the fee
 *   becomes a real spending txn linked to the transfer (A3.1), and the
 *   six-bucket sum is conserved (fee included).
 * - A retried submit with the same client_uuid records nothing twice (A3.6).
 * - A balance correction remembers old and new, and may never eat money
 *   already promised to a planned expense (A3.3).
 * - Reservations partition one bucket: the same money cannot fund two
 *   expenses, releasing dissolves without moving balances (A3.2).
 * - A debt payment leaves a real bucket and closes the debt at zero (op 7).
 * - Settlement draws the Irregulars bucket down and consumes the
 *   reservation — the promise becomes the payment (op 6).
 * - createAccount (Spec A2) derives and de-duplicates a slug, rejects a bad
 *   opening balance, assigns the next sortOrder, only stamps balanceAsOf on a
 *   real balance, and is scoped to its owner like everything else.
 *
 * Runs on an isolated temp database. The live data/split.db is never touched.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	schema: typeof import('./db').schema;
	accounts: typeof import('./accounts');
	reservations: typeof import('./reservations');
	debts: typeof import('./debts');
	irregulars: typeof import('./irregulars');
};

let m: Mod;

/** The user migrations seed with all six buckets. */
const OWNER = 1;
/** A second user, for the tenancy check — created lazily by the block that needs it. */
const STRANGER = 2;
const TODAY = '2026-09-21';

let incomeId = 0;
let billsId = 0;
let irregularsId = 0;
let bufferId = 0;
let spendId = 0;

function bucketId(kind: string): number {
	return (
		m.sqlite.prepare(`SELECT id FROM account WHERE user_id = ? AND kind = ?`).get(OWNER, kind) as {
			id: number;
		}
	).id;
}

function setBalance(accountId: number, balanceMinor: number): void {
	m.sqlite
		.prepare(`UPDATE account SET balance_minor = ?, balance_as_of = ? WHERE id = ?`)
		.run(balanceMinor, TODAY, accountId);
}

function balanceOf(accountId: number): number {
	return (
		m.sqlite.prepare(`SELECT balance_minor AS b FROM account WHERE id = ?`).get(accountId) as {
			b: number;
		}
	).b;
}

function count(table: string, where = ''): number {
	return (
		m.sqlite.prepare(`SELECT count(*) AS c FROM ${table} ${where}`).get() as { c: number }
	).c;
}

/** Sum of every bucket's asserted balance for one user — the six-bucket sum
 * that every operation but an income arrival must conserve (effect matrix,
 * cross-cutting invariant 1). */
function totalMoney(userId: number): number {
	return (
		m.sqlite
			.prepare(`SELECT coalesce(sum(balance_minor), 0) AS t FROM account WHERE user_id = ?`)
			.get(userId) as { t: number }
	).t;
}

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-integrity-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	m = {
		sqlite: dbMod.sqlite,
		schema: dbMod.schema,
		accounts: await import('./accounts'),
		reservations: await import('./reservations'),
		debts: await import('./debts'),
		irregulars: await import('./irregulars')
	};

	incomeId = bucketId('inflow');
	billsId = bucketId('bills');
	irregularsId = bucketId('irregulars');
	bufferId = bucketId('buffer');
	spendId = bucketId('spend');
});

// Reservations partition the unassigned pool, so one test's promises must
// never shrink another test's money. Balances are NOT reset here: the
// transfer-retry test depends on the first submit's recorded outcome.
beforeEach(() => {
	m.sqlite.prepare(`DELETE FROM expense_reservation`).run();
});

describe('transfer with fee (A3.1, op 4)', () => {
	it('moves both buckets and records the fee as a linked spending txn', () => {
		setBalance(incomeId, 100_000);
		setBalance(billsId, 0);

		const res = m.accounts.recordTransfer(OWNER, {
			fromAccountId: incomeId,
			toAccountId: billsId,
			amountMinor: 50_000,
			movedOn: TODAY,
			feeMinor: 1_500,
			clientUuid: 'fee-1'
		});

		expect(balanceOf(incomeId)).toBe(48_500);
		expect(balanceOf(billsId)).toBe(50_000);
		expect(res.feeTxnId).not.toBeNull();

		const fee = m.sqlite
			.prepare(`SELECT amount_minor, category, source, spent_on FROM txn WHERE id = ?`)
			.get(res.feeTxnId) as { amount_minor: number; category: string; source: string; spent_on: string };
		expect(fee.amount_minor).toBe(1_500);
		expect(fee.category).toBe('other');
		expect(fee.source).toBe('unknown');
		expect(fee.spent_on).toBe(TODAY);

		// Conservation: the six-bucket sum is unchanged by a transfer+fee —
		// the fee is part of what left Income, not extra money.
		const total = m.sqlite
			.prepare(`SELECT coalesce(sum(balance_minor),0) AS t FROM account WHERE user_id = ?`)
			.get(OWNER) as { t: number };
		// The fee is genuine spending — it leaves the system. Only the principal
		// move is conserved between buckets: 100_000 − 1_500.
		expect(total.t).toBe(98_500);
	});

	it('a retried submit with the same client_uuid records nothing twice', () => {
		const before = count('transfer');
		m.accounts.recordTransfer(OWNER, {
			fromAccountId: incomeId,
			toAccountId: billsId,
			amountMinor: 50_000,
			movedOn: TODAY,
			feeMinor: 1_500,
			clientUuid: 'fee-1'
		});
		expect(count('transfer')).toBe(before);
		expect(balanceOf(incomeId)).toBe(48_500);
	});
});

describe('balance corrections (A3.3, op 11)', () => {
	it('remembers old and new balance in an append-only row', () => {
		setBalance(incomeId, 60_000);
		const res = m.accounts.assertBalance(OWNER, incomeId, 61_500, TODAY, 'cash count');
		expect(res.oldMinor).toBe(60_000);
		expect(res.newMinor).toBe(61_500);
		const row = m.sqlite
			.prepare(`SELECT old_minor, new_minor, note FROM balance_correction WHERE id = ?`)
			.get(res.correctionId) as { old_minor: number; new_minor: number; note: string };
		expect(row.old_minor).toBe(60_000);
		expect(row.new_minor).toBe(61_500);
		expect(row.note).toBe('cash count');
	});

	it('refuses a correction that eats money reserved for a planned expense', () => {
		setBalance(irregularsId, 20_000);
		m.reservations.fundPlannedExpense(OWNER, {
			irregularId: seedIrregular('Correction guard', 5_000),
			accountId: irregularsId,
			amountMinor: 8_000
		});

		expect(() => m.accounts.assertBalance(OWNER, irregularsId, 5_000, TODAY)).toThrow(
			/set aside/i
		);
		// The failed correction must not have written anything.
		expect(balanceOf(irregularsId)).toBe(20_000);
		expect(count('balance_correction')).toBe(1); // only the first test's row
	});
});

describe('reservations (A3.2, ops 5/8/9)', () => {
	it('case 2: assigning in-bucket partitions the balance without moving money on ANY bucket', () => {
		setBalance(irregularsId, 20_000);
		const before = totalMoney(OWNER);
		const otherBalances = [incomeId, billsId, bufferId, spendId].map(balanceOf);
		const expenseId = seedIrregular('Sari-sari restock', 8_000);
		m.reservations.fundPlannedExpense(OWNER, {
			irregularId: expenseId,
			accountId: irregularsId,
			amountMinor: 8_000
		});

		expect(balanceOf(irregularsId)).toBe(20_000);
		// Case 2 moves nothing, anywhere — not just the destination bucket.
		expect([incomeId, billsId, bufferId, spendId].map(balanceOf)).toEqual(otherBalances);
		expect(totalMoney(OWNER)).toBe(before);
		expect(m.reservations.outstandingFor(OWNER, expenseId, irregularsId)).toBe(8_000);
		expect(m.reservations.unassignedInBucket(OWNER, irregularsId)).toBe(12_000);
	});

	it('overfunding the same bucket throws and writes nothing', () => {
		setBalance(irregularsId, 12_000);
		const expenseId = seedIrregular('Too much', 15_000);
		const reservationsBefore = count('expense_reservation');
		expect(() =>
			m.reservations.fundPlannedExpense(OWNER, {
				irregularId: expenseId,
				accountId: irregularsId,
				amountMinor: 15_000 // only 12_000 unassigned
			})
		).toThrow(/not yet promised/i);
		expect(m.reservations.unassignedInBucket(OWNER, irregularsId)).toBe(12_000);
		expect(balanceOf(irregularsId)).toBe(12_000);
		// The throw must not have written a row — not even one the balance
		// arithmetic would otherwise hide.
		expect(count('expense_reservation')).toBe(reservationsBefore);
	});

	/*
	 * The refusal message quotes a figure, so it is subject to Invariant 5
	 * like any other money on screen. It used to build that figure by hand as
	 * `₱${minor / 100}` — float arithmetic outside `$lib/money`, a hardcoded
	 * symbol, and two hardcoded decimals. A zero-decimal currency is where
	 * that breaks loudest: ¥12,000 would have been rendered "₱120.00", off by
	 * a factor of a hundred and in the wrong currency, in the one sentence
	 * telling the user how much they actually have.
	 */
	it('quotes the refused amount in the user currency, including zero-decimal ones', () => {
		setBalance(irregularsId, 12_000);
		const expenseId = seedIrregular('Yen trouble', 15_000);
		const seedSettings = (minorUnits: number, symbol: string) =>
			m.sqlite
				.prepare(
					`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
					   period_kind, week_starts_on, haircut_pct, band_pct, phase, timezone, created_at, user_id)
					 VALUES (1, 'XXX', ?, ?, 1000, 'weekly', 0, 15, 10, 0, 'Asia/Manila', 'x', ?)`
				)
				.run(symbol, minorUnits, OWNER);
		const clearSettings = () =>
			m.sqlite.prepare(`DELETE FROM settings WHERE user_id = ?`).run(OWNER);
		const refusal = () => {
			try {
				m.reservations.fundPlannedExpense(OWNER, {
					irregularId: expenseId,
					accountId: irregularsId,
					amountMinor: 15_000
				});
				return '';
			} catch (err) {
				return err instanceof Error ? err.message : '';
			}
		};

		// `finally`, because a failing expectation here would otherwise leave a
		// settings row behind and fail the unrelated describe below on the
		// unique index — one real bug reported as two, in the wrong places.
		try {
			// JPY: 12000 minor units at zero decimals is ¥12,000, not ₱120.00.
			seedSettings(0, '¥');
			expect(refusal()).toContain('¥12,000');
			expect(refusal()).not.toContain('₱');
			clearSettings();

			// PHP: the same 12000 is ₱120.00 at two decimals.
			seedSettings(2, '₱');
			expect(refusal()).toContain('₱120.00');
		} finally {
			clearSettings();
		}
	});

	it('the same money cannot fund two expenses', () => {
		setBalance(irregularsId, 10_000);
		const expenseA = seedIrregular('Takes it all', 10_000);
		const expenseB = seedIrregular('Gets nothing', 5_000);

		m.reservations.fundPlannedExpense(OWNER, {
			irregularId: expenseA,
			accountId: irregularsId,
			amountMinor: 10_000
		});
		expect(m.reservations.unassignedInBucket(OWNER, irregularsId)).toBe(0);

		expect(() =>
			m.reservations.fundPlannedExpense(OWNER, {
				irregularId: expenseB,
				accountId: irregularsId,
				amountMinor: 1
			})
		).toThrow(/not yet promised/i);
		expect(m.reservations.outstandingFor(OWNER, expenseB, irregularsId)).toBe(0);
	});

	it('funding writes no txn row — funding is not spending (op 5)', () => {
		setBalance(irregularsId, 9_000);
		const expenseId = seedIrregular('Not a purchase', 9_000);
		const txnsBefore = count('txn');
		m.reservations.fundPlannedExpense(OWNER, {
			irregularId: expenseId,
			accountId: irregularsId,
			amountMinor: 9_000
		});
		expect(count('txn')).toBe(txnsBefore);
	});

	it('case 1: funding from a savings bucket moves money, auto-fills the IOU note, and conserves the six-bucket sum', () => {
		setBalance(bufferId, 30_000);
		setBalance(irregularsId, 20_000);
		const before = totalMoney(OWNER);
		const expenseId = seedIrregular('Laptop fund', 12_000);
		const res = m.reservations.fundPlannedExpense(OWNER, {
			irregularId: expenseId,
			accountId: irregularsId,
			amountMinor: 12_000,
			sourceAccountId: bufferId
		});

		expect(res.moved).toBe(true);
		expect(balanceOf(bufferId)).toBe(18_000);
		expect(balanceOf(irregularsId)).toBe(32_000);
		// A move between buckets, however it is dressed, conserves the sum.
		expect(totalMoney(OWNER)).toBe(before);
		const note = m.sqlite
			.prepare(`SELECT note FROM expense_reservation WHERE id = ?`)
			.get(res.id) as { note: string | null };
		expect(note.note).toBe('Set aside for Laptop fund');
	});

	it('a release dissolves the promise without touching any balance', () => {
		const expenseId = seedIrregular('Release me', 5_000);
		setBalance(irregularsId, 20_000);
		const fundId = m.reservations.fundPlannedExpense(OWNER, {
			irregularId: expenseId,
			accountId: irregularsId,
			amountMinor: 5_000
		}).id;
		setBalance(irregularsId, 20_000); // freeze the baseline

		m.reservations.releaseReservation(OWNER, {
			irregularId: expenseId,
			accountId: irregularsId,
			amountMinor: 2_000
		});
		expect(m.reservations.outstandingFor(OWNER, expenseId, irregularsId)).toBe(3_000);
		expect(balanceOf(irregularsId)).toBe(20_000);
		void fundId;
	});

	it('releasing more than outstanding throws', () => {
		const expenseId = seedIrregular('Over-release', 1_000);
		m.reservations.fundPlannedExpense(OWNER, {
			irregularId: expenseId,
			accountId: irregularsId,
			amountMinor: 1_000
		});
		expect(() =>
			m.reservations.releaseReservation(OWNER, {
				irregularId: expenseId,
				accountId: irregularsId,
				amountMinor: 2_000
			})
		).toThrow(/set aside/i);
	});

	it('a retried fund with the same client_uuid returns the first row and creates no second reservation', () => {
		const expenseId = seedIrregular('Idempotent fund', 1_500);
		setBalance(irregularsId, 20_000);
		const before = count('expense_reservation');
		const first = m.reservations.fundPlannedExpense(OWNER, {
			irregularId: expenseId,
			accountId: irregularsId,
			amountMinor: 1_500,
			clientUuid: 'fund-1'
		});
		const second = m.reservations.fundPlannedExpense(OWNER, {
			irregularId: expenseId,
			accountId: irregularsId,
			amountMinor: 1_500,
			clientUuid: 'fund-1'
		});
		expect(second.id).toBe(first.id);
		expect(m.reservations.outstandingFor(OWNER, expenseId, irregularsId)).toBe(1_500);
		expect(count('expense_reservation')).toBe(before + 1);
	});
});

describe('debt payments (A3.3, op 7)', () => {
	it('leaves the source bucket, never becoming a spending txn', () => {
		setBalance(spendId, 25_000);
		const debtId = seedDebt('Credit card', 40_000);
		const res = m.debts.recordDebtPayment(OWNER, {
			debtId,
			paidOn: TODAY,
			amountMinor: 15_000,
			sourceAccountId: spendId
		});

		expect(balanceOf(spendId)).toBe(10_000);
		expect(res.remainingMinor).toBe(25_000);
		expect(res.closed).toBe(false);
		// The credit-card rule: the purchase was logged once. The payment is
		// not spending again — no txn row may exist for it.
		const source = m.sqlite
			.prepare(`SELECT source_account_id FROM debt_payment WHERE id = ?`)
			.get(res.paymentId) as { source_account_id: number };
		expect(source.source_account_id).toBe(spendId);
	});

	it('closes the debt at zero and lets the bucket go negative as an honest IOU', () => {
		const debtId = seedDebt('Finish me', 25_000);
		setBalance(spendId, 10_000);
		const res = m.debts.recordDebtPayment(OWNER, {
			debtId,
			paidOn: TODAY,
			amountMinor: 25_000,
			sourceAccountId: spendId
		});
		expect(res.closed).toBe(true);
		expect(balanceOf(spendId)).toBe(-15_000);
		const closed = m.sqlite
			.prepare(`SELECT closed_on FROM debt WHERE id = ?`)
			.get(debtId) as { closed_on: string | null };
		expect(closed.closed_on).toBe(TODAY);
	});

	it('refuses a payment on a closed debt and works without a source', () => {
		const debtId = seedDebt('Already done', 5_000);
		m.debts.recordDebtPayment(OWNER, { debtId, paidOn: TODAY, amountMinor: 5_000 });
		setBalance(spendId, 7_000);
		expect(() =>
			m.debts.recordDebtPayment(OWNER, { debtId, paidOn: TODAY, amountMinor: 1_000 })
		).toThrow(/paid off/i);
	});
});

describe('settlement consumes the reservation (op 6)', () => {
	it('draws Irregulars down and dissolves the promise up to the actual cost', () => {
		setBalance(irregularsId, 50_000);
		const expenseId = seedIrregular('Registration fee', 10_000);
		m.reservations.fundPlannedExpense(OWNER, {
			irregularId: expenseId,
			accountId: irregularsId,
			amountMinor: 10_000
		});
		const instanceId = seedInstance(expenseId, 12_500);

		m.irregulars.settleInstance(OWNER, instanceId, 12_000, TODAY);

		// Drawdown happened on the bucket...
		expect(balanceOf(irregularsId)).toBe(38_000);
		// ...and the promise became the payment: min(10_000, 12_000).
		expect(m.reservations.outstandingFor(OWNER, expenseId, irregularsId)).toBe(0);
		const inst = m.sqlite
			.prepare(`SELECT status, actual_minor FROM irregular_instance WHERE id = ?`)
			.get(instanceId) as { status: string; actual_minor: number };
		expect(inst.status).toBe('settled');
		expect(inst.actual_minor).toBe(12_000);
	});

	it('an underfunded settlement consumes only what was promised', () => {
		setBalance(irregularsId, 30_000);
		const expenseId = seedIrregular('Underfunded', 4_000);
		m.reservations.fundPlannedExpense(OWNER, {
			irregularId: expenseId,
			accountId: irregularsId,
			amountMinor: 4_000
		});
		const instanceId = seedInstance(expenseId, 9_000);

		m.irregulars.settleInstance(OWNER, instanceId, 9_000, TODAY);
		expect(balanceOf(irregularsId)).toBe(21_000);
		expect(m.reservations.outstandingFor(OWNER, expenseId, irregularsId)).toBe(0);
	});
});

describe('createAccount (Spec A2, NEW)', () => {
	// A second user, so the tenancy case below has somebody to be invisible
	// to. Settings are seeded because the route action reads them for the
	// local date it hands `createAccount`; the engine itself never does.
	beforeAll(() => {
		m.sqlite
			.prepare(
				`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
				   period_kind, week_starts_on, haircut_pct, band_pct, phase, timezone, created_at, user_id)
				 VALUES (1, 'PHP', '₱', 2, 1000, 'weekly', 0, 15, 10, 0, 'Asia/Manila', 'x', ?)`
			)
			.run(OWNER);
		m.sqlite.prepare(`INSERT INTO app_user (id, created_at) VALUES (?, 'x')`).run(STRANGER);
	});

	function accountRow(id: number) {
		return m.sqlite
			.prepare(
				`SELECT slug, name, kind, balance_minor AS balanceMinor, balance_as_of AS balanceAsOf,
				        sort_order AS sortOrder, user_id AS userId
				 FROM account WHERE id = ?`
			)
			.get(id) as {
			slug: string;
			name: string;
			kind: string;
			balanceMinor: number;
			balanceAsOf: string | null;
			sortOrder: number;
			userId: number;
		};
	}

	it('derives a slug from the name', () => {
		const id = m.accounts.createAccount(OWNER, { name: 'Travel Card!!', kind: 'spend' }, TODAY);
		expect(accountRow(id).slug).toBe('travel-card');
	});

	it('suffixes a colliding slug rather than crashing on the unique index', () => {
		const first = m.accounts.createAccount(OWNER, { name: 'Second Buffer', kind: 'buffer' }, TODAY);
		const second = m.accounts.createAccount(OWNER, { name: 'Second Buffer', kind: 'buffer' }, TODAY);
		const third = m.accounts.createAccount(OWNER, { name: 'second buffer', kind: 'buffer' }, TODAY);
		expect(accountRow(first).slug).toBe('second-buffer');
		expect(accountRow(second).slug).toBe('second-buffer-2');
		expect(accountRow(third).slug).toBe('second-buffer-3');
	});

	it('rejects an empty or whitespace-only name', () => {
		expect(() => m.accounts.createAccount(OWNER, { name: '', kind: 'spend' }, TODAY)).toThrow();
		expect(() => m.accounts.createAccount(OWNER, { name: '   ', kind: 'spend' }, TODAY)).toThrow();
	});

	it('rejects a non-integer opening balance', () => {
		expect(() =>
			m.accounts.createAccount(OWNER, { name: 'Fractional', kind: 'spend', balanceMinor: 100.5 }, TODAY)
		).toThrow();
	});

	it('rejects a negative opening balance', () => {
		expect(() =>
			m.accounts.createAccount(OWNER, { name: 'In the hole', kind: 'spend', balanceMinor: -500 }, TODAY)
		).toThrow();
	});

	it('assigns sortOrder one past the current max for that user', () => {
		const maxBefore = (
			m.sqlite
				.prepare(`SELECT coalesce(max(sort_order), 0) AS m FROM account WHERE user_id = ?`)
				.get(OWNER) as { m: number }
		).m;
		const id = m.accounts.createAccount(OWNER, { name: 'Sort Order Check', kind: 'grow' }, TODAY);
		expect(accountRow(id).sortOrder).toBe(maxBefore + 1);
	});

	it('stamps balanceAsOf only when the opening balance is above zero', () => {
		const zero = m.accounts.createAccount(OWNER, { name: 'Opens At Zero', kind: 'bills' }, TODAY);
		const funded = m.accounts.createAccount(
			OWNER,
			{ name: 'Opens Funded', kind: 'bills', balanceMinor: 5_000 },
			TODAY
		);
		expect(accountRow(zero).balanceAsOf).toBeNull();
		expect(accountRow(funded).balanceAsOf).toBe(TODAY);
		expect(accountRow(funded).balanceMinor).toBe(5_000);
	});

	it('is scoped to its owner — a second user cannot see it', () => {
		const id = m.accounts.createAccount(OWNER, { name: 'Owner Only', kind: 'spend' }, TODAY);
		expect(accountRow(id).userId).toBe(OWNER);
		expect(m.accounts.listAccounts(STRANGER).some((a) => a.id === id)).toBe(false);
		const strangerSlugCollision = m.sqlite
			.prepare(`SELECT count(*) AS c FROM account WHERE user_id = ? AND slug = 'owner-only'`)
			.get(STRANGER) as { c: number };
		expect(strangerSlugCollision.c).toBe(0);
	});
});

/** Direct seed: one live planned expense, returning its id. */
function seedIrregular(label: string, amountMinor: number): number {
	const res = m.sqlite
		.prepare(
			`INSERT INTO irregular (label, amount_minor, is_estimate, cadence, next_due_on, padding_pct, created_at, user_id)
			 VALUES (?, ?, 1, 'monthly', '2026-10-01', 25, ?, ?)`
		)
		.run(label, amountMinor, `${TODAY}T00:00:00.000Z`, OWNER);
	return Number(res.lastInsertRowid);
}

/** Direct seed: one projected instance for a settlement test. */
function seedInstance(irregularId: number, expectedMinor: number): number {
	const res = m.sqlite
		.prepare(
			`INSERT INTO irregular_instance (irregular_id, due_on, expected_minor, status, user_id)
			 VALUES (?, '2026-10-01', ?, 'projected', ?)`
		)
		.run(irregularId, expectedMinor, OWNER);
	return Number(res.lastInsertRowid);
}

/** Direct seed: one open debt, returning its id. */
function seedDebt(label: string, balanceMinor: number): number {
	const res = m.sqlite
		.prepare(
			`INSERT INTO debt (label, balance_minor, apr_bp, min_payment_minor, opened_on, user_id)
			 VALUES (?, ?, 1850, 1000, '2026-01-01', ?)`
		)
		.run(label, balanceMinor, OWNER);
	return Number(res.lastInsertRowid);
}
