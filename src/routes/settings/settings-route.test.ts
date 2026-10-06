/**
 * `/settings` — the `load` guard, the `save` action (the knobs), and the
 * `setBudget` action (Deliverable 2: supersede the open period, never
 * mutate it — A3.3, invariant 6).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';
import { addDays, localToday } from '$lib/server/clock';

type Mod = {
	sqlite: typeof import('$lib/server/db').sqlite;
	route: typeof import('./+page.server');
};

let m: Mod;
const USER = 1;
const TZ = 'Asia/Manila';

// The open-period tests need a window that genuinely contains "today" —
// openPeriodOn() reads the real clock, so a hardcoded window from whenever
// this file was written would eventually fall out of range and the period
// would silently stop being "open".
const WINDOW_STARTS = addDays(localToday(TZ), -3);
const WINDOW_ENDS = addDays(localToday(TZ), 3);

/** Invoke a form action the way SvelteKit does, with just the bits it reads. */
async function invoke(action: string, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const actions = m.route.actions as Record<string, (e: unknown) => Promise<unknown>>;
	try {
		return {
			result: await actions[action]({
				request: new Request('http://localhost/', { method: 'POST', body }),
				locals: { userId: USER }
			})
		};
	} catch (err) {
		if (isRedirect(err)) return { redirected: true, status: err.status, location: err.location };
		throw err;
	}
}

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-settingspage-')), 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
	const dbMod = await import('$lib/server/db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));
	m = { sqlite: dbMod.sqlite, route: await import('./+page.server') };
});

beforeEach(() => {
	m.sqlite.prepare(`DELETE FROM period WHERE user_id = ?`).run(USER);
	m.sqlite.prepare(`DELETE FROM txn WHERE user_id = ?`).run(USER);
	m.sqlite.prepare(`DELETE FROM settings WHERE user_id = ?`).run(USER);
	m.sqlite
		.prepare(
			`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
			                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
			                       timezone, created_at, user_id)
			 VALUES (1,'PHP','₱',2,1000,'weekly',0,15,10,0,'${TZ}','2026-08-01T00:00:00Z',?)`
		)
		.run(USER);
});

describe('/settings load', () => {
	it('reports not-ready when the account has no settings row', () => {
		m.sqlite.prepare(`DELETE FROM settings WHERE user_id = ?`).run(USER);
		const data = m.route.load({ locals: { userId: USER } } as never);
		expect(data.ready).toBe(false);
	});

	it('serves current settings and a null period when none is open', () => {
		const data = m.route.load({ locals: { userId: USER } } as never) as any;
		expect(data.ready).toBe(true);
		expect(data.settings.haircutPct).toBe(15);
		expect(data.period).toBeNull();
	});
});

describe('load and save agree', () => {
	/*
	 * Round-trip: everything `load` hands the page must be something `save`
	 * accepts back unchanged. A "save" that rejects its own rendered defaults
	 * is a page nobody can use, and every other test here passes anyway
	 * because they each post a hand-written, already-valid FormData.
	 *
	 * This is the cheap half of a real bug found only in the browser: the
	 * week-starts-on select compared a string against numeric option values,
	 * selected nothing, and posted "" — so EVERY save died on
	 * "weekStartsOn must be 0–6, got NaN", silently. A server-side test cannot
	 * see markup, so it cannot catch that directly; what it can pin is that
	 * the values themselves round-trip, which is the other half.
	 */
	it("accepts the settings load hands the page, unchanged", async () => {
		const data = m.route.load({ locals: { userId: USER } } as never) as any;
		const s = data.settings;
		const { result } = (await invoke('save', {
			timezone: String(s.timezone),
			currencyCode: String(s.currencyCode),
			currencySymbol: String(s.currencySymbol),
			minorUnits: String(s.minorUnits),
			roundingStep: String(s.roundingStep),
			periodKind: String(s.periodKind),
			weekStartsOn: String(s.weekStartsOn),
			haircutPct: String(s.haircutPct),
			bandPct: String(s.bandPct)
		})) as any;
		expect(
			result?.status,
			`save rejected its own defaults: ${result?.data?.error}`
		).toBeUndefined();
		expect(result.saved).toBe(true);
	});
});

