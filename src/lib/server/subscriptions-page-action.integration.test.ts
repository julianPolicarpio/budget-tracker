/**
 * `subscriptions/+page.server.ts`'s actions — task A6, Spec §7.1 and §7.3.
 *
 * `subscriptions.integration.test.ts` already covers `trialAlertDays()` and
 * `pendingAlerts()` directly; this exercises the same fix through the actual
 * form actions the browser's `use:enhance` calls, per
 * `log-entry-action.integration.test.ts`'s own pattern for this file.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	page: typeof import('../../routes/subscriptions/+page.server');
	subs: typeof import('./subscriptions');
	clock: typeof import('./clock');
};

let m: Mod;
const USER = 1;
const TZ = 'Asia/Manila';

/** Invoke a form action the way SvelteKit does, with just the bits it reads. */
async function invoke(action: string, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const actions = m.page.actions as Record<string, (e: unknown) => Promise<unknown>>;
	return actions[action]({
		request: new Request('http://localhost/', { method: 'POST', body }),
		locals: { userId: USER }
	});
}

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-subpage-')), 'split.db');
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
		page: await import('../../routes/subscriptions/+page.server'),
		subs: await import('./subscriptions'),
		clock: await import('./clock')
	};
});

describe('quickAdd — Spec §7.3 fix', () => {
	it('a trial free until 7 days out gets a 3/1 lead, not the old flat 30', async () => {
		const today = m.clock.localToday(TZ);
		const freeUntil = m.clock.addDays(today, 7);

		const result = (await invoke('quickAdd', {
			label: 'ChatGPT subscription',
			amount: '1100',
			cadence: 'monthly',
			freeUntil
		})) as { added?: boolean };
		expect(result.added).toBe(true);

		const rows = m.subs.listSubscriptions(USER);
		const sub = rows.find((r) => r.label === 'ChatGPT subscription')!;
		expect(sub.leadDays).toBe(3);
		expect(sub.finalLeadDays).toBe(1);
		expect(sub.trialEndsOn).toBe(freeUntil);
		expect(sub.cancelByOn).toBe(freeUntil);
	});

	it('a non-trial quick-add keeps the cadence-scaled default and FINAL_ALERT_DAYS', async () => {
		const result = (await invoke('quickAdd', {
			label: 'Home wifi',
			amount: '750',
			cadence: 'monthly',
			isEssential: '1'
		})) as { added?: boolean };
		expect(result.added).toBe(true);

		const sub = m.subs.listSubscriptions(USER).find((r) => r.label === 'Home wifi')!;
		expect(sub.leadDays).toBe(7); // DEFAULT_LEAD_DAYS.monthly
		expect(sub.finalLeadDays).toBe(7); // FINAL_ALERT_DAYS
	});
});

describe('addFromPaste — Spec §7.1', () => {
	it('creates a discretionary trial from the reviewed, parsed fields', async () => {
		const result = (await invoke('addFromPaste', {
			label: 'Google AI Plus (400 GB)',
			amount: '549.00',
			cadence: 'monthly',
			trialEndsOn: '2026-09-24'
		})) as { addedFromPaste?: boolean };
		expect(result.addedFromPaste).toBe(true);

		const sub = m.subs.listSubscriptions(USER).find((r) => r.label === 'Google AI Plus (400 GB)')!;
		expect(sub.amountMinor).toBe(54_900);
		expect(sub.cadence).toBe('monthly');
		expect(sub.trialEndsOn).toBe('2026-09-24');
		expect(sub.cancelByOn).toBe('2026-09-24');
		// Spec §7.1: never asked, never essential.
		expect(sub.isEssential).toBe(0);
	});

	it('rejects a missing cadence rather than guessing one', async () => {
		const result = (await invoke('addFromPaste', {
			label: 'Mystery trial',
			amount: '99',
			cadence: '',
			trialEndsOn: '2026-09-24'
		})) as { status: number; data: { field: string } };
		expect(result.status).toBe(400);
		expect(result.data.field).toBe('pasteCadence');
		expect(m.subs.listSubscriptions(USER).some((r) => r.label === 'Mystery trial')).toBe(false);
	});
});
