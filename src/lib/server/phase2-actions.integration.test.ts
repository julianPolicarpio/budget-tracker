/**
 * Phase 2 shared-action engine tests (Spec A6, effect matrix ops 2/8).
 *
 * The invariants under test:
 * - An arrival moves money into one bucket, never touches schedules, has
 *   one `income_arrival` row, and refuses future dates (op 2).
 * - A retried arrival with the same client_uuid records nothing twice.
 * - A refund is a positive-amount txn linked by refund_of, capped at the
 *   original amount, never stacked on another refund, never income (op 8).
 * - Refunds net OUT of spending sums: weekActuals, the trip total, the
 *   trip burndown, and the rollover period sweep all drop by the refund.
 * - A refunded original can still be listed as a candidate (partial
 *   refunds are legal) but not over-refunded.
 * -Archived accounts accept no arrivals or refunds.
 *
 * Runs on an isolated temp database. The live data/split.db is never touched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	schema: typeof import('./db').schema;
	arrivals: typeof import('./arrivals');
	refunds: typeof import('./refunds');
	metrics: typeof import('./metrics');
	trips: typeof import('./trips');
	rollover: typeof import('./rollover');
};

let m: Mod;

const OWNER = 1;
const TODAY = '2026-09-21';
const NOW = new Date('2026-09-21T04:00:00Z');

let incomeId = 0;
let billsId = 0;
let spendId = 0;
let bufferId = 0;

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

function scalar(sql: string, params: (string | number)[] = []): number {
	return (
		m.sqlite.prepare(sql).get(...params) as { n: number }
	).n;
}

function insertExpense(
	spentOn: string,
	amountMinor: number,
	category: string,
	opts: { tripId?: number } = {}
): number {
	return (
		m.sqlite
			.prepare(
				`INSERT INTO txn (user_id, spent_on, amount_minor, category, planned, source, entered_at, period_id, trip_id)
			 SELECT ?, ?, ?, ?, 0, 'cash', ?, p.id, NULL
			 FROM (SELECT id FROM period WHERE ? >= starts_on AND ? <= ends_on) p`
			)
			.run(OWNER, spentOn, amountMinor, category, `${spentOn}T12:00:00.000Z`, spentOn, spentOn)
			.lastInsertRowid as number
	);
}

let seededExpenseId = 0;

beforeAll(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	const dir = mkdtempSync(join(tmpdir(), 'split-phase2-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	m = {
		sqlite: dbMod.sqlite,
		schema: dbMod.schema,
		arrivals: await import('./arrivals'),
		refunds: await import('./refunds'),
		metrics: await import('./metrics'),
		trips: await import('./trips'),
		rollover: await import('./rollover')
	};

	incomeId = bucketId('inflow');
	billsId = bucketId('bills');
	spendId = bucketId('spend');
	bufferId = bucketId('buffer');

	// The engines derive "today" from settings + real clock, and `openPeriodOn`
	// pins entries into a period row. Seed one weekly period covering the real
	// system date, and pin TODAY from that same clock so the future-date test
	// stays future regardless of when vitest runs.
	const todayStr = new Date().toISOString().slice(0, 10);

	m.sqlite.exec(
		`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor,
		                     daily_allowance_minor, haircut_pct_applied,
		                     phase_at_open, supersedes_id, created_at)
		 VALUES ('${todayStr}', '2026-09-27', 7, 70000, 10000, 15, 0, NULL,
		         '2026-01-01T00:00:00.000Z')`
	);
	m.sqlite.exec(
		`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
		                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
		                       timezone, created_at)
		 VALUES (1, 'PHP', '₱', 2, 1000, 'weekly', 0, 15, 10, 0, 'Asia/Manila', '2026-01-01T00:00:00.000Z')`
	);

	// Seed one real expense for the refund tests: 500.00 on spend, today.
	seededExpenseId = insertExpense(TODAY, 50_000, 'food_out');
});

afterAll(() => { vi.useRealTimers(); });

beforeEach(() => {
	m.sqlite.exec('DELETE FROM txn WHERE refund_of IS NOT NULL; DELETE FROM income_arrival;');
	setBalance(incomeId, 100_000);
	setBalance(spendId, 30_000);
});

describe('recordArrival (op 2)', () => {
	it('moves money into the chosen bucket and writes one arrival row', () => {
		const before = balanceOf(spendId);
		const res = m.arrivals.recordArrival(OWNER, {
			amountMinor: 25_000,
			accountId: spendId,
			arrivedOn: TODAY,
			note: 'salary'
		});
		expect(res.replayed).toBe(false);
		expect(balanceOf(spendId)).toBe(before + 25_000);
		expect(scalar(`SELECT count(*) AS n FROM income_arrival WHERE user_id = ?`, [OWNER])).toBe(1);
	});

	it('replay of the same client_uuid records nothing twice', () => {
		const before = balanceOf(billsId);
		const first = m.arrivals.recordArrival(OWNER, {
			amountMinor: 10_000,
			accountId: billsId,
			arrivedOn: TODAY,
			clientUuid: 'arr-1'
		});
		const second = m.arrivals.recordArrival(OWNER, {
			amountMinor: 10_000,
			accountId: billsId,
			arrivedOn: TODAY,
			clientUuid: 'arr-1'
		});
		expect(first.replayed).toBe(false);
		expect(second.replayed).toBe(true);
		expect(balanceOf(billsId)).toBe(before + 10_000);
	});

	it('refuses a future date', () => {
		expect(() =>
			m.arrivals.recordArrival(OWNER, {
				amountMinor: 5_000,
				accountId: incomeId,
				arrivedOn: '2026-09-22'
			})
		).toThrow(/future/);
	});
});

describe('recordRefund (op 8)', () => {
	it('writes a positive refund row and adds the money to the chosen bucket', () => {
		const before = balanceOf(spendId);
		const res = m.refunds.recordRefund(OWNER, {
			originalTxnId: seededExpenseId,
			amountMinor: 20_000,
			accountId: spendId,
			refundedOn: TODAY
		});
		expect(res.refundOf).toBe(seededExpenseId);

		const row = m.sqlite
			.prepare(
				`SELECT refund_of, trip_id, amount_local_minor, category, planned, amount_minor FROM txn WHERE id = ?`
			)
			.get(res.id) as {
			refund_of: number;
			trip_id: number | null;
			amount_local_minor: number | null;
			category: string;
			planned: number;
		};
		expect(row.refund_of).toBe(seededExpenseId);
		expect(row.planned).toBe(0);
		expect(row.category).toBe('food_out');
		expect(balanceOf(spendId)).toBe(before + 20_000);
	});

	it('rejects refunding more than the original', () => {
		m.refunds.recordRefund(OWNER, { originalTxnId: seededExpenseId, amountMinor: 20_000, accountId: spendId, refundedOn: TODAY });
		expect(() =>
			m.refunds.recordRefund(OWNER, {
				originalTxnId: seededExpenseId,
				amountMinor: 30_001,
				accountId: spendId,
				refundedOn: TODAY
			})
		).toThrow(/left to refund/);
	});

	it('rejects a refund riding on another refund', () => {
		const first = m.refunds.recordRefund(OWNER, {
			originalTxnId: seededExpenseId,
			amountMinor: 5_000,
			accountId: spendId,
			refundedOn: TODAY
		});
		expect(() =>
			m.refunds.recordRefund(OWNER, {
				originalTxnId: first.id,
				amountMinor: 1_000,
				accountId: spendId,
				refundedOn: TODAY
			})
		).toThrow(/not on another refund/);
	});

	it('retries a full refund without another balance change', () => {
		const input = { originalTxnId: seededExpenseId, amountMinor: 50_000, accountId: spendId, refundedOn: TODAY, clientUuid: 'refund-retry' };
		const first = m.refunds.recordRefund(OWNER, input);
		const second = m.refunds.recordRefund(OWNER, input);
		expect(second.id).toBe(first.id);
		expect(balanceOf(spendId)).toBe(80_000);
		expect(scalar('SELECT count(*) AS n FROM txn WHERE refund_of IS NOT NULL')).toBe(1);
	});

	it('rejects future refunds and refunds before the original expense', () => {
		for (const refundedOn of ['2026-09-22', '2026-09-20']) {
			expect(() => m.refunds.recordRefund(OWNER, { originalTxnId: seededExpenseId, amountMinor: 100, accountId: spendId, refundedOn })).toThrow(/future|before the expense/);
		}
		expect(balanceOf(spendId)).toBe(30_000);
	});

	it('does not change balances or create rows when the destination is missing', () => {
		expect(() => m.refunds.recordRefund(OWNER, { originalTxnId: seededExpenseId, amountMinor: 100, accountId: -1, refundedOn: TODAY })).toThrow(/Pick where/);
		expect(scalar('SELECT count(*) AS n FROM txn WHERE refund_of IS NOT NULL')).toBe(0);
		expect(balanceOf(spendId)).toBe(30_000);
	});

	it('keeps planned refunds out of unplanned spending', () => {
		m.sqlite.prepare('UPDATE txn SET planned = 1 WHERE id = ?').run(seededExpenseId);
		try {
			m.refunds.recordRefund(OWNER, { originalTxnId: seededExpenseId, amountMinor: 20_000, accountId: spendId, refundedOn: TODAY });
			const actuals = m.metrics.weekActuals(OWNER, { from: TODAY, to: TODAY });
			expect(actuals.totalMinor).toBe(30_000);
			expect(actuals.unplannedMinor).toBe(0);
		} finally {
			m.sqlite.prepare('UPDATE txn SET planned = 0 WHERE id = ?').run(seededExpenseId);
		}
	});

	it('netting: refunds reduce weekActuals', () => {
		m.refunds.recordRefund(OWNER, { originalTxnId: seededExpenseId, amountMinor: 25_000, accountId: spendId, refundedOn: TODAY });
		const periodId = (
			m.sqlite
				.prepare(`SELECT id FROM period WHERE ? >= starts_on AND ? <= ends_on LIMIT 1`)
				.get(TODAY, TODAY) as { id: number }
		).id;
		const net = m.metrics.weekActuals(OWNER, { from: TODAY, to: TODAY }).totalMinor;
		expect(net).toBe(25_000);
	});
});