describe('save action', () => {
	it('writes the knobs and leaves the open period untouched', async () => {
		m.sqlite
			.prepare(
				`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor,
				 daily_allowance_minor, haircut_pct_applied, phase_at_open, created_at, user_id)
				 VALUES (?,?,7,700000,85000,15,0,'x',?)`
			)
			.run(WINDOW_STARTS, WINDOW_ENDS, USER);

		const res = await invoke('save', {
			timezone: 'Europe/Lisbon',
			currencyCode: 'EUR',
			currencySymbol: '€',
			minorUnits: '2',
			roundingStep: '100',
			periodKind: 'weekly',
			weekStartsOn: '1',
			haircutPct: '20',
			bandPct: '12'
		});
		expect((res.result as any).saved).toBe(true);

		const s = m.sqlite.prepare(`SELECT * FROM settings WHERE user_id = ?`).get(USER) as any;
		expect(s.timezone).toBe('Europe/Lisbon');
		expect(s.haircut_pct).toBe(20);

		const p = m.sqlite.prepare(`SELECT * FROM period WHERE user_id = ?`).get(USER) as any;
		expect(p.daily_allowance_minor).toBe(85000);
		expect(p.haircut_pct_applied).toBe(15);
	});

	it('rejects an unknown period kind', async () => {
		const res = await invoke('save', {
			timezone: 'Asia/Manila',
			currencyCode: 'PHP',
			currencySymbol: '₱',
			minorUnits: '2',
			roundingStep: '1000',
			periodKind: 'yearly',
			weekStartsOn: '0',
			haircutPct: '15',
			bandPct: '10'
		});
		expect((res.result as any).status).toBe(400);
	});
});

describe('setBudget action', () => {
	it('supersedes the open period and never rewrites it', async () => {
		m.sqlite
			.prepare(
				`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor,
				 daily_allowance_minor, haircut_pct_applied, phase_at_open, created_at, user_id)
				 VALUES (?,?,7,700000,85000,15,0,'x',?)`
			)
			.run(WINDOW_STARTS, WINDOW_ENDS, USER);

		const res = await invoke('setBudget', { amount: '900.00' });
		const body = res.result as any;
		expect(body.budgetSaved).toBe(true);
		expect(body.budgetAmountMinor).toBe(90_000);
		expect(body.budgetWindow).toEqual({ startsOn: WINDOW_STARTS, endsOn: WINDOW_ENDS });
		expect(body.budgetBand.low).toBeGreaterThan(0);

		const rows = m.sqlite.prepare(`SELECT * FROM period WHERE user_id = ? ORDER BY id`).all(USER) as any[];
		expect(rows).toHaveLength(2);

		// The old row is closed, never mutated in place — same starts/ends/days
		// and the SAME frozen allowance it opened with.
		expect(rows[0].closed_at).not.toBeNull();
		expect(rows[0].spend_alloc_minor).toBe(700000);
		expect(rows[0].daily_allowance_minor).toBe(85000);

		// The new row supersedes it, same window, new allocation.
		expect(rows[1].supersedes_id).toBe(rows[0].id);
		expect(rows[1].starts_on).toBe(WINDOW_STARTS);
		expect(rows[1].ends_on).toBe(WINDOW_ENDS);
		expect(rows[1].spend_alloc_minor).toBe(90_000);
		expect(rows[1].closed_at).toBeNull();
	});

	it('fails with a clear message when no period is open, and creates nothing', async () => {
		const res = await invoke('setBudget', { amount: '900.00' });
		const body = res.result as any;
		expect(body.status).toBe(409);
		expect(body.data.budgetError).toMatch(/no.*period|not open/i);

		const rows = m.sqlite.prepare(`SELECT * FROM period WHERE user_id = ?`).all(USER);
		expect(rows).toHaveLength(0);
	});

	it('rejects a non-positive amount and preserves the entered value', async () => {
		m.sqlite
			.prepare(
				`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor,
				 daily_allowance_minor, haircut_pct_applied, phase_at_open, created_at, user_id)
				 VALUES (?,?,7,700000,85000,15,0,'x',?)`
			)
			.run(WINDOW_STARTS, WINDOW_ENDS, USER);

		const res = await invoke('setBudget', { amount: '-5' });
		const body = res.result as any;
		expect(body.status).toBe(400);
		expect(body.data.budgetRaw).toBe('-5');

		const rows = m.sqlite.prepare(`SELECT * FROM period WHERE user_id = ?`).all(USER);
		expect(rows).toHaveLength(1);
	});

	it('rejects an unparseable amount and preserves the entered value', async () => {
		m.sqlite
			.prepare(
				`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor,
				 daily_allowance_minor, haircut_pct_applied, phase_at_open, created_at, user_id)
				 VALUES (?,?,7,700000,85000,15,0,'x',?)`
			)
			.run(WINDOW_STARTS, WINDOW_ENDS, USER);

		const res = await invoke('setBudget', { amount: 'lots' });
		const body = res.result as any;
		expect(body.status).toBe(400);
		expect(body.data.budgetRaw).toBe('lots');
	});
});
