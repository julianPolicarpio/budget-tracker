/**
 * The /setup guard. The route exists only while the user has no period, and
 * must never be reachable afterwards — a second run would mean a duplicate
 * open period, which invariant 6 forbids.
 */
import { beforeAll, beforeEach, expect, it, describe } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

let m: { sqlite: import('better-sqlite3').Database; route: typeof import('./+page.server') };
const USER = 1;

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-setup-route-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
	const dbMod = await import('$lib/server/db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));
	m = { sqlite: dbMod.sqlite, route: await import('./+page.server') };
});

beforeEach(() => {
	m.sqlite.prepare(`DELETE FROM period WHERE user_id = ?`).run(USER);
	m.sqlite.prepare(`DELETE FROM income_source WHERE user_id = ?`).run(USER);
});

describe('/setup load', () => {
	it('serves the form when the user has no period', () => {
		const data = m.route.load({ locals: { userId: USER } } as never);
		expect(data.cadences.length).toBeGreaterThan(0);
	});

	it('redirects to Today once a period exists', () => {
		m.sqlite
			.prepare(
				`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor,
				 daily_allowance_minor, haircut_pct_applied, phase_at_open, created_at, user_id)
				 VALUES ('2026-09-13','2026-09-19',7,100000,12142,15,0,'x',?)`
			)
			.run(USER);
		expect(() => m.route.load({ locals: { userId: USER } } as never)).toThrow();
	});
});
