/**
 * The demo tenant (Spec §3.4).
 *
 * The property under test is not "a demo exists" but "a demo is an ordinary
 * tenant". If it needed its own code path it would be a second implementation
 * of tenancy, and the whole risk of going multi-user is that tenancy is
 * implemented once and correctly.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

let m: {
	sqlite: import('better-sqlite3').Database;
	demo: typeof import('./demo');
	today: typeof import('./today');
};

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-demo-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	m = {
		sqlite: dbMod.sqlite,
		demo: await import('./demo'),
		today: await import('./today')
	};
});

const count = (table: string, userId: number) =>
	(
		m.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as {
			n: number;
		}
	).n;

describe('a demo tenant is an ordinary tenant', () => {
	it('lands a reviewer in a working app with real history, not an empty shell', () => {
		const id = m.demo.createDemoUser(new Date('2026-09-14T08:00:00Z'));

		expect(m.demo.isDemoUser(id)).toBe(true);
		// Provisioned like anybody else: settings and the six buckets.
		expect(count('settings', id)).toBe(1);
		expect(count('account', id)).toBe(6);
		// And seeded, because an empty app demonstrates nothing.
		expect(count('period', id)).toBeGreaterThan(10);
		expect(count('txn', id)).toBeGreaterThan(100);
		expect(count('log_day', id)).toBeGreaterThan(50);
		expect(count('subscription', id)).toBe(3);
		expect(count('irregular', id)).toBe(1);
	});

	it('obeys the app’s own rules, so it teaches a reviewer the right thing', () => {
		const id = m.demo.createDemoUser(new Date('2026-09-14T08:00:00Z'));
		const p = m.sqlite
			.prepare(`SELECT * FROM period WHERE user_id = ? LIMIT 1`)
			.get(id) as Record<string, number>;

		// 15% haircut taken off the top, exactly as a real period opens.
		expect(p.haircut_pct_applied).toBe(15);
		expect(p.daily_allowance_minor).toBe(Math.round((100_000 * 85) / (100 * 7)));

		// Money is integer minor units everywhere, including invented money.
		const amounts = m.sqlite
			.prepare(`SELECT amount_minor FROM txn WHERE user_id = ?`)
			.all(id) as { amount_minor: number }[];
		expect(amounts.every((a) => Number.isInteger(a.amount_minor))).toBe(true);
	});

	it('shows a band and no balance, like every other tenant', () => {
		const id = m.demo.createDemoUser(new Date('2026-09-14T08:00:00Z'));
		const view = m.today.todayView(id, '2026-09-14');
		expect(view).not.toHaveProperty('balance');
		expect(view).not.toHaveProperty('remaining');
	});

	it('is invisible to other tenants', () => {
		const a = m.demo.createDemoUser(new Date('2026-09-14T08:00:00Z'));
		const b = m.demo.createDemoUser(new Date('2026-09-14T08:00:00Z'));
		const rows = m.sqlite
			.prepare(`SELECT DISTINCT user_id AS u FROM txn WHERE user_id = ?`)
			.all(a) as { u: number }[];
		expect(rows.every((r) => r.u === a)).toBe(true);
		expect(a).not.toBe(b);
	});
});

describe('the landing page makes a checkable claim', () => {
	it('lists exactly the seven rules the README lists', () => {
		const page = readFileSync(resolve('src/routes/signin/+page.svelte'), 'utf8');
		const rules = page.match(/\n\t\t\trule: '/g) ?? [];
		expect(rules).toHaveLength(7);
	});

	it('offers the demo as a POST, never a link a crawler can follow', () => {
		const page = readFileSync(resolve('src/routes/signin/+page.svelte'), 'utf8');
		expect(page).toContain(`method="POST" action="/demo"`);
		expect(page).not.toContain(`href="/demo"`);
	});

	it('uses the accessible accent for the filled button, not the line accent', () => {
		const page = readFileSync(resolve('src/routes/signin/+page.svelte'), 'utf8');
		const css = readFileSync(resolve('src/routes/layout.css'), 'utf8');
		// White on --accent is 3.64:1 in dark and 4.41:1 in light; both fail.
		expect(page).toContain('var(--accent-solid');
		expect(css).toContain('--accent-solid');
	});
});

describe('the reaper', () => {
	it('deletes an expired demo and everything it owned', () => {
		const old = m.demo.createDemoUser(new Date('2026-09-10T08:00:00Z'));
		expect(count('txn', old)).toBeGreaterThan(0);

		const reaped = m.demo.reapDemoUsers(new Date('2026-09-14T08:00:00Z'));
		expect(reaped).toBeGreaterThan(0);

		// ON DELETE CASCADE, which is the same mechanism behind the
		// account-deletion promise in §3.5.
		expect(count('txn', old)).toBe(0);
		expect(count('period', old)).toBe(0);
		expect(count('account', old)).toBe(0);
		expect(count('settings', old)).toBe(0);
	});

	it('leaves a fresh demo alone', () => {
		const fresh = m.demo.createDemoUser(new Date('2026-09-14T08:00:00Z'));
		m.demo.reapDemoUsers(new Date('2026-09-14T12:00:00Z'));
		expect(count('txn', fresh)).toBeGreaterThan(0);
	});

	it('never touches a real user, however old', () => {
		m.sqlite
			.prepare(`INSERT INTO app_user (id, created_at, is_demo) VALUES (900, '2020-01-01', 0)`)
			.run();
		m.sqlite
			.prepare(
				`INSERT INTO txn (spent_on, amount_minor, category, planned, entered_at, user_id)
				 VALUES ('2020-01-01', 500, 'other', 0, 'x', 900)`
			)
			.run();

		m.demo.reapDemoUsers(new Date('2026-09-14T08:00:00Z'));
		expect(count('txn', 900)).toBe(1);
	});
});
