/**
 * Categories (Spec §5.5, §5.8; task A4a).
 *
 * Two invariant checks, not behaviour: the eight roots never change count
 * regardless of how many leaves a user grows (Spec §11.14), and no node at
 * either level can carry a budget, target or limit (Spec §11.15, invariant
 * 4 — the one project invariant this whole feature is built around not
 * touching).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../scripts/apply-migrations.js';
import { CATEGORIES, CATEGORY_HELP, type CategoryKey } from './categories';

const BUDGET_WORDS = /budget|target|limit|cap\b/i;

describe('Spec §11.14 — root categories always number exactly eight', () => {
	it('CATEGORIES has exactly eight entries, and CATEGORY_HELP covers all eight', () => {
		expect(CATEGORIES).toHaveLength(8);
		expect(Object.keys(CATEGORY_HELP)).toHaveLength(8);
		for (const c of CATEGORIES) expect(CATEGORY_HELP[c.key]).toBeTruthy();
	});

	it('stays eight no matter how many leaves this user has grown', async () => {
		process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-categories-')), 'split.db');
		process.env.SPLIT_DISABLE_JOBS = '1';
		const dbMod = await import('./server/db');
		applyMigrations(dbMod.sqlite, resolve('migrations'));

		const now = new Date().toISOString();
		const roots: CategoryKey[] = CATEGORIES.map((c) => c.key);
		// Three leaves under the same root, two more scattered across others —
		// five leaves total, still eight roots.
		for (const [root, name] of [
			['stuff', 'Laundry'],
			['stuff', 'Haircut'],
			['stuff', 'Repairs'],
			['food_out', 'Milk tea'],
			['transport', 'Grab']
		] as [CategoryKey, string][]) {
			dbMod.sqlite
				.prepare(`INSERT INTO category_leaf (user_id, root, name, created_at) VALUES (1, ?, ?, ?)`)
				.run(root, name, now);
		}

		const leafCount = (
			dbMod.sqlite.prepare(`SELECT count(*) AS n FROM category_leaf`).get() as { n: number }
		).n;
		expect(leafCount).toBe(5);
		expect(roots).toHaveLength(8);
		expect(CATEGORIES).toHaveLength(8);
	});
});

describe('Spec §11.15 / invariant 4 — no budget, target or limit at either level', () => {
	it('the root definition (CATEGORIES) carries no such field', () => {
		for (const c of CATEGORIES) {
			for (const key of Object.keys(c)) expect(key).not.toMatch(BUDGET_WORDS);
		}
	});

	it('the leaf table (category_leaf) has no such column', async () => {
		process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-categories2-')), 'split.db');
		process.env.SPLIT_DISABLE_JOBS = '1';
		const dbMod = await import('./server/db');
		applyMigrations(dbMod.sqlite, resolve('migrations'));

		const cols = dbMod.sqlite.prepare(`PRAGMA table_info(category_leaf)`).all() as { name: string }[];
		for (const c of cols) expect(c.name).not.toMatch(BUDGET_WORDS);
	});

	it('label_map has no such column either — a taught word is a translation, not a limit', async () => {
		process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-categories3-')), 'split.db');
		process.env.SPLIT_DISABLE_JOBS = '1';
		const dbMod = await import('./server/db');
		applyMigrations(dbMod.sqlite, resolve('migrations'));

		const cols = dbMod.sqlite.prepare(`PRAGMA table_info(label_map)`).all() as { name: string }[];
		for (const c of cols) expect(c.name).not.toMatch(BUDGET_WORDS);
	});
});
