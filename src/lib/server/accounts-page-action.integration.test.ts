/**
 * `accounts/+page.server.ts`'s `addAccount` action (Spec A2, Phase 2 Task 2a).
 *
 * `financial-integrity.integration.test.ts` already covers `createAccount()`
 * itself directly; this exercises the same operation through the actual form
 * action the browser's `use:enhance` calls, per
 * `subscriptions-page-action.integration.test.ts`'s own pattern for this —
 * money parsing (`parseMoney`, never `Number()`), validation echoing entered
 * values back (Spec A2: "validation errors retain entered values"), and the
 * six-purpose `kind` guard.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	page: typeof import('../../routes/accounts/+page.server');
	accounts: typeof import('./accounts');
};

let m: Mod;
const USER = 1;
const TZ = 'Asia/Manila';

/** Invoke a form action the way SvelteKit does, with just the bits it reads. */
async function invoke(action: string, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const actions = m.page.actions as Record<string, (e: unknown) => Promise<unknown>>;
	try {
		return { result: await actions[action]({
			request: new Request('http://localhost/', { method: 'POST', body }),
			locals: { userId: USER }
		}) };
	} catch (err) {
		if (isRedirect(err)) return { redirected: true, status: err.status, location: err.location };
		throw err;
	}
}

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-accpage-')), 'split.db');
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
		page: await import('../../routes/accounts/+page.server'),
		accounts: await import('./accounts')
	};
});

describe('addAccount action', () => {
	it('creates an account and redirects on success', async () => {
		const res = await invoke('addAccount', {
			name: 'Second Savings',
			kind: 'grow',
			institution: 'Bank of Somewhere',
			balance: '1,250.50',
			isCommitted: '1'
		});
		expect(res.redirected).toBe(true);
		expect(res.status).toBe(303);

		const row = m.accounts.listAccounts(USER).find((a) => a.name === 'Second Savings');
		expect(row).toBeDefined();
		expect(row!.slug).toBe('second-savings');
		expect(row!.institution).toBe('Bank of Somewhere');
		// parseMoney, not Number()/parseFloat — 1,250.50 pesos is 125050 centavos.
		expect(row!.balanceMinor).toBe(125_050);
		expect(row!.isCommitted).toBe(1);
	});

	it('rejects a blank name and echoes the other entered fields back', async () => {
		const res = await invoke('addAccount', {
			name: '   ',
			kind: 'bills',
			institution: 'Keep Me',
			balance: '500'
		});
		expect(res.redirected).toBeFalsy();
		const failure = res.result as { status: number; data: Record<string, unknown> };
		expect(failure.status).toBe(400);
		expect(failure.data.field).toBe('name');
		expect(failure.data.rawInstitution).toBe('Keep Me');
		expect(failure.data.rawBalance).toBe('500');
	});

	it('rejects a kind outside the six fixed purposes', async () => {
		const res = await invoke('addAccount', { name: 'Crypto Wallet', kind: 'crypto' });
		const failure = res.result as { status: number; data: Record<string, unknown> };
		expect(failure.status).toBe(400);
		expect(failure.data.field).toBe('kind');
		// Nothing was written for the rejected kind.
		expect(m.accounts.listAccounts(USER).some((a) => a.name === 'Crypto Wallet')).toBe(false);
	});

	it('rejects an unparseable balance and does not create the account', async () => {
		const res = await invoke('addAccount', { name: 'Bad Balance', kind: 'spend', balance: 'lots' });
		const failure = res.result as { status: number; data: Record<string, unknown> };
		expect(failure.status).toBe(400);
		expect(failure.data.field).toBe('balance');
		expect(m.accounts.listAccounts(USER).some((a) => a.name === 'Bad Balance')).toBe(false);
	});

	it('a blank balance opens the account at zero rather than failing', async () => {
		const res = await invoke('addAccount', { name: 'No Opening Balance', kind: 'spend' });
		expect(res.redirected).toBe(true);
		const row = m.accounts.listAccounts(USER).find((a) => a.name === 'No Opening Balance');
		expect(row!.balanceMinor).toBe(0);
		expect(row!.balanceAsOf).toBeNull();
	});
});
