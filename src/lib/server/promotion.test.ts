/**
 * Category promotion (Spec §5.9, task A4a).
 *
 * Two things under test: eligibility is a SPREAD requirement, not a count
 * (Spec §11.14a), and `promote()` is retroactive without moving a root total
 * (Spec §11.14b).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	promotion: typeof import('./promotion');
};

let m: Mod;
const USER = 1;

/** Insert a bare-minimum txn row directly — promotion.ts only reads
 * `label`, `category`, `spent_on`, so nothing else here needs to be real. */
function insertTxn(spentOn: string, label: string, category: string) {
	m.sqlite
		.prepare(
			`INSERT INTO txn (spent_on, amount_minor, category, planned, entered_at, label, user_id)
			 VALUES (?, 10000, ?, 1, 'x', ?, ?)`
		)
		.run(spentOn, category, label, USER);
}

function rootTotal(category: string): number {
	return (
		m.sqlite
			.prepare(`SELECT coalesce(sum(amount_minor), 0) AS total FROM txn WHERE category = ? AND user_id = ?`)
			.get(category, USER) as { total: number }
	).total;
}

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-promotion-')), 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	// week_starts_on = 1 (Monday), same convention as tenancy.test.ts.
	dbMod.sqlite.exec(
		`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
		   period_kind, week_starts_on, haircut_pct, band_pct, phase, timezone, created_at, user_id)
		 VALUES (1, 'PHP', '₱', 2, 100, 'weekly', 1, 15, 10, 0, 'Asia/Manila', 'x', ${USER})`
	);

	m = { sqlite: dbMod.sqlite, promotion: await import('./promotion') };
});

describe('Spec §11.14a — eligibility is spread across weeks, not a raw count', () => {
	it('five transactions on one day never make a word eligible', () => {
		for (let i = 0; i < 5; i++) insertTxn('2026-07-01', 'Onedayword', 'stuff');

		const eligible = m.promotion.eligiblePromotions(USER);
		expect(eligible.find((w) => w.label === 'Onedayword')).toBeUndefined();
	});

	it('five transactions spread across three distinct weeks are eligible', () => {
		// Monday-starting weeks: 06-01..06-07, 06-08..06-14, 06-15..06-21.
		insertTxn('2026-06-02', 'Laundry', 'stuff');
		insertTxn('2026-06-03', 'Laundry', 'stuff');
		insertTxn('2026-06-09', 'Laundry', 'stuff');
		insertTxn('2026-06-16', 'Laundry', 'stuff');
		insertTxn('2026-06-17', 'Laundry', 'stuff');

		const eligible = m.promotion.eligiblePromotions(USER);
		const laundry = eligible.find((w) => w.label === 'Laundry');
		expect(laundry).toEqual({ label: 'Laundry', root: 'stuff', txnCount: 5, weekCount: 3 });
	});

	it('four of the five weeks would not be enough — the threshold really is 3', () => {
		insertTxn('2026-08-03', 'Almost', 'stuff');
		insertTxn('2026-08-04', 'Almost', 'stuff');
		insertTxn('2026-08-10', 'Almost', 'stuff');
		insertTxn('2026-08-11', 'Almost', 'stuff');
		// Only 4 rows across 2 weeks: neither bound is met yet.
		const eligible = m.promotion.eligiblePromotions(USER);
		expect(eligible.find((w) => w.label === 'Almost')).toBeUndefined();
	});
});

describe('Spec §11.14b — promotion is retroactive and moves no root total', () => {
	it('promoting "Laundry" backfills every past row and leaves the Stuff total unchanged', () => {
		// A taught word's label_map row should gain the leaf too, so this
		// user's NEXT "laundry" arrives pre-attached (LearnedEntry.leafId).
		m.sqlite
			.prepare(
				`INSERT INTO label_map (user_id, typed, english, root) VALUES (?, 'laundry', 'Laundry', 'stuff')`
			)
			.run(USER);

		const before = rootTotal('stuff');
		const leafId = m.promotion.promote(USER, 'Laundry', 'stuff', 'Laundry');
		expect(typeof leafId).toBe('number');

		// No root total moves — invariant 4's "no budget at either level" is
		// about attachment, not amounts, but the retroactive write must not
		// touch amount_minor at all.
		expect(rootTotal('stuff')).toBe(before);

		const rows = m.sqlite
			.prepare(`SELECT leaf_id FROM txn WHERE label = 'Laundry' AND user_id = ?`)
			.all(USER) as { leaf_id: number | null }[];
		expect(rows).toHaveLength(5);
		expect(rows.every((r) => r.leaf_id === leafId)).toBe(true);

		const labelMapRow = m.sqlite
			.prepare(`SELECT leaf_id FROM label_map WHERE user_id = ? AND typed = 'laundry'`)
			.get(USER) as { leaf_id: number | null };
		expect(labelMapRow.leaf_id).toBe(leafId);

		// Once promoted, it drops out of eligiblePromotions() — every row now
		// carries a leaf_id, and the query excludes those on purpose.
		expect(m.promotion.eligiblePromotions(USER).find((w) => w.label === 'Laundry')).toBeUndefined();
	});

	it('a leaf under the same (root, name) is reused, not duplicated, on a second call', () => {
		const category = m.sqlite
			.prepare(`SELECT count(*) AS n FROM category_leaf WHERE user_id = ? AND root = 'stuff' AND name = 'Laundry'`)
			.get(USER) as { n: number };
		expect(category.n).toBe(1);

		const leafIdAgain = m.promotion.promote(USER, 'Laundry', 'stuff', 'Laundry');
		const after = m.sqlite
			.prepare(`SELECT count(*) AS n FROM category_leaf WHERE user_id = ? AND root = 'stuff' AND name = 'Laundry'`)
			.get(USER) as { n: number };
		expect(after.n).toBe(1);
		expect(typeof leafIdAgain).toBe('number');
	});
});
