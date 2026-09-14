/**
 * Phase 3 against a real SQLite file: the metric quarantine, the irregulars
 * engine, the IOU rule, and the phase engine's refusal to advance on its own.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	unsafeDb: typeof import('./db').unsafeDb;
	sqlite: typeof import('./db').sqlite;
	schema: typeof import('./db').schema;
	irregulars: typeof import('./irregulars');
	accounts: typeof import('./accounts');
	phases: typeof import('./phases');
	metrics: typeof import('./metrics');
	allocations: typeof import('./allocations');
	today: typeof import('./today');
};

let m: Mod;
const TODAY = '2026-08-16';

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-p3-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	// The one runner, same as production. These five suites each had their own
	// copy of this loop, and every copy broke the moment a migration needed
	// foreign keys off to rebuild a table.
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	m = {
		unsafeDb: dbMod.unsafeDb,
		sqlite: dbMod.sqlite,
		schema: dbMod.schema,
		irregulars: await import('./irregulars'),
		accounts: await import('./accounts'),
		phases: await import('./phases'),
		metrics: await import('./metrics'),
		allocations: await import('./allocations'),
		today: await import('./today')
	};

	m.sqlite
		.prepare(
			`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
			                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
			                       timezone, weekly_take_home_minor, created_at)
			 VALUES (1,'PHP','₱',2,1000,'weekly',0,15,10,1,'Asia/Manila',600000,'2026-08-01T00:00:00Z')`
		)
		.run();

	m.sqlite
		.prepare(
			`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor, daily_allowance_minor,
			                     haircut_pct_applied, phase_at_open, created_at)
			 VALUES ('2026-08-16','2026-08-22',7,420000,51000,15,1,'2026-08-16T00:00:00Z')`
		)
		.run();
});

function addIrregular(
	label: string,
	amountMinor: number,
	cadence: string,
	nextDueOn: string,
	paddingPct = 25,
	cadenceN: number | null = null
): number {
	return Number(
		m.sqlite
			.prepare(
				`INSERT INTO irregular (label, amount_minor, is_estimate, cadence, cadence_n,
				                        next_due_on, padding_pct, created_at)
				 VALUES (?,?,1,?,?,?,?,'2026-08-01T00:00:00Z')`
			)
			.run(label, amountMinor, cadence, cadenceN, nextDueOn, paddingPct).lastInsertRowid
	);
}

// ─────────────────────────────────────────────────────────────────────────
describe('the metric quarantine', () => {
	it('excludes trip spending from ongoing metrics without any metric asking', () => {
		const range = { from: '2026-07-01', to: '2026-07-07' };
		// A real trip row: migration 0004 put the foreign key on txn.trip_id, so a
		// made-up id is now correctly rejected.
		m.sqlite
			.prepare(
				`INSERT INTO trip (id, label, starts_on, ends_on, trip_tz, currency_code,
				                   currency_symbol, local_minor_units, fx_rate_to_home,
				                   envelope_minor, status, created_at)
				 VALUES (1,'Tokyo','2026-07-04','2026-07-11','Asia/Tokyo','JPY','¥',0,0.38,
				         800000,'settled','2026-06-01T00:00:00Z')`
			)
			.run();

		const ins = m.sqlite.prepare(
			`INSERT INTO txn (spent_on, amount_minor, category, planned, entered_at, trip_id)
			 VALUES (?,?,?,?,?,?)`
		);
		ins.run('2026-07-02', 30_000, 'food_out', 0, '2026-07-02T21:00:00Z', null);
		ins.run('2026-07-03', 10_000, 'food_out', 1, '2026-07-03T21:00:00Z', null);

		const before = m.metrics.weekActuals(1, range);
		expect(before.totalMinor).toBe(40_000);
		expect(before.unplannedRatioBp).toBe(7500);

		// A week abroad at four times normal spend, all of it unplanned.
		for (let i = 0; i < 5; i++) {
			ins.run('2026-07-04', 160_000, 'stuff', 0, '2026-07-04T21:00:00Z', 1);
		}

		const after = m.metrics.weekActuals(1, range);
		expect(after.totalMinor).toBe(40_000);
		expect(after.unplannedRatioBp).toBe(7500);
		expect(m.metrics.topThree(1, range).map((t) => t.amountMinor)).toEqual([30_000, 10_000]);
	});

	it('still counts trip days for log adherence — the streak keeps the app open', () => {
		for (const d of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']) {
			m.sqlite
				.prepare(
					`INSERT INTO log_day (logged_on, entry_count, is_catchup, closed_at) VALUES (?,1,0,?)`
				)
				.run(d, `${d}T22:00:00Z`);
		}
		expect(m.metrics.logAdherenceBp(1, { from: '2026-07-01', to: '2026-07-07' })).toBe(
			Math.round((4 * 10_000) / 7)
		);
	});
});

describe('projection', () => {
	it('clamps month arithmetic instead of rolling into the next month', () => {
		// A cost due on the 31st recurs on the 28th in February, not 3 March —
		// rolling it forward moves it into the wrong accrual window.
		expect(m.irregulars.addMonths('2026-01-31', 1)).toBe('2026-02-28');
		expect(m.irregulars.addMonths('2028-01-31', 1)).toBe('2028-02-29');
		expect(m.irregulars.addMonths('2026-03-31', 1)).toBe('2026-04-30');
	});

	it('projects each cadence onto real dates', () => {
		const at = (cadence: string, n: number | null = null) =>
			m.irregulars.projectDueDates(
				{ cadence: cadence as never, cadenceN: n, nextDueOn: '2026-09-01' },
				'2026-08-16',
				'2028-08-16'
			);

		expect(at('monthly')).toHaveLength(24);
		expect(at('quarterly')).toHaveLength(8);
		expect(at('semiannual')).toHaveLength(4);
		// The window closes 16 Aug 2028, so the third September is outside it.
		expect(at('annual')).toEqual(['2026-09-01', '2027-09-01']);
		expect(at('every_n_years', 3)).toEqual(['2026-09-01']);
		expect(at('one_off')).toEqual(['2026-09-01']);
		// Day-based cadences (Spec §5.1): 103 weekly and 52 fortnightly instances
		// land in the same two-year window, none of it computed via addMonths.
		expect(at('weekly')).toHaveLength(103);
		expect(at('fortnightly')).toHaveLength(52);
	});

	it('applies the mandatory padding to the accrued amount', () => {
		expect(m.irregulars.paddedAmount(400_000, 25)).toBe(500_000);
		expect(m.irregulars.paddedAmount(333, 25)).toBe(416);
	});

	it('advances a weekly irregular by exactly 7 days across a month boundary', () => {
		const dates = m.irregulars.projectDueDates(
			{ cadence: 'weekly' as never, cadenceN: null, nextDueOn: '2026-08-27' },
			'2026-08-27',
			'2026-09-10'
		);
		// 27 Aug -> 3 Sep -> 10 Sep: a plain 7-day step across the month
		// boundary, never addMonths, and never clamped to a shorter month.
		expect(dates).toEqual(['2026-08-27', '2026-09-03', '2026-09-10']);
	});

	it('advances a weekly irregular by exactly 7 days across a leap year', () => {
		// 2028 is a leap year. A day-based cadence steps through 29 Feb as an
		// ordinary day; addMonths would never even reach it for a weekly cost.
		const dates = m.irregulars.projectDueDates(
			{ cadence: 'weekly' as never, cadenceN: null, nextDueOn: '2028-02-22' },
			'2028-02-22',
			'2028-03-07'
		);
		expect(dates).toEqual(['2028-02-22', '2028-02-29', '2028-03-07']);
	});

	it('advances a fortnightly irregular by exactly 14 days', () => {
		const dates = m.irregulars.projectDueDates(
			{ cadence: 'fortnightly' as never, cadenceN: null, nextDueOn: '2026-08-27' },
			'2026-08-27',
			'2026-09-24'
		);
		expect(dates).toEqual(['2026-08-27', '2026-09-10', '2026-09-24']);
	});
});

describe('padding defaults scale with observation frequency (Spec §5.3)', () => {
	it('gives each cadence its own default padding percentage on creation', () => {
		// Overrides migrations/0003's "Not negotiable downward" for the DEFAULT
		// only — a weekly cost is observed 52 times a year and carries none of
		// F10's underestimation bias toward rarely-seen costs. Existing rows
		// (padding_pct DEFAULT 25 in the schema) are never touched by this.
		expect(m.irregulars.DEFAULT_PADDING_PCT).toEqual({
			one_off: 25,
			weekly: 5,
			fortnightly: 10,
			monthly: 15,
			quarterly: 20,
			semiannual: 25,
			annual: 25,
			every_n_years: 25
		});
	});
});

describe('materialisation', () => {
	it('writes instances forward and is idempotent on a second run', () => {
		addIrregular('Enrolment', 400_000, 'semiannual', '2026-08-21');
		addIrregular('Insurance', 900_000, 'annual', '2026-11-04');

		const first = m.irregulars.materialise(1, TODAY);
		expect(first).toBeGreaterThan(0);

		const second = m.irregulars.materialise(1, TODAY);
		expect(second).toBe(0);
	});

	it('prices instances with padding included', () => {
		const row = m.sqlite
			.prepare(
				`SELECT expected_minor AS e FROM irregular_instance
				 JOIN irregular ON irregular.id = irregular_instance.irregular_id
				 WHERE irregular.label = 'Enrolment' ORDER BY due_on LIMIT 1`
			)
			.get() as { e: number };
		expect(row.e).toBe(500_000);
	});
});

describe('coverage', () => {
	it('is null rather than infinite when nothing is due', () => {
		const c = m.irregulars.coverage(1, '2030-01-01');
		expect(c.ratioBp).toBeNull();
		expect(c.firstAtRisk).toBeNull();
	});

	it('names the instance that bounces first when short', () => {
		// Both land inside 90 days of 16 Aug: Enrolment on the 21st at ₱5,000
		// padded, Insurance on 4 Nov at ₱11,250 padded.
		m.accounts.assertBalance(1, 4, 300_000, TODAY);
		const c = m.irregulars.coverage(1, TODAY);

		expect(c.due90Minor).toBe(1_625_000);
		expect(c.ratioBp).toBe(1846);
		expect(c.shortfallMinor).toBe(1_325_000);
		// The earliest one it cannot cover, not the largest.
		expect(c.firstAtRisk?.label).toBe('Enrolment');
	});

	it('reads above 1.0 once the balance covers the window', () => {
		m.accounts.assertBalance(1, 4, 1_800_000, TODAY);
		expect(m.irregulars.coverage(1, TODAY).ratioBp).toBe(11_077);
		expect(m.irregulars.coverage(1, TODAY).firstAtRisk).toBeNull();
	});
});

describe('accrual', () => {
	it('raises when a large cost is added close to its due date', () => {
		const before = m.irregulars.requiredAccrualPerPeriod(1, TODAY, 7);
		addIrregular('Laptop', 8_000_000, 'one_off', '2026-10-15');
		m.irregulars.materialise(1, TODAY);
		const after = m.irregulars.requiredAccrualPerPeriod(1, TODAY, 7);
		expect(after).toBeGreaterThan(before);
	});
});

describe('settling', () => {
	it('stores actual separately from estimate and draws the money down', () => {
		const inst = m.sqlite
			.prepare(
				`SELECT irregular_instance.id AS id FROM irregular_instance
				 JOIN irregular ON irregular.id = irregular_instance.irregular_id
				 WHERE irregular.label = 'Enrolment' ORDER BY due_on LIMIT 1`
			)
			.get() as { id: number };

		const balanceBefore = m.accounts.accountByKind(1, 'irregulars')!.balanceMinor;
		m.irregulars.settleInstance(1, inst.id, 540_000, '2026-08-21');

		const row = m.sqlite
			.prepare(
				'SELECT expected_minor AS e, actual_minor AS a, status FROM irregular_instance WHERE id = ?'
			)
			.get(inst.id) as { e: number; a: number; status: string };

		expect(row.status).toBe('settled');
		expect(row.e).toBe(500_000); // the estimate is not overwritten
		expect(row.a).toBe(540_000);
		expect(m.accounts.accountByKind(1, 'irregulars')!.balanceMinor).toBe(balanceBefore - 540_000);
	});

	it('feeds the calibration chart with the delta', () => {
		const rows = m.irregulars.estimateAccuracy(1, '2026-01-01');
		const enrolment = rows.find((r) => r.label === 'Enrolment')!;
		expect(enrolment.actualMinor - enrolment.expectedMinor).toBe(40_000);
	});

	it('archives a one-off with nothing left, but keeps a recurring one alive', () => {
		const oneOff = m.sqlite
			.prepare(
				`SELECT irregular_instance.id AS id FROM irregular_instance
				 JOIN irregular ON irregular.id = irregular_instance.irregular_id
				 WHERE irregular.label = 'Laptop' LIMIT 1`
			)
			.get() as { id: number };
		m.irregulars.settleInstance(1, oneOff.id, 7_500_000, '2026-10-15');

		const laptop = m.sqlite
			.prepare(`SELECT archived_at AS a FROM irregular WHERE label = 'Laptop'`)
			.get() as { a: string | null };
		expect(laptop.a).not.toBeNull();

		const enrolment = m.sqlite
			.prepare(`SELECT archived_at AS a, next_due_on AS n FROM irregular WHERE label = 'Enrolment'`)
			.get() as { a: string | null; n: string };
		expect(enrolment.a).toBeNull();
		expect(enrolment.n > '2026-08-21').toBe(true);
	});
});

describe('reconciliation', () => {
	it('surfaces instances that came and went unmarked', () => {
		// Declared with a date that has already passed. If this never
		// materialises, the obligation is invisible and the ledger drifts —
		// which is the exact failure the forced three-way choice exists for.
		addIrregular('Org dues', 100_000, 'annual', '2026-08-01');
		m.irregulars.materialise(1, TODAY);
		expect(m.irregulars.overdue(1, TODAY).map((o) => o.label)).toContain('Org dues');
	});

	it('drops out of the queue once resolved either way', () => {
		const inst = m.irregulars.overdue(1, TODAY).find((o) => o.label === 'Org dues')!;
		m.irregulars.skipInstance(1, inst.id);
		expect(m.irregulars.overdue(1, TODAY).map((o) => o.label)).not.toContain('Org dues');
	});
});

describe('the IOU rule', () => {
	it('refuses to move money out of savings without a note', () => {
		expect(() =>
			m.accounts.recordTransfer(1, {
				fromAccountId: 5, // Buffer
				toAccountId: 3, // Spend
				amountMinor: 50_000,
				movedOn: TODAY
			})
		).toThrow(m.accounts.IouRequired);
	});

	it('allows it with a note, and both balances move', () => {
		m.accounts.assertBalance(1, 5, 1_800_000, TODAY);
		m.accounts.assertBalance(1, 3, 100_000, TODAY);

		m.accounts.recordTransfer(1, {
			fromAccountId: 5,
			toAccountId: 3,
			amountMinor: 50_000,
			movedOn: TODAY,
			iouReason: 'Bike repair, back on payday',
			iouRepayBy: '2026-08-30'
		});

		expect(m.accounts.accountByKind(1, 'buffer')!.balanceMinor).toBe(1_750_000);
		expect(m.accounts.accountByKind(1, 'spend')!.balanceMinor).toBe(150_000);
	});

	it('does not demand a note for a move into savings', () => {
		expect(() =>
			m.accounts.recordTransfer(1, {
				fromAccountId: 1, // Inflow
				toAccountId: 5, // Buffer
				amountMinor: 20_000,
				movedOn: TODAY
			})
		).not.toThrow();
	});

	it('lists the open IOUs one by one, and flags an overdue one', () => {
		const ious = m.accounts.openIous(1, '2026-09-05');
		expect(ious).toHaveLength(1);
		expect(ious[0].reason).toBe('Bike repair, back on payday');
		expect(ious[0].overdue).toBe(true);

		m.accounts.repayIou(1, ious[0].id);
		expect(m.accounts.openIous(1, '2026-09-05')).toHaveLength(0);
	});
});

describe('the phase engine', () => {
	it('never advances on its own — it only records a proposal', () => {
		const settings = m.today.loadSettings(1)!;
		expect(settings.phase).toBe(1);

		// 6 weeks of a ₱6,000 take-home is ₱36,000.
		m.accounts.assertBalance(1, 5, 3_700_000, TODAY);
		const proposal = m.phases.proposePhaseChange(1, m.today.loadSettings(1)!, TODAY);

		expect(proposal).not.toBeNull();
		expect(proposal!.toPhase).toBe(2);
		expect(proposal!.rationale).toContain('6.0 weeks');
		// The setting has NOT moved.
		expect(m.today.loadSettings(1)!.phase).toBe(1);
	});

	it('advances only when the proposal is accepted', () => {
		const proposal = m.phases.pendingProposal(1)!;
		m.phases.acceptProposal(1, proposal.id);
		expect(m.today.loadSettings(1)!.phase).toBe(2);
	});

	it('says which input is missing rather than reporting a false negative', () => {
		const verdict = m.phases.evaluateExit(1, m.today.loadSettings(1)!, TODAY);
		expect(verdict.state).toBe('unevaluable');
		expect(verdict.detail).toContain('debt table');
	});

	it('treats a downgrade as an ordinary move', () => {
		m.phases.setPhase(1, 1, TODAY);
		expect(m.today.loadSettings(1)!.phase).toBe(1);
		const row = m.sqlite
			.prepare('SELECT rationale FROM phase_change ORDER BY id DESC LIMIT 1')
			.get() as { rationale: string };
		expect(row.rationale).toBe('Moved down by hand');
	});
});

describe('the transfer checklist', () => {
	it('creates the allocations it can actually know, once', () => {
		const period = m.unsafeDb
			.select()
			.from(m.schema.period)
			.where(eq(m.schema.period.startsOn, '2026-08-16'))
			.get()!;

		m.allocations.ensureAllocations(1, period, TODAY);
		m.allocations.ensureAllocations(1, period, TODAY);

		const items = m.allocations.checklist(1, period, TODAY);
		// Keyed on accountId, not accountName. `name` is display data the user may
		// edit and migration 0013 renamed the defaults; `kind` and `id` are what
		// identify a bucket. A test that breaks when a label changes was testing
		// the wrong thing.
		const spendId = m.accounts.accountByKind(1, 'spend')!.id;
		const irregularsId = m.accounts.accountByKind(1, 'irregulars')!.id;
		expect(items.map((i) => i.accountId).sort()).toEqual([spendId, irregularsId].sort());
		expect(items.find((i) => i.accountId === spendId)!.amountMinor).toBe(420_000);
	});

	it('moves the asserted balance when a move is ticked off', () => {
		const period = m.unsafeDb
			.select()
			.from(m.schema.period)
			.where(eq(m.schema.period.startsOn, '2026-08-16'))
			.get()!;

		const spendItem = m.allocations
			.checklist(1, period, TODAY)
			.find((i) => i.accountId === m.accounts.accountByKind(1, 'spend')!.id)!;
		const before = m.accounts.accountByKind(1, 'spend')!.balanceMinor;

		m.allocations.executeAllocation(1, spendItem.id);
		expect(m.accounts.accountByKind(1, 'spend')!.balanceMinor).toBe(before + 420_000);

		// Ticking twice must not double the balance.
		m.allocations.executeAllocation(1, spendItem.id);
		expect(m.accounts.accountByKind(1, 'spend')!.balanceMinor).toBe(before + 420_000);
	});
});
