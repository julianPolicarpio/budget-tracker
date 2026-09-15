/**
 * Income sources and projectArrivals (invariant 7).
 *
 * The property under test is the one the invariant names: an allocation is
 * derived from arrivals that actually land, never from a rate. Spec §4.1 calls
 * bi-weekly versus semi-monthly "different by ~8% and conflated constantly,
 * including by people who have been paid bi-weekly for a decade" — so that
 * pair gets the most attention here.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

let m: { sqlite: import('better-sqlite3').Database; income: typeof import('./income') };
const USER = 1;

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-income-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));
	m = { sqlite: dbMod.sqlite, income: await import('./income') };
});

beforeEach(() => {
	m.sqlite.prepare(`DELETE FROM income_source WHERE user_id = ?`).run(USER);
});

function add(
	label: string,
	amountMinor: number,
	cadence: string,
	anchorOn: string | null,
	secondDay: number | null = null,
	baselineMinor: number | null = null
) {
	m.sqlite
		.prepare(
			`INSERT INTO income_source
			   (label, amount_minor, cadence, anchor_on, second_day, baseline_minor, created_at, user_id)
			 VALUES (?,?,?,?,?,?,'x',?)`
		)
		.run(label, amountMinor, cadence, anchorOn, secondDay, baselineMinor, USER);
}

describe('the bi-weekly trap', () => {
	it('bi-weekly lands 26 times a year, not 24', () => {
		add('Wage', 500_00, 'biweekly', '2026-01-02');
		const year = m.income.projectArrivals(USER, '2026-01-01', '2026-12-31');
		expect(year).toHaveLength(26);
	});

	it('semi-monthly lands 24 times a year, not 26', () => {
		add('Salary', 500_00, 'semimonthly', '2026-01-15', 30);
		const year = m.income.projectArrivals(USER, '2026-01-01', '2026-12-31');
		expect(year).toHaveLength(24);
	});

	it('the two differ by about 8% over a year, which is the whole point', () => {
		add('Wage', 500_00, 'biweekly', '2026-01-02');
		const bi = m.income.expectedIncome(USER, '2026-01-01', '2026-12-31');

		m.sqlite.prepare(`DELETE FROM income_source WHERE user_id = ?`).run(USER);
		add('Salary', 500_00, 'semimonthly', '2026-01-15', 30);
		const semi = m.income.expectedIncome(USER, '2026-01-01', '2026-12-31');

		expect(bi).toBeGreaterThan(semi);
		expect((bi - semi) / semi).toBeCloseTo(2 / 24, 2);
	});

	it('bi-weekly really does produce a three-paycheque month, rather than averaging it away', () => {
		add('Wage', 500_00, 'biweekly', '2026-01-02');
		const jan = m.income.projectArrivals(USER, '2026-01-01', '2026-01-31');
		expect(jan).toHaveLength(3);
	});
});

describe('date-repeated cadences never drift', () => {
	it('semi-monthly hits the same two dates every month', () => {
		add('Salary', 100_00, 'semimonthly', '2026-03-15', 30);
		const arrivals = m.income.projectArrivals(USER, '2026-03-01', '2026-05-31');
		expect(arrivals.map((a) => a.on)).toEqual([
			'2026-03-15',
			'2026-03-30',
			'2026-04-15',
			'2026-04-30',
			'2026-05-15',
			'2026-05-30'
		]);
	});

	it('a 31st pay date lands on the last day of a short month rather than vanishing', () => {
		add('Salary', 100_00, 'monthly', '2026-01-31');
		const arrivals = m.income.projectArrivals(USER, '2026-01-01', '2026-04-30');
		// February has no 31st. Dropping the arrival would silently lower the
		// year's income and nothing would show it.
		expect(arrivals.map((a) => a.on)).toEqual([
			'2026-01-31',
			'2026-02-28',
			'2026-03-31',
			'2026-04-30'
		]);
	});

	it('never projects before the anchor', () => {
		add('Salary', 100_00, 'monthly', '2026-06-10');
		const arrivals = m.income.projectArrivals(USER, '2026-01-01', '2026-12-31');
		expect(arrivals[0].on).toBe('2026-06-10');
	});
});

describe('irregular income budgets to the lowest month, or to nothing', () => {
	it('contributes nothing at all without a baseline', () => {
		add('Freelance', 0, 'irregular', null);
		expect(m.income.projectArrivals(USER, '2026-01-01', '2026-12-31')).toHaveLength(0);
		// A guess here would be an allocation built on a figure nobody observed.
		expect(m.income.expectedIncome(USER, '2026-01-01', '2026-01-31')).toBe(0);
	});

	it('pro-rates its baseline by days once there is one', () => {
		add('Freelance', 0, 'irregular', null, null, 300_000);
		const week = m.income.expectedIncome(USER, '2026-01-01', '2026-01-07');
		// A month's baseline over seven days, not a twelfth of a year.
		expect(week).toBe(Math.round((300_000 * 7) / (365.25 / 12)));
	});
});

describe('the waterfall', () => {
	it('fills in order and gives Spending the remainder', () => {
		const w = m.income.waterfall(100_000, 30_000, 20_000, 10_000);
		expect(w).toMatchObject({
			billsMinor: 30_000,
			irregularsMinor: 20_000,
			bufferMinor: 10_000,
			spendMinor: 40_000,
			short: false
		});
	});

	it('never lets Spending go negative, and says it is short', () => {
		const w = m.income.waterfall(40_000, 30_000, 20_000, 10_000);
		expect(w.billsMinor).toBe(30_000);
		expect(w.irregularsMinor).toBe(10_000); // all that was left
		expect(w.bufferMinor).toBe(0);
		expect(w.spendMinor).toBe(0);
		// Surfaced, never borrowed from the buckets above — silently
		// under-funding Big bills is how a known cost becomes a raided
		// emergency fund three months later.
		expect(w.short).toBe(true);
	});
});

describe('multiple sources coexist', () => {
	it('sums a salary and a side wage into one expectation', () => {
		add('Salary', 2_000_00, 'semimonthly', '2026-03-15', 30);
		add('Tutoring', 150_00, 'weekly', '2026-03-02');
		const march = m.income.projectArrivals(USER, '2026-03-01', '2026-03-31');
		expect(march.filter((a) => a.label === 'Salary')).toHaveLength(2);
		expect(march.filter((a) => a.label === 'Tutoring')).toHaveLength(5);
		expect(m.income.expectedIncome(USER, '2026-03-01', '2026-03-31')).toBe(
			2_000_00 * 2 + 150_00 * 5
		);
	});
});

describe('sustainableIncomeMinor', () => {
	it('reads the cycle, not the window — the same figure whichever week you ask about', () => {
		// ₱2,000.00 every second Friday. Sustainable weekly figure is ₱1,000.00,
		// regardless of whether the week being asked about contains a payday.
		add('Salary', 200_000, 'biweekly', '2026-09-18');
		expect(m.income.sustainableIncomeMinor(USER, 7)).toBe(100_000);
	});

	it('keeps fortnightly and twice-monthly ~8% apart', () => {
		add('Fortnightly', 200_000, 'biweekly', '2026-09-18');
		const fortnightly = m.income.sustainableIncomeMinor(USER, 7);

		m.sqlite.prepare(`DELETE FROM income_source WHERE user_id = ?`).run(USER);
		add('Twice monthly', 200_000, 'semimonthly', '2026-09-15', 30);
		const semimonthly = m.income.sustainableIncomeMinor(USER, 7);

		// 14 days per cycle against 365.25/24 = 15.22. Fortnightly is the larger.
		expect(fortnightly).toBe(100_000);
		expect(semimonthly).toBe(91_992);
		expect(fortnightly / semimonthly).toBeCloseTo(1.087, 3);
	});

	it('sums every live source', () => {
		add('Salary', 140_000, 'weekly', '2026-09-18');
		add('Side work', 200_000, 'biweekly', '2026-09-18');
		expect(m.income.sustainableIncomeMinor(USER, 7)).toBe(240_000);
	});

	it('counts an irregular source only once it has a baseline', () => {
		add('Freelance', 0, 'irregular', null, null, null);
		expect(m.income.sustainableIncomeMinor(USER, 7)).toBe(0);

		m.sqlite.prepare(`DELETE FROM income_source WHERE user_id = ?`).run(USER);
		add('Freelance', 0, 'irregular', null, null, 300_000);
		// 300000 / 30.4375 * 7 = 68,993.8
		expect(m.income.sustainableIncomeMinor(USER, 7)).toBe(68_994);
	});

	it('returns zero when there are no sources at all', () => {
		expect(m.income.sustainableIncomeMinor(USER, 7)).toBe(0);
	});
});

describe('monthlyToWindowMinor', () => {
	it('converts a monthly figure by the same rule income uses', () => {
		// 60000 / 30.4375 * 7 = 13,798.8
		expect(m.income.monthlyToWindowMinor(60_000, 7)).toBe(13_799);
	});

	it('is proportional to the window', () => {
		expect(m.income.monthlyToWindowMinor(60_000, 14)).toBe(27_598);
	});
});
