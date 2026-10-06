import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../scripts/apply-migrations.js';

let sqlite: import('better-sqlite3').Database;
let actions: typeof import('./+page.server').actions;

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-today-actions-')), 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
	const db = await import('$lib/server/db');
	sqlite = db.sqlite;
	applyMigrations(sqlite, resolve('migrations'));
	sqlite
		.prepare(
			`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
			 period_kind, week_starts_on, haircut_pct, band_pct, phase, timezone, created_at, user_id)
			 VALUES (1,'PHP','₱',2,1000,'weekly',0,15,10,0,'Asia/Manila','2026-08-01T00:00:00Z',1)`
		)
		.run();
	actions = (await import('./+page.server')).actions;
});

async function submit(name: string, fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	const request = new Request('http://localhost/', { method: 'POST', body });
	const handler = actions[name];
	if (!handler) throw new Error(`Missing Today action: ${name}`);
	return handler({ request, locals: { userId: 1 } } as never);
}

describe('Today quick actions', () => {
	it('saves a debt through the shared Today action', async () => {
		expect(
			await submit('addDebt', {
				label: 'Today retry card',
				balance: '1000',
				minPayment: '100',
				apr: '18',
				clientUuid: 'today-add-debt-1'
			})
		).toEqual({ added: true });
		expect(
			sqlite.prepare("SELECT COUNT(*) AS n FROM debt WHERE label = 'Today retry card'").get()
		).toMatchObject({ n: 1 });
	});

	it('saves a subscription through the shared Today action', async () => {
		expect(
			await submit('quickAddBill', {
				label: 'Today retry bill',
				amount: '1100',
				cadence: 'monthly',
			nextChargeOn: '2026-10-22',
				clientUuid: 'today-add-bill-1'
			})
		).toEqual({ added: true });
		expect(
			sqlite.prepare("SELECT COUNT(*) AS n FROM subscription WHERE label = 'Today retry bill'").get()
		).toMatchObject({ n: 1 });
	});
});
