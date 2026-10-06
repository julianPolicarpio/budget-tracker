/**
 * `irregulars/+page.server.ts`'s `fund` action (Spec A3.2, effect matrix op 5,
 * Phase 2 Task 2a).
 *
 * `financial-integrity.integration.test.ts` already covers
 * `fundPlannedExpense()` itself directly; this exercises the same operation
 * through the actual form action the browser's `use:enhance` calls, per
 * `subscriptions-page-action.integration.test.ts`'s own pattern for this —
 * money parsing, the `FundingError` → 409 translation, and precise (not
 * blanket) client_uuid replay handling.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	page: typeof import('../../routes/irregulars/+page.server');
	reservations: typeof import('./reservations');
};

let m: Mod;
const USER = 1;
const TZ = 'Asia/Manila';
const TODAY = '2026-01-01';

let irregularsId = 0;
let bufferId = 0;

function bucketId(kind: string): number {
	return (
		m.sqlite.prepare(`SELECT id FROM account WHERE user_id = ? AND kind = ?`).get(USER, kind) as {
			id: number;
		}
	).id;
}

function setBalance(accountId: number, balanceMinor: number): void {
	m.sqlite.prepare(`UPDATE account SET balance_minor = ?, balance_as_of = ? WHERE id = ?`).run(
		balanceMinor,
		TODAY,
		accountId
	);
}

function balanceOf(accountId: number): number {
	return (
		m.sqlite.prepare(`SELECT balance_minor AS b FROM account WHERE id = ?`).get(accountId) as {
			b: number;
		}
	).b;
}

function seedIrregular(label: string, amountMinor: number): number {
	const res = m.sqlite
		.prepare(
			`INSERT INTO irregular (label, amount_minor, is_estimate, cadence, next_due_on, padding_pct, created_at, user_id)
			 VALUES (?, ?, 1, 'monthly', '2026-10-01', 25, ?, ?)`
		)
		.run(label, amountMinor, `${TODAY}T00:00:00.000Z`, USER);
	return Number(res.lastInsertRowid);
}

/** Invoke a form action the way SvelteKit does, with just the bits it reads. */
async function invoke(action: string, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const actions = m.page.actions as Record<string, (e: unknown) => Promise<unknown>>;
	try {
		return {
			result: await actions[action]({
				request: new Request('http://localhost/', { method: 'POST', body }),
				locals: { userId: USER }
			})
		};
	} catch (err) {
		if (isRedirect(err)) return { redirected: true, status: err.status, location: err.location };
		throw err;
	}
}

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-irrpage-')), 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));
	dbMod.sqlite.exec(
		`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
		                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
		                       timezone, created_at)
		 VALUES (1, 'PHP', '₱', 2, 1000, 'weekly', 0, 15, 10, 0, '${TZ}', '2026-01-01T00:00:00.000Z')`
	);

	m = {
		sqlite: dbMod.sqlite,
		page: await import('../../routes/irregulars/+page.server'),
		reservations: await import('./reservations')
	};

	irregularsId = bucketId('irregulars');
	bufferId = bucketId('buffer');
});

beforeEach(() => {
	m.sqlite.exec('DELETE FROM expense_reservation;');
});

describe('fund action', () => {
	it('case 1 (sourceAccountId set) moves money and redirects', async () => {
		setBalance(bufferId, 20_000);
		setBalance(irregularsId, 5_000);
		const expenseId = seedIrregular('Case 1 via route', 10_000);

		const res = await invoke('fund', {
			irregularId: String(expenseId),
			accountId: String(irregularsId),
			sourceAccountId: String(bufferId),
			amount: '100.00'
		});

		expect(res.redirected).toBe(true);
		expect(balanceOf(bufferId)).toBe(10_000);
		expect(balanceOf(irregularsId)).toBe(15_000);
		expect(m.reservations.outstandingFor(USER, expenseId, irregularsId)).toBe(10_000);
	});

	it('case 2 (no sourceAccountId) assigns in place, no balance moves', async () => {
		setBalance(irregularsId, 8_000);
		const expenseId = seedIrregular('Case 2 via route', 8_000);

		const res = await invoke('fund', {
			irregularId: String(expenseId),
			accountId: String(irregularsId),
			amount: '80.00'
		});

		expect(res.redirected).toBe(true);
		expect(balanceOf(irregularsId)).toBe(8_000);
		expect(m.reservations.outstandingFor(USER, expenseId, irregularsId)).toBe(8_000);
	});

	it('over-assignment surfaces the FundingError as a 409 on the amount field', async () => {
		setBalance(irregularsId, 5_000);
		const expenseId = seedIrregular('Too much via route', 20_000);

		const res = await invoke('fund', {
			irregularId: String(expenseId),
			accountId: String(irregularsId),
			amount: '200.00' // only 50.00 unassigned
		});

		expect(res.redirected).toBeFalsy();
		const failure = res.result as { status: number; data: Record<string, unknown> };
		expect(failure.status).toBe(409);
		expect(failure.data.field).toBe('amount');
		expect(typeof failure.data.error).toBe('string');
		expect(failure.data.rawAmount).toBe('200.00');
		expect(m.reservations.outstandingFor(USER, expenseId, irregularsId)).toBe(0);
	});

	it('rejects a zero or blank amount before touching the engine', async () => {
		const expenseId = seedIrregular('Zero amount', 1_000);
		const res = await invoke('fund', {
			irregularId: String(expenseId),
			accountId: String(irregularsId),
			amount: '0'
		});
		const failure = res.result as { status: number; data: Record<string, unknown> };
		expect(failure.status).toBe(400);
		expect(failure.data.field).toBe('amount');
	});

	it('a repeated client_uuid is a successful double-submit, not a second reservation', async () => {
		setBalance(irregularsId, 6_000);
		const expenseId = seedIrregular('Idempotent via route', 6_000);
		const fields = {
			irregularId: String(expenseId),
			accountId: String(irregularsId),
			amount: '60.00',
			clientUuid: 'route-fund-1'
		};

		const first = await invoke('fund', fields);
		const second = await invoke('fund', fields);

		expect(first.redirected).toBe(true);
		expect(second.redirected).toBe(true);
		expect(m.reservations.outstandingFor(USER, expenseId, irregularsId)).toBe(6_000);
		const rows = m.sqlite
			.prepare(`SELECT count(*) AS c FROM expense_reservation WHERE client_uuid = ?`)
			.get('route-fund-1') as { c: number };
		expect(rows.c).toBe(1);
	});
});
