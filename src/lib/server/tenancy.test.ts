/**
 * The tests that gate every public step (Spec §3.2).
 *
 * Until now network isolation was the auth boundary: there was one human and
 * anything that could reach the port was him. That is being reversed, and the
 * entire risk of the reversal is one failure mode — a query that forgets its
 * `user_id` shows a stranger someone else's financial history.
 *
 * `user_id NOT NULL DEFAULT 1` does not prevent that. Worse, the default means
 * a forgotten id fails *quietly*, filing a stranger's row into the owner's
 * account instead of throwing. These tests are what actually stands between
 * the two, so they are deliberately exhaustive and deliberately boring.
 *
 * Layer 1 is the schema. Layer 2 is `schema enumeration` below: a table added
 * in month eight cannot silently skip tenancy. Layer 3 is `no leaks between
 * tenants`: seed two complete users, drive every read path as one of them, and
 * assert the other is invisible.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	schema: typeof import('./db').schema;
	metrics: typeof import('./metrics');
	today: typeof import('./today');
	subs: typeof import('./subscriptions');
};

let m: Mod;

/** Two users, same dates, different money. Anything that mixes them is a leak. */
const OWNER = 1;
const STRANGER = 2;

const WEEK = { from: '2026-06-01', to: '2026-06-07' };

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-tenancy-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	m = {
		sqlite: dbMod.sqlite,
		schema: dbMod.schema,
		metrics: await import('./metrics'),
		today: await import('./today'),
		subs: await import('./subscriptions')
	};

	m.sqlite.prepare(`INSERT INTO app_user (id, created_at) VALUES (?, 'x')`).run(STRANGER);

	for (const u of [OWNER, STRANGER]) {
		// Deliberately identical shapes and dates. Only the amounts differ, so a
		// leak shows up as a wrong number rather than as an obvious duplicate.
		const amount = u === OWNER ? 10_000 : 999_000;

		m.sqlite
			.prepare(
				`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
				   period_kind, week_starts_on, haircut_pct, band_pct, phase, timezone,
				   weekly_take_home_minor, created_at, user_id)
				 VALUES (?, 'PHP', '₱', 2, 1000, 'weekly', 1, 15, 10, 0, 'Asia/Manila', 500000, 'x', ?)`
			)
			.run(u, u);

		m.sqlite
			.prepare(
				`INSERT INTO period (id, starts_on, ends_on, days, spend_alloc_minor,
				   daily_allowance_minor, haircut_pct_applied, phase_at_open, created_at, user_id)
				 VALUES (?, ?, ?, 7, 100000, 12143, 15, 0, 'x', ?)`
			)
			.run(u, WEEK.from, WEEK.to, u);

		for (const [i, cat] of ['food_out', 'transport', 'health'].entries()) {
			m.sqlite
				.prepare(
					`INSERT INTO txn (spent_on, amount_minor, category, planned, entered_at, period_id, user_id)
					 VALUES (?, ?, ?, ?, 'x', ?, ?)`
				)
				.run('2026-06-0' + (i + 2), amount, cat, i % 2, u, u);
		}

		m.sqlite
			.prepare(
				`INSERT INTO log_day (logged_on, entry_count, is_catchup, closed_at, user_id)
				 VALUES ('2026-06-02', 3, 0, 'x', ?)`
			)
			.run(u);

		m.sqlite
			.prepare(
				`INSERT INTO subscription (label, amount_minor, cadence, next_charge_on,
				   lead_days, alert_stage, created_at, is_essential, user_id)
				 VALUES (?, ?, 'monthly', '2026-07-01', 7, 0, 'x', 0, ?)`
			)
			.run(u === OWNER ? 'Owner sub' : 'Stranger sub', amount, u);

		// Migration 0003 seeds the six buckets, but only for user 1. A second
		// user therefore starts with none — a real gap that A2's signup flow has
		// to close. Here we just make sure each user ends up with exactly one
		// 'spend' bucket holding their own money.
		m.sqlite
			.prepare(
				`INSERT INTO account (slug, name, kind, balance_minor, user_id)
				 VALUES ('spend', 'Spending', 'spend', ?, ?)
				 ON CONFLICT (user_id, slug) DO UPDATE SET balance_minor = excluded.balance_minor`
			)
			.run(amount, u);
	}
});

