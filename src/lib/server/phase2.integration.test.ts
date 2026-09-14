/**
 * Phase 2 against a real SQLite file: migrations, rollover, supersession, the
 * review artefact, and — the one Spec §12 is explicit about — a tested
 * *restore*. An untested backup is not a backup.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { weekOf } from './week';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	unsafeDb: typeof import('./db').unsafeDb;
	sqlite: typeof import('./db').sqlite;
	schema: typeof import('./db').schema;
	rollover: typeof import('./rollover');
	review: typeof import('./review');
	metrics: typeof import('./metrics');
	backup: typeof import('./backup');
	jobs: typeof import('./jobs');
	today: typeof import('./today');
};

let m: Mod;
let dir: string;

const TZ = 'Asia/Manila';

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'split-test-'));
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
		rollover: await import('./rollover'),
		review: await import('./review'),
		metrics: await import('./metrics'),
		backup: await import('./backup'),
		jobs: await import('./jobs'),
		today: await import('./today')
	};

	m.sqlite
		.prepare(
			`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
			                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
			                       timezone, weekly_take_home_minor, created_at)
			 VALUES (1,'PHP','₱',2,1000,'weekly',0,15,10,1,?,600000,'2026-08-01T00:00:00Z')`
		)
		.run(TZ);
});

function insertPeriod(startsOn: string, endsOn: string, days: number, allocMinor: number) {
	const allowance = Math.round((allocMinor * 85) / (100 * days));
	return Number(
		m.sqlite
			.prepare(
				`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor,
				                     daily_allowance_minor, haircut_pct_applied, phase_at_open, created_at)
				 VALUES (?,?,?,?,?,15,1,'2026-08-01T00:00:00Z')`
			)
			.run(startsOn, endsOn, days, allocMinor, allowance).lastInsertRowid
	);
}

function insertTxn(
	spentOn: string,
	minor: number,
	category: string,
	planned: 0 | 1,
	periodId: number | null
) {
	m.sqlite
		.prepare(
			`INSERT INTO txn (spent_on, amount_minor, category, planned, period_id, entered_at)
			 VALUES (?,?,?,?,?,?)`
		)
		.run(spentOn, minor, category, planned, periodId, `${spentOn}T21:30:00Z`);
}

// ─────────────────────────────────────────────────────────────────────────
describe('rollover', () => {
	it('closes a finished period, records the sweep, and opens the next', () => {
		const id = insertPeriod('2026-08-02', '2026-08-08', 7, 420_000);
		insertTxn('2026-08-03', 50_000, 'food_out', 0, id);
		insertTxn('2026-08-05', 70_000, 'transport', 1, id);
		// Logging a transaction alone does not close the day — closeLogDay()
		// does that as a separate, explicit step (Spec §4.6). Without it the
		// period has no log_day row and would now read as a gap (Spec §4.1).
		for (const d of ['2026-08-03', '2026-08-05']) {
			m.sqlite
				.prepare(
					`INSERT INTO log_day (logged_on, entry_count, is_catchup, closed_at) VALUES (?,1,0,?)`
				)
				.run(d, `${d}T21:30:00Z`);
		}

		const settings = m.today.loadSettings(1)!;
		const result = m.rollover.runRollover(1, '2026-08-09', settings);

		expect(result.closed).toEqual([{ id, sweptMinor: 300_000 }]);

		const closed = m.sqlite.prepare('SELECT * FROM period WHERE id = ?').get(id) as any;
		expect(closed.closed_at).not.toBeNull();
		expect(closed.is_gap).toBe(0);
		// The immutable fields are untouched — rollover records, never rewrites.
		expect(closed.spend_alloc_minor).toBe(420_000);
		expect(closed.daily_allowance_minor).toBe(51_000);

		expect(result.opened).toHaveLength(1);
		const next = m.sqlite
			.prepare('SELECT * FROM period WHERE id = ?')
			.get(result.opened[0].id) as any;
		expect(next.starts_on).toBe('2026-08-09');
		expect(next.ends_on).toBe('2026-08-15');
		expect(next.days).toBe(7);
		expect(next.spend_alloc_minor).toBe(420_000);
	});

	it('never sweeps a negative surplus when the period was overspent', () => {
		const id = insertPeriod('2026-06-01', '2026-06-07', 7, 100_000);
		insertTxn('2026-06-02', 250_000, 'stuff', 0, id);
		const p = m.unsafeDb.select().from(m.schema.period).where(eq(m.schema.period.id, id)).get()!;
		expect(m.rollover.closePeriod(1, p).sweptMinor).toBe(0);
	});

	it('catches up several missed weeks in one run without leaving gaps', () => {
		const settings = m.today.loadSettings(1)!;
		m.rollover.runRollover(1, '2026-09-06', settings);

		const rows = m.sqlite
			.prepare(
				`SELECT starts_on, ends_on FROM period WHERE starts_on >= '2026-08-09' ORDER BY starts_on`
			)
			.all() as { starts_on: string; ends_on: string }[];

		for (let i = 1; i < rows.length; i++) {
			const prevEnd = new Date(rows[i - 1].ends_on + 'T00:00:00Z').getTime();
			const thisStart = new Date(rows[i].starts_on + 'T00:00:00Z').getTime();
			expect(thisStart - prevEnd).toBe(86_400_000);
		}
		expect(m.rollover.openPeriodOn(1, '2026-09-06')).not.toBeNull();
	});

	it('is idempotent — a second run for the same day changes nothing', () => {
		const settings = m.today.loadSettings(1)!;
		const before = m.sqlite.prepare('SELECT count(*) AS n FROM period').get() as { n: number };
		const result = m.rollover.runRollover(1, '2026-09-06', settings);
		const after = m.sqlite.prepare('SELECT count(*) AS n FROM period').get() as { n: number };

		expect(result.closed).toHaveLength(0);
		expect(result.opened).toHaveLength(0);
		expect(after.n).toBe(before.n);
	});

	// Spec §4.1: the owner's periods 3–5 swept full allocations because
	// nothing was logged, not because nothing was spent. A missing record
	// must never read as a good week.
	describe('gap periods (Spec §4.1)', () => {
		it('sweeps zero and flags is_gap when no day in range was logged', () => {
			const id = insertPeriod('2025-01-06', '2025-01-12', 7, 500_000);
			const p = m.unsafeDb.select().from(m.schema.period).where(eq(m.schema.period.id, id)).get()!;

			const result = m.rollover.closePeriod(1, p);

			expect(result.sweptMinor).toBe(0);
			const closed = m.sqlite.prepare('SELECT * FROM period WHERE id = ?').get(id) as any;
			expect(closed.swept_minor).toBe(0);
			expect(closed.is_gap).toBe(1);
		});

		it('sweeps normally and leaves is_gap 0 when a real day was logged', () => {
			const id = insertPeriod('2025-02-03', '2025-02-09', 7, 500_000);
			insertTxn('2025-02-04', 100_000, 'food_out', 0, id);
			m.sqlite
				.prepare(
					`INSERT INTO log_day (logged_on, entry_count, is_catchup, closed_at) VALUES (?,1,0,?)`
				)
				.run('2025-02-04', '2025-02-04T21:00:00Z');
			const p = m.unsafeDb.select().from(m.schema.period).where(eq(m.schema.period.id, id)).get()!;

			const result = m.rollover.closePeriod(1, p);

			expect(result.sweptMinor).toBe(400_000);
			const closed = m.sqlite.prepare('SELECT * FROM period WHERE id = ?').get(id) as any;
			expect(closed.is_gap).toBe(0);
		});

		it('a catch-up row saying "nothing was spent" is data, not a gap', () => {
			const id = insertPeriod('2025-03-03', '2025-03-09', 7, 500_000);
			m.sqlite
				.prepare(
					`INSERT INTO log_day (logged_on, entry_count, is_catchup, closed_at) VALUES (?,0,1,?)`
				)
				.run('2025-03-04', '2025-03-04T21:00:00Z');
			const p = m.unsafeDb.select().from(m.schema.period).where(eq(m.schema.period.id, id)).get()!;

			const result = m.rollover.closePeriod(1, p);

			// Nothing was spent, so the whole allocation still sweeps — but as an
			// affirmed zero-spend week, not as missing data.
			expect(result.sweptMinor).toBe(500_000);
			const closed = m.sqlite.prepare('SELECT * FROM period WHERE id = ?').get(id) as any;
			expect(closed.is_gap).toBe(0);
		});
	});
});

describe('supersession', () => {
	it('leaves the superseded row monetarily byte-identical', () => {
		const settings = m.today.loadSettings(1)!;
		const current = m.rollover.openPeriodOn(1, '2026-09-06')!;
		const before = m.sqlite.prepare('SELECT * FROM period WHERE id = ?').get(current.id) as any;

		const next = m.rollover.supersedePeriod(1, current, 390_000, settings);
		const after = m.sqlite.prepare('SELECT * FROM period WHERE id = ?').get(current.id) as any;

		expect(after.spend_alloc_minor).toBe(before.spend_alloc_minor);
		expect(after.daily_allowance_minor).toBe(before.daily_allowance_minor);
		expect(after.days).toBe(before.days);
		expect(after.closed_at).not.toBeNull();

		expect(next.supersedesId).toBe(current.id);
		expect(next.spendAllocMinor).toBe(390_000);
		expect(next.startsOn).toBe(current.startsOn);
		expect(next.endsOn).toBe(current.endsOn);
		// Same window, new allocation → a genuinely different daily number.
		expect(next.dailyAllowanceMinor).not.toBe(before.daily_allowance_minor);
	});
});

// The review week is derived, never hand-written: with week_starts_on = Sunday
// the week around 5 May 2026 runs 3–9 May, and guessing it is how an off-by-one
// gets baked into a test and then into the artefact.
const WEEK = weekOf('2026-05-05', 0);

describe('metrics', () => {
	const range = { from: WEEK.startsOn, to: WEEK.endsOn };

	beforeAll(() => {
		insertTxn('2026-05-04', 30_000, 'food_out', 0, null);
		insertTxn('2026-05-05', 10_000, 'food_out', 1, null);
		insertTxn('2026-05-06', 60_000, 'stuff', 0, null);
		// Outside the window on both sides — must not be counted.
		insertTxn('2026-05-02', 99_000, 'social', 0, null);
		insertTxn('2026-05-10', 99_000, 'social', 0, null);

		for (const d of ['2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07']) {
			m.sqlite
				.prepare(
					`INSERT INTO log_day (logged_on, entry_count, is_catchup, closed_at) VALUES (?,1,0,?)`
				)
				.run(d, `${d}T22:00:00Z`);
		}
	});

	it('totals only what falls inside the window', () => {
		const a = m.metrics.weekActuals(1, range);
		expect(a.totalMinor).toBe(100_000);
		expect(a.unplannedMinor).toBe(90_000);
		expect(a.unplannedRatioBp).toBe(9000);
	});

	it('sorts categories by magnitude, descending', () => {
		const a = m.metrics.weekActuals(1, range);
		const nonZero = a.byCategory.filter((c) => c.minor > 0);
		expect(nonZero.map((c) => c.key)).toEqual(['stuff', 'food_out']);
	});

	it('returns null rather than zero when nothing was spent', () => {
		expect(
			m.metrics.weekActuals(1, { from: '2020-01-01', to: '2020-01-07' }).unplannedRatioBp
		).toBeNull();
	});

	it('ranks the top three by amount', () => {
		const top = m.metrics.topThree(1, range);
		expect(top.map((t) => t.amountMinor)).toEqual([60_000, 30_000, 10_000]);
		expect(top[0].label).toBe('Stuff');
	});

	it('computes adherence as logged days over elapsed days', () => {
		expect(m.metrics.logAdherenceBp(1, range)).toBe(Math.round((5 * 10_000) / 7));
	});

	it('leaves buffer weeks null until take-home is asserted', () => {
		expect(m.metrics.bufferWeeksX100(1_800_000, 600_000)).toBe(300);
		expect(m.metrics.bufferWeeksX100(1_800_000, null)).toBeNull();
		expect(m.metrics.bufferWeeksX100(null, 600_000)).toBeNull();
	});
});

describe('the review flow (Spec §5.10, §5.11)', () => {
	it('leaves balances out of the weekly flow while the figures are fresh', () => {
		m.sqlite.prepare(`UPDATE account SET balance_as_of = ? WHERE user_id = 1`).run('2026-08-20');
		const steps = m.review.stepsFor(m.review.balanceIsStale(1, '2026-08-22'));
		expect(steps.map((s) => s.key)).toEqual([
			'actuals',
			'top_three',
			'week_ahead',
			'adjust',
			'send'
		]);
	});

	it('brings balances back as step 5 of 6 once they go stale, never as step 1', () => {
		m.sqlite.prepare(`UPDATE account SET balance_as_of = ? WHERE user_id = 1`).run('2026-06-01');
		const steps = m.review.stepsFor(m.review.balanceIsStale(1, '2026-08-22'));
		expect(steps).toHaveLength(6);
		// Last but one: the Finish snapshot reads these figures, so it cannot
		// precede them — and step one is where the owner stopped, twice.
		expect(steps[4].key).toBe('balances');
		expect(steps[5].key).toBe('send');
		expect(steps[0].key).not.toBe('balances');
	});

	it('treats a never-asserted balance as stale', () => {
		const before = m.sqlite
			.prepare(`SELECT id, balance_as_of FROM account WHERE user_id = 1`)
			.all() as { id: number; balance_as_of: string | null }[];

		m.sqlite.prepare(`UPDATE account SET balance_as_of = NULL WHERE user_id = 1`).run();
		expect(m.review.balanceIsStale(1, '2026-08-22')).toBe(true);

		const put = m.sqlite.prepare(`UPDATE account SET balance_as_of = ? WHERE id = ?`);
		for (const r of before) put.run(r.balance_as_of, r.id);
	});

	it('trends only completed reviews, oldest first, and never invents a zero', () => {
		// Its own tenant: deleting user 1's reviews to make room would leak into
		// every later test in this file, which is how a suite starts depending on
		// the order it happens to run in.
		m.sqlite.prepare(`INSERT INTO app_user (id, created_at) VALUES (77, 'x')`).run();
		const ins = m.sqlite.prepare(
			`INSERT INTO review (kind, period_label, starts_on, ends_on, completed_at,
			   total_spent_minor, unplanned_ratio_bp, created_at, user_id)
			 VALUES ('weekly', ?, ?, ?, ?, ?, ?, 'x', 77)`
		);
		ins.run('2026-W30', '2026-07-20', '2026-07-26', 'done', 50_000, 4000);
		ins.run('2026-W31', '2026-07-27', '2026-08-02', 'done', 40_000, 3000);
		// In progress: null metrics. A gap in a trend is honest; a zero is a lie.
		ins.run('2026-W32', '2026-08-03', '2026-08-09', null, null, null);

		const trend = m.review.weeklyTrend(77, 12);
		expect(trend.map((t) => t.label)).toEqual(['2026-W30', '2026-W31']);
		expect(trend[0].unplannedRatioBp).toBe(4000);

		m.sqlite.prepare(`DELETE FROM app_user WHERE id = 77`).run();
	});
});

describe('the weekly artefact', () => {
	it('creates once, resumes, and never duplicates a label', () => {
		const a = m.review.ensureWeeklyReview(1, WEEK);
		const b = m.review.ensureWeeklyReview(1, WEEK);
		expect(b.id).toBe(a.id);
		expect(a.completedAt).toBeNull();
	});

	it('persists partial completion so the wizard is resumable', () => {
		const r = m.review.ensureWeeklyReview(1, WEEK);
		m.review.saveStep(1, r.id, 'balances', { spendBalanceMinor: 1 });
		m.review.saveStep(1, r.id, 'actuals', { seen: true });
		expect(Object.keys(m.review.stepPayloads(1, r.id)).sort()).toEqual(['actuals', 'balances']);
	});

	it('snapshots the metrics and writes the one-liner', () => {
		const settings = m.today.loadSettings(1)!;
		let r = m.review.ensureWeeklyReview(1, WEEK);

		m.review.saveBalances(1, r.id, {
			spendBalanceMinor: 120_000,
			irregularsMinor: 800_000,
			bufferMinor: 1_800_000,
			debtTotalMinor: 0
		});
		r = m.review.reviewByLabel(1, WEEK.label)!;

		const done = m.review.completeReview(1, r, settings);

		expect(done.completedAt).not.toBeNull();
		expect(done.totalSpentMinor).toBe(100_000);
		expect(done.unplannedRatioBp).toBe(9000);
		expect(done.bufferWeeksX100).toBe(300);
		// Not faked: these need Phase 3's subsystems.
		expect(done.coverageRatioBp).toBeNull();
		expect(done.saveRateBp).toBeNull();

		expect(done.summaryLine).toBe(
			'Week 18: spent ₱1,000 · unplanned 90% · buffer 3.0 weeks · streak 0'
		);
	});

	it('records the share, which is the free half of the intervention', () => {
		const r = m.review.reviewByLabel(1, WEEK.label)!;
		expect(r.sharedAt).toBeNull();
		m.review.markShared(1, r.id);
		expect(m.review.reviewByLabel(1, WEEK.label)!.sharedAt).not.toBeNull();
	});

	it('stops reporting a review as due once it is complete', () => {
		// On Sunday 10 May the last complete week is 3–9 May.
		const r = m.review.reviewByLabel(1, WEEK.label)!;
		expect(r.completedAt).not.toBeNull();
		expect(m.review.weeklyReviewDue(1, '2026-05-10', 0)).toBeNull();
	});
});

describe('backup and restore', () => {
	it('round-trips the database through a backup', () => {
		const backupDir = join(dir, 'backups');
		const before = m.sqlite.prepare('SELECT count(*) AS n FROM txn').get() as { n: number };

		const result = m.backup.runBackup(m.sqlite, backupDir, '2026-08-16');
		expect(result.bytes).toBeGreaterThan(0);

		const live = join(dir, 'restored.db');
		m.backup.restoreBackup(result.path, live);

		const restored = new Database(live, { readonly: true });
		try {
			expect((restored.prepare('SELECT count(*) AS n FROM txn').get() as any).n).toBe(before.n);
			expect((restored.prepare('SELECT count(*) AS n FROM review').get() as any).n).toBe(1);
			expect(
				(
					restored
						.prepare(`SELECT summary_line AS s FROM review WHERE period_label = ?`)
						.get(WEEK.label) as any
				).s
			).toContain('Week 18');
		} finally {
			restored.close();
		}
	});

	it('keeps the damaged original when it overwrites', () => {
		const backupDir = join(dir, 'backups');
		const result = m.backup.runBackup(m.sqlite, backupDir, '2026-08-17');

		const live = join(dir, 'live2.db');
		writeFileSync(live, 'not a database');
		const { safetyCopy } = m.backup.restoreBackup(result.path, live);

		expect(safetyCopy).not.toBeNull();
		expect(readFileSync(safetyCopy!, 'utf8')).toBe('not a database');
	});

	it('refuses a file that is not a Split database', () => {
		const junk = join(dir, 'junk.db');
		new Database(junk).close();
		expect(() => m.backup.restoreBackup(junk, join(dir, 'live3.db'))).toThrow(
			/not a Split database/
		);
	});

	it('prunes to the retention limit, newest first', () => {
		const backupDir = join(dir, 'prune');
		for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
			m.backup.runBackup(m.sqlite, backupDir, d, 10);
		}
		const pruned = m.backup.pruneBackups(backupDir, 2);
		expect(pruned.sort()).toEqual(['split-2026-01-01.db', 'split-2026-01-02.db']);
		expect(m.backup.listBackups(backupDir).map((b) => b.name)).toEqual([
			'split-2026-01-04.db',
			'split-2026-01-03.db'
		]);
	});
});

describe('job idempotency', () => {
	it('runs once per local date and skips a repeat tick', () => {
		const at = new Date('2026-10-01T18:30:00Z'); // 02:30 on the 2nd in Manila
		expect(m.jobs.runJob('backup', at)).not.toBeNull();
		expect(m.jobs.runJob('backup', at)).toBeNull();

		const rows = m.sqlite.prepare(`SELECT ran_for FROM job_run WHERE job_key = 'backup'`).all() as {
			ran_for: string;
		}[];
		expect(rows).toHaveLength(1);
		// Keyed on the *local* date, not UTC — otherwise a 02:00 job in UTC+8
		// records the previous day and fires twice.
		expect(rows[0].ran_for).toBe('2026-10-02');
	});
});
