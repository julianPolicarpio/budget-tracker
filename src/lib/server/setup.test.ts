/**
 * First-run setup: the window, the derivation, and the single period it writes.
 *
 * The property under test is the one the spec names: the first allocation is
 * DERIVED (invariant 7), and period #1 is the only row setup creates.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

let m: {
	sqlite: import('better-sqlite3').Database;
	setup: typeof import('./setup');
};
const USER = 1;

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-setup-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));
	m = { sqlite: dbMod.sqlite, setup: await import('./setup') };
});

beforeEach(() => {
	m.sqlite.prepare(`DELETE FROM txn WHERE user_id = ?`).run(USER);
	m.sqlite.prepare(`DELETE FROM period WHERE user_id = ?`).run(USER);
	m.sqlite.prepare(`DELETE FROM income_source WHERE user_id = ?`).run(USER);

	// applyMigrations alone leaves `settings` empty — it is populated at
	// runtime by provisionUser(), not by a migration. completeSetup() only
	// UPDATEs settings (invariant: it is provisioned before /setup runs), so
	// the row has to exist first. Same raw INSERT, same STARTER_SETTINGS
	// defaults (haircut_pct 15, band_pct 10) as phase2/phase3/phase4 and the
	// other *.integration.test.ts files that hit this same gap — copied here
	// rather than invented, since income.integration.test.ts (the harness this
	// file's DB setup was modeled on) is the one suite that never needed it.
	//
	// Re-seeded every test, not just once in beforeAll: `completeSetup()`
	// mutates this row (the "writes the answers" test leaves EUR/Lisbon behind
	// otherwise), and every test should start from the same state.
	m.sqlite.prepare(`DELETE FROM settings WHERE user_id = ?`).run(USER);
	m.sqlite
		.prepare(
			`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
			                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
			                       timezone, created_at, user_id)
			 VALUES (1,'PHP','₱',2,1000,'weekly',0,15,10,0,'Asia/Manila','2026-08-01T00:00:00Z',?)`
		)
		.run(USER);
});

describe('firstPeriodWindow', () => {
	it('anchors a weekly window on week_starts_on, not on the signup day', () => {
		// 2026-09-16 is a Wednesday. Sunday-start week began 2026-09-13.
		const w = m.setup.firstPeriodWindow('2026-09-16', 'weekly', 0);
		expect(w).toEqual({ startsOn: '2026-09-13', endsOn: '2026-09-19', days: 7 });
	});

	it('splits a semi-monthly month at the 15th', () => {
		expect(m.setup.firstPeriodWindow('2026-09-04', 'semimonthly', 0)).toEqual({
			startsOn: '2026-09-01',
			endsOn: '2026-09-15',
			days: 15
		});
		expect(m.setup.firstPeriodWindow('2026-09-20', 'semimonthly', 0)).toEqual({
			startsOn: '2026-09-16',
			endsOn: '2026-09-30',
			days: 15
		});
	});

	it('gives February its real length, not 30 days', () => {
		expect(m.setup.firstPeriodWindow('2027-02-10', 'monthly', 0)).toEqual({
			startsOn: '2027-02-01',
			endsOn: '2027-02-28',
			days: 28
		});
	});
});

const BASE: Omit<import('./setup').SetupInput, 'income' | 'monthlyBillsMinor'> = {
	timezone: 'Europe/Lisbon',
	currencyCode: 'EUR',
	currencySymbol: '€',
	minorUnits: 2,
	roundingStep: 100,
	periodKind: 'weekly',
	weekStartsOn: 1
};

describe('completeSetup', () => {
	it('derives the allocation from the pay cycle and opens exactly one period', () => {
		const r = m.setup.completeSetup(
			USER,
			{
				...BASE,
				income: {
					label: 'Salary',
					amountMinor: 200_000,
					cadence: 'biweekly',
					anchorOn: '2026-09-18',
					secondDay: null,
					baselineMinor: null
				},
				monthlyBillsMinor: 60_000
			},
			new Date('2026-09-16T12:00:00Z')
		);

		// 200000 / 14 * 7 — the cycle, not the arrivals inside the window.
		expect(r.waterfall.expectedMinor).toBe(100_000);
		// 60000 / 30.4375 * 7 = 13798.8 → 13799.
		expect(r.waterfall.billsMinor).toBe(13_799);
		expect(r.spendAllocMinor).toBe(86_201);
		// 86201 * 85 / (100 * 7), one rounding at the end.
		expect(r.dailyAllowanceMinor).toBe(10_467);
		expect(r.window).toEqual({ startsOn: '2026-09-14', endsOn: '2026-09-20', days: 7 });

		const periods = m.sqlite.prepare(`SELECT * FROM period WHERE user_id = ?`).all(USER) as any[];
		expect(periods).toHaveLength(1);
		expect(periods[0].spend_alloc_minor).toBe(r.spendAllocMinor);
		expect(periods[0].daily_allowance_minor).toBe(r.dailyAllowanceMinor);
	});

	it('writes the answers into the settings row', () => {
		m.setup.completeSetup(
			USER,
			{
				...BASE,
				income: {
					label: 'Salary',
					amountMinor: 200_000,
					cadence: 'monthly',
					anchorOn: '2026-09-15',
					secondDay: null,
					baselineMinor: null
				},
				monthlyBillsMinor: 0
			},
			new Date('2026-09-16T12:00:00Z')
		);
		const s = m.sqlite.prepare(`SELECT * FROM settings WHERE user_id = ?`).get(USER) as any;
		expect(s.timezone).toBe('Europe/Lisbon');
		expect(s.currency_code).toBe('EUR');
		expect(s.week_starts_on).toBe(1);
	});

	it('gives the same allocation whichever week of the pay cycle you sign up in', () => {
		// THE REGRESSION TEST. The previous derivation summed arrivals inside the
		// window, so this week — which contains no payday, the next being
		// 2026-10-02 — produced an allocation of exactly zero, frozen forever.
		const input = {
			...BASE,
			income: {
				label: 'Salary',
				amountMinor: 200_000,
				cadence: 'biweekly' as const,
				anchorOn: '2026-09-18',
				secondDay: null,
				baselineMinor: null
			},
			monthlyBillsMinor: 60_000
		};

		const paydayWeek = m.setup.completeSetup(USER, input, new Date('2026-09-16T12:00:00Z'));

		m.sqlite.prepare(`DELETE FROM period WHERE user_id = ?`).run(USER);
		m.sqlite.prepare(`DELETE FROM income_source WHERE user_id = ?`).run(USER);

		const quietWeek = m.setup.completeSetup(USER, input, new Date('2026-09-23T12:00:00Z'));

		expect(quietWeek.window.startsOn).toBe('2026-09-21');
		expect(quietWeek.waterfall.expectedMinor).toBe(paydayWeek.waterfall.expectedMinor);
		expect(quietWeek.spendAllocMinor).toBe(paydayWeek.spendAllocMinor);
		expect(quietWeek.dailyAllowanceMinor).toBe(paydayWeek.dailyAllowanceMinor);
		expect(quietWeek.spendAllocMinor).toBeGreaterThan(0);
	});

	it('funds Spending at zero rather than negative when bills exceed income', () => {
		const r = m.setup.completeSetup(
			USER,
			{
				...BASE,
				income: {
					label: 'Salary',
					amountMinor: 10_000,
					cadence: 'monthly',
					anchorOn: '2026-09-15',
					secondDay: null,
					baselineMinor: null
				},
				monthlyBillsMinor: 500_000
			},
			new Date('2026-09-16T12:00:00Z')
		);
		expect(r.waterfall.short).toBe(true);
		expect(r.spendAllocMinor).toBe(0);
		expect(r.dailyAllowanceMinor).toBe(0);
	});

	it('refuses to run twice — periods are immutable', () => {
		const input = {
			...BASE,
			income: {
				label: 'Salary',
				amountMinor: 200_000,
				cadence: 'monthly' as const,
				anchorOn: '2026-09-15',
				secondDay: null,
				baselineMinor: null
			},
			monthlyBillsMinor: 0
		};
		m.setup.completeSetup(USER, input, new Date('2026-09-16T12:00:00Z'));
		expect(() => m.setup.completeSetup(USER, input, new Date('2026-09-16T12:00:00Z'))).toThrow(
			/already has a period/
		);
	});

	it('needsSetup is true only until the first period exists', () => {
		expect(m.setup.needsSetup(USER)).toBe(true);
		m.setup.completeSetup(
			USER,
			{
				...BASE,
				income: {
					label: 'Salary',
					amountMinor: 200_000,
					cadence: 'monthly',
					anchorOn: '2026-09-15',
					secondDay: null,
					baselineMinor: null
				},
				monthlyBillsMinor: 0
			},
			new Date('2026-09-16T12:00:00Z')
		);
		expect(m.setup.needsSetup(USER)).toBe(false);
	});
});
