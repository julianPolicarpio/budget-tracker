/**
 * The door badge. Spec §6: a count of what is still unset, each clearing
 * permanently once satisfied, and no badge at all when the count is zero.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

let m: { sqlite: import('better-sqlite3').Database; mod: typeof import('./setup-status') };
const USER = 1;

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-todo-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));
	m = { sqlite: dbMod.sqlite, mod: await import('./setup-status') };
});

beforeEach(() => {
	m.sqlite.prepare(`DELETE FROM income_source WHERE user_id = ?`).run(USER);
	m.sqlite.prepare(`DELETE FROM subscription WHERE user_id = ?`).run(USER);
	m.sqlite.prepare(`UPDATE account SET balance_minor = 0 WHERE user_id = ?`).run(USER);
});

it('counts three things outstanding on a freshly set-up account', () => {
	const t = m.mod.setupTodo(USER);
	expect(t).toMatchObject({ incomeSources: true, balances: true, commitments: true, count: 3 });
});

it('clears the balances item once any account holds a figure', () => {
	m.sqlite
		.prepare(`UPDATE account SET balance_minor = 50000 WHERE user_id = ? AND slug = 'spend'`)
		.run(USER);
	const t = m.mod.setupTodo(USER);
	expect(t.balances).toBe(false);
	expect(t.count).toBe(2);
});