describe('tenancy', () => {
	// ── Layer 2 ──────────────────────────────────────────────────────────
	describe('schema enumeration', () => {
		it('every table carries a NOT NULL user_id', () => {
			const ALLOWED = new Set(['_migration', 'app_user']);
			const tables = m.sqlite
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
				.all() as { name: string }[];

			const missing: string[] = [];
			for (const { name } of tables) {
				if (ALLOWED.has(name)) continue;
				const cols = m.sqlite.prepare(`PRAGMA table_info(${name})`).all() as {
					name: string;
					notnull: number;
				}[];
				const col = cols.find((c) => c.name === 'user_id');
				if (!col || col.notnull !== 1) missing.push(name);
			}

			// A table added in month eight by someone who never read §3.2 fails
			// here, loudly, instead of leaking quietly in production.
			expect(missing).toEqual([]);
			expect(tables.length).toBeGreaterThanOrEqual(21);
		});
	});

	// ── Layer 3: the test that gates every public step ───────────────────
	describe('no leaks between tenants', () => {
		it('weekActuals counts only the caller', () => {
			const owner = m.metrics.weekActuals(OWNER, WEEK);
			// Three txns of ₱100. If the stranger's ₱9,990 leaks in, this is wrong
			// by two orders of magnitude rather than subtly.
			expect(owner.totalMinor).toBe(30_000);

			const stranger = m.metrics.weekActuals(STRANGER, WEEK);
			expect(stranger.totalMinor).toBe(2_997_000);
		});

		it('topThree never surfaces another tenant', () => {
			const rows = m.metrics.topThree(OWNER, WEEK);
			expect(rows.length).toBeGreaterThan(0);
			for (const r of rows) expect(r.amountMinor).toBe(10_000);
		});

		it('logAdherenceBp counts only the caller', () => {
			expect(m.metrics.logAdherenceBp(OWNER, WEEK)).toBe(m.metrics.logAdherenceBp(STRANGER, WEEK));
			// Both logged exactly one day in the same window; equality here is
			// the point, and it must come from two separate counts of 1 rather
			// than from one shared count of 2.
			const owned = m.sqlite
				.prepare(`SELECT count(*) AS n FROM log_day WHERE user_id = ?`)
				.get(OWNER) as { n: number };
			expect(owned.n).toBe(1);
		});

		it('subscriptions belong to one person', () => {
			const owner = m.subs.listSubscriptions(OWNER);
			expect(owner).toHaveLength(1);
			expect(owner[0].label).toBe('Owner sub');

			const stranger = m.subs.listSubscriptions(STRANGER);
			expect(stranger).toHaveLength(1);
			expect(stranger[0].label).toBe('Stranger sub');
		});

		it('commitmentsPerPeriod never sums across tenants', () => {
			const owner = m.subs.commitmentsPerPeriod(OWNER, 7);
			const stranger = m.subs.commitmentsPerPeriod(STRANGER, 7);
			expect(stranger).toBeGreaterThan(owner * 50);
		});

		it('todayView shows the caller their own day', () => {
			const owner = m.today.todayView(OWNER, '2026-06-02');
			const stranger = m.today.todayView(STRANGER, '2026-06-02');
			expect(owner.entries.every((e) => e.amountMinor === 10_000)).toBe(true);
			expect(stranger.entries.every((e) => e.amountMinor === 999_000)).toBe(true);
		});

		it('todayView still has no balance field', () => {
			// Invariant 1 survives multi-tenancy. Enforced by the type guard in
			// withholding.ts; asserted here so a refactor that widens the type
			// cannot pass silently.
			const view = m.today.todayView(OWNER, '2026-06-02') as unknown as Record<string, unknown>;
			for (const key of Object.keys(view)) {
				expect(key.toLowerCase()).not.toContain('balance');
			}
		});
	});

	// ── The endpoints that hand data to the outside world ────────────────
	//
	// These three were missed by the compiler sweep, because they never used
	// the `db` export that was renamed — they reach for the raw sqlite handle.
	// export.json was `SELECT * FROM <table>` with no filter, which would have
	// let any signed-in person download every other person's complete financial
	// history; import was `DELETE FROM <table>` with no filter, which would have
	// wiped every account in the system. Nothing structural catches this class,
	// so these tests are the guard.
	describe('data leaving the app', () => {
		it('export.json contains only the caller', async () => {
			const { GET } = await import('../../routes/api/export.json/+server');
			const res = await GET({ locals: { userId: OWNER } } as never);
			const body = (await res.json()) as { tables: Record<string, { user_id?: number }[]> };

			for (const [table, rows] of Object.entries(body.tables)) {
				for (const row of rows) {
					expect(`${table}:${row.user_id}`).toBe(`${table}:${OWNER}`);
				}
			}
			expect(body.tables.txn.length).toBe(3);
		});

		it('export.csv contains only the caller', async () => {
			const { GET } = await import('../../routes/api/export.csv/+server');
			const res = await GET({ locals: { userId: OWNER } } as never);
			const csv = await res.text();

			// The stranger's rows are ₱9,990 each. Their absence is the assertion.
			expect(csv).toContain('100.00');
			expect(csv).not.toContain('9990.00');
		});

		// Task A6, Spec §7.2: the `.ics` reminder is fetched by subscription id
		// straight off a route, so it is its own tenancy boundary — the same
		// class of bug export.json and import were, just discovered while this
		// route was still being written rather than after it shipped. Placed
		// before the import test below: that test's `?confirm=replace` wipes
		// and never restores the owner's `settings` row (RESTORE_ORDER deletes
		// every listed table regardless of whether the payload carries it), and
		// this route 409s with no settings row to read a currency symbol from.
		it('.ics reminder route refuses a subscription belonging to another user', async () => {
			const { GET } = await import('../../routes/subscriptions/[id]/reminder.ics/+server');

			const ownerSubId = m.subs.createSubscription(OWNER, {
				label: 'Owner-only trial',
				amountMinor: 54_900,
				cadence: 'monthly',
				nextChargeOn: '2026-09-24',
				trialEndsOn: '2026-09-24',
				cancelByOn: '2026-09-24'
			});

			// The owner can fetch their own reminder.
			const ownRes = GET({
				params: { id: String(ownerSubId) },
				locals: { userId: OWNER }
			} as never) as Response;
			expect(ownRes.headers.get('Content-Type')).toContain('text/calendar');
			expect(await ownRes.text()).toContain('Owner-only trial');

			// The stranger must not be able to fetch it by id, whether or not
			// they know it exists — a 404, not the owner's calendar text.
			expect(() =>
				GET({ params: { id: String(ownerSubId) }, locals: { userId: STRANGER } } as never)
			).toThrow();
		});

		it('import writes the caller as owner, whatever the file claims', async () => {
			const { POST } = await import('../../routes/api/import/+server');
			const payload = {
				format: 'split-export',
				tables: {
					// A file claiming to own the stranger's rows.
					wait_item: [
						{
							id: 4242,
							label: 'planted',
							amount_minor: 1,
							added_at: '2026-06-01',
							ripe_at: '2026-06-04',
							user_id: STRANGER
						}
					]
				}
			};
			await POST({
				request: new Request('http://x', { method: 'POST', body: JSON.stringify(payload) }),
				url: new URL('http://x/api/import?confirm=replace'),
				locals: { userId: OWNER }
			} as never);

			const planted = m.sqlite.prepare(`SELECT user_id FROM wait_item WHERE id = 4242`).get() as
				{ user_id: number } | undefined;
			// The id in the payload is ignored; the session decides.
			expect(planted?.user_id).toBe(OWNER);
		});
	});

	// ── Deleting a person really deletes them ────────────────────────────
	describe('cascade delete', () => {
		it('removes every row of one tenant and touches no other', () => {
			m.sqlite.pragma('foreign_keys = ON');

			const before = m.sqlite
				.prepare(`SELECT count(*) AS n FROM txn WHERE user_id = ?`)
				.get(OWNER) as { n: number };

			m.sqlite.prepare(`DELETE FROM app_user WHERE id = ?`).run(STRANGER);

			const tables = (
				m.sqlite
					.prepare(
						`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
						 AND name NOT IN ('_migration','app_user')`
					)
					.all() as { name: string }[]
			).map((r) => r.name);

			for (const t of tables) {
				const left = m.sqlite
					.prepare(`SELECT count(*) AS n FROM ${t} WHERE user_id = ?`)
					.get(STRANGER) as { n: number };
				expect(`${t}: ${left.n}`).toBe(`${t}: 0`);
			}

			const after = m.sqlite
				.prepare(`SELECT count(*) AS n FROM txn WHERE user_id = ?`)
				.get(OWNER) as { n: number };
			expect(after.n).toBe(before.n);
		});
	});
});
