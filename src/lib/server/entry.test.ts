/**
 * The typed-entry router's server side (Spec §5.6–§5.9, task A4a).
 *
 * The two tests the task calls out by number (Spec §11.9, §11.10) are the
 * whole reason this module exists: guessing the record KIND wrong corrupts
 * the daily band, so committing an existing commitment or a transfer must
 * write no `txn` row and must leave `todayView()`'s band byte-identical.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	schema: typeof import('./db').schema;
	entry: typeof import('./entry');
	subs: typeof import('./subscriptions');
	irr: typeof import('./irregulars');
	today: typeof import('./today');
};

let m: Mod;

const USER = 1;
const TODAY = '2026-06-02';

function txnCount(): number {
	return (m.sqlite.prepare(`SELECT count(*) AS n FROM txn WHERE user_id = ?`).get(USER) as { n: number }).n;
}

function transferCount(): number {
	return (m.sqlite.prepare(`SELECT count(*) AS n FROM "transfer" WHERE user_id = ?`).get(USER) as { n: number }).n;
}

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-entry-')), 'split.db');
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

	// Migration 0003 already seeds the six buckets for user 1 — upsert rather
	// than insert, same as tenancy.test.ts does for the same reason.
	dbMod.sqlite.exec(
		`INSERT INTO account (slug, name, kind, balance_minor, user_id)
		 VALUES ('spend', 'Spending', 'spend', 500000, ${USER})
		 ON CONFLICT (user_id, slug) DO UPDATE SET balance_minor = excluded.balance_minor`
	);

	m = {
		sqlite: dbMod.sqlite,
		schema: dbMod.schema,
		entry: await import('./entry'),
		subs: await import('./subscriptions'),
		irr: await import('./irregulars'),
		today: await import('./today')
	};
});

describe('Spec §11.9 — an existing FIXED commitment writes no txn row', () => {
	it('"wifi bill 750" resolves to the subscription and commits to nothing, band unchanged', () => {
		m.subs.createSubscription(USER, {
			label: 'Home wifi',
			amountMinor: 75_000,
			cadence: 'monthly',
			nextChargeOn: TODAY,
			isEssential: true
		});

		const resolved = m.entry.resolveEntry(USER, 'wifi bill 750');
		expect(resolved.kind).toBe('existing_commitment');
		if (resolved.kind !== 'existing_commitment') throw new Error('unreachable');
		expect(resolved.commitment.kind).toBe('subscription');

		const before = m.today.todayView(USER, TODAY);
		const txnBefore = txnCount();

		const result = m.entry.commitResolvedEntry(USER, resolved, { today: TODAY });
		expect(result).toEqual({ ok: true, wrote: 'none' });

		const after = m.today.todayView(USER, TODAY);
		expect(txnCount()).toBe(txnBefore);
		expect(after.band).toEqual(before.band);
	});

	it('an existing VARYING commitment settles actual_minor and still writes no txn row', () => {
		const irrId = m.irr.createIrregular(USER, {
			label: 'Laundry',
			amountMinor: 20_000,
			cadence: 'weekly',
			nextDueOn: TODAY,
			paddingPct: 5,
			isEstimate: true
		});
		m.irr.materialise(USER, TODAY);

		const resolved = m.entry.resolveEntry(USER, 'laundry 210');
		expect(resolved.kind).toBe('existing_commitment');
		if (resolved.kind !== 'existing_commitment') throw new Error('unreachable');
		expect(resolved.commitment.kind).toBe('irregular');

		const before = m.today.todayView(USER, TODAY);
		const txnBefore = txnCount();

		const result = m.entry.commitResolvedEntry(USER, resolved, { today: TODAY });
		expect(result).toEqual({ ok: true, wrote: 'settlement' });

		expect(txnCount()).toBe(txnBefore);
		expect(m.today.todayView(USER, TODAY).band).toEqual(before.band);

		const inst = m.sqlite
			.prepare(`SELECT status, actual_minor FROM irregular_instance WHERE irregular_id = ?`)
			.get(irrId) as { status: string; actual_minor: number };
		expect(inst.status).toBe('settled');
		expect(inst.actual_minor).toBe(21_000);
	});
});

describe('Spec §11.10 — a transfer writes no txn row and does not move the band', () => {
	it('"withdraw 2000" writes NO row of any kind, and the band does not move', () => {
		const resolved = m.entry.resolveEntry(USER, 'withdraw 2000');
		expect(resolved.kind).toBe('transfer');

		const before = m.today.todayView(USER, TODAY);
		const txnBefore = txnCount();
		const transferBefore = transferCount();

		const result = m.entry.commitResolvedEntry(USER, resolved, { today: TODAY });
		expect(result).toEqual({ ok: true, wrote: 'none' });

		// Spec §5.4 originally called for a `transfer` row here. It was wrong:
		// this app models buckets, not the physical form money is in, and a
		// withdrawal moves nothing between buckets. A spend→spend row would have
		// required weakening transfer's CHECK constraint to store something no
		// screen reads. Both counts staying flat is the assertion.
		expect(txnCount()).toBe(txnBefore);
		expect(transferCount()).toBe(transferBefore);
		expect(m.today.todayView(USER, TODAY).band).toEqual(before.band);
	});
});

describe('Spec §11.13 — a word answered once is never asked again; unanswered saves nothing', () => {
	it('an unknown word asks; teaching it makes every later mention a transaction', () => {
		const before = m.sqlite
			.prepare(`SELECT count(*) AS n FROM label_map WHERE user_id = ? AND typed = 'sari-sari'`)
			.get(USER) as { n: number };
		expect(before.n).toBe(0);

		const firstAsk = m.entry.resolveEntry(USER, 'sari-sari 45');
		expect(firstAsk.kind).toBe('ask_category');

		m.entry.answerWord(USER, 'sari-sari', 'Sari-sari store', 'food_in');

		const secondTry = m.entry.resolveEntry(USER, 'sari-sari 45');
		expect(secondTry).toMatchObject({ kind: 'transaction', english: 'Sari-sari store', root: 'food_in' });

		// Answering twice is idempotent — exactly one row, not two.
		m.entry.answerWord(USER, 'sari-sari', 'Sari-sari store', 'food_in');
		const rows = m.sqlite
			.prepare(`SELECT count(*) AS n FROM label_map WHERE user_id = ? AND typed = 'sari-sari'`)
			.get(USER) as { n: number };
		expect(rows.n).toBe(1);
	});

	it('a word never answered has saved nothing at all', () => {
		const row = m.sqlite
			.prepare(`SELECT count(*) AS n FROM label_map WHERE user_id = ? AND typed = 'never-asked-this-one'`)
			.get(USER) as { n: number };
		expect(row.n).toBe(0);
	});
});

describe('commitResolvedEntry: the other two branches', () => {
	it('a plain transaction writes exactly one txn row carrying label, source and category', () => {
		const resolved = m.entry.resolveEntry(USER, 'kape 65');
		expect(resolved.kind).toBe('transaction');

		const txnBefore = txnCount();
		const result = m.entry.commitResolvedEntry(USER, resolved, {
			today: TODAY,
			planned: false,
			source: 'ewallet'
		});
		expect(result).toEqual({ ok: true, wrote: 'transaction' });
		expect(txnCount()).toBe(txnBefore + 1);

		const row = m.sqlite
			.prepare(`SELECT label, source, category, amount_minor, leaf_id FROM txn WHERE user_id = ? ORDER BY id DESC LIMIT 1`)
			.get(USER) as { label: string; source: string; category: string; amount_minor: number; leaf_id: number | null };
		expect(row).toEqual({ label: 'Coffee', source: 'ewallet', category: 'food_out', amount_minor: 6_500, leaf_id: null });
	});

	it('a new commitment writes a subscription, never a txn row', () => {
		const resolved = m.entry.resolveEntry(USER, 'netflix 549 monthly');
		expect(resolved.kind).toBe('new_commitment');

		const txnBefore = txnCount();
		const result = m.entry.commitResolvedEntry(USER, resolved, {
			today: TODAY,
			commitmentMode: 'same_essential'
		});
		expect(result).toEqual({ ok: true, wrote: 'commitment' });
		expect(txnCount()).toBe(txnBefore);

		const created = m.subs.listSubscriptions(USER).find((s) => s.label === 'Netflix');
		expect(created).toBeTruthy();
		expect(created?.isEssential).toBe(1);

		// The clean label this created is what a later bare mention matches
		// against — the whole point of stripping "monthly" before storing it.
		const ctx = m.entry.buildParseContext(USER);
		const later = ctx.commitments.find((c) => c.label === 'Netflix');
		expect(later).toBeTruthy();
	});

	it('an open question refuses to commit rather than silently defaulting', () => {
		const resolved = m.entry.resolveEntry(USER, 'unrecognisedword123 30');
		expect(resolved.kind).toBe('ask_category');
		const result = m.entry.commitResolvedEntry(USER, resolved, { today: TODAY });
		expect(result.ok).toBe(false);
	});
});
