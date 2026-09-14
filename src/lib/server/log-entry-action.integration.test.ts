/**
 * `+page.server.ts`'s `logEntry` action — wiring the typed-entry UI to A4a's
 * router (Spec §5.6-§5.9; task A4b). `entry.test.ts` already covers
 * `resolveEntry`/`commitResolvedEntry` directly; this exercises the SAME
 * router through the actual form action, the way the browser's `use:enhance`
 * calls it, per `catchup.integration.test.ts`'s own pattern for this file.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	schema: typeof import('./db').schema;
	page: typeof import('../../routes/+page.server');
	subs: typeof import('./subscriptions');
	today: typeof import('./today');
};

let m: Mod;

const USER = 1;
const TODAY = '2026-06-02';

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

function txnCount(): number {
	return (m.sqlite.prepare(`SELECT count(*) AS n FROM txn WHERE user_id = ?`).get(USER) as { n: number }).n;
}

function labelMapRow(typed: string) {
	return m.sqlite
		.prepare(`SELECT english, root FROM label_map WHERE user_id = ? AND typed = ?`)
		.get(USER, typed) as { english: string; root: string } | undefined;
}

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-logentry-')), 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	dbMod.sqlite.exec(
		`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
		   period_kind, week_starts_on, haircut_pct, band_pct, phase, timezone,
		   weekly_take_home_minor, created_at, user_id)
		 VALUES (1, 'PHP', '₱', 2, 100, 'weekly', 1, 15, 10, 0, 'Asia/Manila', 500000, 'x', ${USER})`
	);
	dbMod.sqlite.exec(
		`INSERT INTO period (id, starts_on, ends_on, days, spend_alloc_minor,
		   daily_allowance_minor, haircut_pct_applied, phase_at_open, created_at, user_id)
		 VALUES (1, '2026-06-01', '2026-06-07', 7, 700000, 85000, 15, 0, 'x', ${USER})`
	);
	dbMod.sqlite.exec(
		`INSERT INTO account (slug, name, kind, balance_minor, user_id)
		 VALUES ('spend', 'Spending', 'spend', 500000, ${USER})
		 ON CONFLICT (user_id, slug) DO UPDATE SET balance_minor = excluded.balance_minor`
	);

	m = {
		sqlite: dbMod.sqlite,
		schema: dbMod.schema,
		page: await import('../../routes/+page.server'),
		subs: await import('./subscriptions'),
		today: await import('./today')
	};
});

describe('a known word resolves to a transaction with the right root, and saves', () => {
	it('"kape 65" + planned saves one txn row under food_out', async () => {
		const before = txnCount();
		const result = (await invoke('logEntry', {
			text: 'kape 65',
			clientUuid: 'test-kape-1',
			planned: '1'
		})) as { saved?: boolean; wrote?: string };

		expect(result).toEqual({ saved: true, wrote: 'transaction' });
		expect(txnCount()).toBe(before + 1);

		const row = m.sqlite
			.prepare(`SELECT label, category, amount_minor, planned FROM txn WHERE user_id = ? ORDER BY id DESC LIMIT 1`)
			.get(USER) as { label: string; category: string; amount_minor: number; planned: number };
		expect(row).toEqual({ label: 'Coffee', category: 'food_out', amount_minor: 6_500, planned: 1 });
	});

	it('the SAME client_uuid submitted twice writes exactly one row (one save path, double-submit safe)', async () => {
		const before = txnCount();
		const fields = { text: 'kape 30', clientUuid: 'test-idempotent-1', planned: '0' };

		const first = await invoke('logEntry', fields);
		const second = await invoke('logEntry', fields);

		expect(first).toEqual({ saved: true, wrote: 'transaction' });
		// The repeat is treated as a double-submit, not a second purchase.
		expect(second).toEqual({ saved: true, wrote: 'transaction' });
		expect(txnCount()).toBe(before + 1);
	});

	it('replaying the same client_uuid fifty times still writes exactly one row (Spec §11.12, task A5)', async () => {
		// This is what the offline outbox (src/lib/outbox.ts) actually leans
		// on: a flaky reconnect can retry a queued row an unbounded number of
		// times before a definitive success is ever seen client-side, and
		// task A5 is "one-way replay, not sync" specifically because this
		// server-side guarantee already existed and needed no new work here —
		// this test is what proves that claim at more than double-submit
		// scale, not just the two attempts the test above covers.
		const before = txnCount();
		const fields = { text: 'kape 45', clientUuid: 'test-replay-fifty', planned: '1' };

		for (let i = 0; i < 50; i++) {
			const result = await invoke('logEntry', fields);
			expect(result).toEqual({ saved: true, wrote: 'transaction' });
		}

		expect(txnCount()).toBe(before + 1);
	});
});

describe('an unknown word blocks saving until answered', () => {
	it('"laundry 200" with no answer refuses to save — an open question never becomes a silent default', async () => {
		const before = txnCount();
		const result = await invoke('logEntry', { text: 'laundry 200', clientUuid: 'test-laundry-ask' });

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toMatch(/answer the question/i);
		expect(txnCount()).toBe(before);
		expect(labelMapRow('laundry')).toBeUndefined();
	});

	it('answering the category question (the taught fields) persists label_map and saves as that root', async () => {
		const before = txnCount();
		const result = await invoke('logEntry', {
			text: 'laundry 200',
			clientUuid: 'test-laundry-answered',
			planned: '1',
			taughtWord: 'laundry',
			taughtEnglish: 'Laundry',
			taughtRoot: 'stuff'
		});

		expect(result).toEqual({ saved: true, wrote: 'transaction' });
		expect(txnCount()).toBe(before + 1);
		expect(labelMapRow('laundry')).toEqual({ english: 'Laundry', root: 'stuff' });

		const row = m.sqlite
			.prepare(`SELECT label, category FROM txn WHERE user_id = ? ORDER BY id DESC LIMIT 1`)
			.get(USER) as { label: string; category: string };
		expect(row).toEqual({ label: 'Laundry', category: 'stuff' });

		// A word answered once is never asked again (Spec §5.9 step 2).
		const secondMention = await invoke('logEntry', {
			text: 'laundry 45',
			clientUuid: 'test-laundry-again',
			planned: '0'
		});
		expect(secondMention).toEqual({ saved: true, wrote: 'transaction' });
	});
});

describe('"wifi bill 750" offers no P/U — it is an already-reserved fixed commitment', () => {
	it('commits to nothing, closes the day, and leaves the band untouched', async () => {
		m.subs.createSubscription(USER, {
			label: 'Home wifi',
			amountMinor: 75_000,
			cadence: 'monthly',
			nextChargeOn: TODAY,
			isEssential: true
		});

		const before = m.today.todayView(USER, TODAY);
		const txnBefore = txnCount();

		// No `planned` field submitted at all — the UI never offers P/U for
		// this kind, so the form action must not require it either.
		const result = await invoke('logEntry', { text: 'wifi bill 750', clientUuid: 'test-wifi-1' });

		expect(result).toEqual({ saved: true, wrote: 'none' });
		expect(txnCount()).toBe(txnBefore);
		expect(m.today.todayView(USER, TODAY).band).toEqual(before.band);
	});
});

describe('a transfer records nothing and does not change today', () => {
	it('"withdraw 500" confirms with no txn row written', async () => {
		const before = txnCount();
		const result = await invoke('logEntry', { text: 'withdraw 500', clientUuid: 'test-withdraw-1' });
		expect(result).toEqual({ saved: true, wrote: 'none' });
		expect(txnCount()).toBe(before);
	});
});
