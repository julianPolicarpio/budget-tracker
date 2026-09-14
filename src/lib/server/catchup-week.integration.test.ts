/**
 * Catch-up that reaches a week (Spec §4.6, extended).
 *
 * The property that matters is not "you can log late" but "logging late is
 * visibly different from logging on the night". Finding 10: people
 * underestimate weekly spending by roughly 30%, so a reconstructed week that
 * reads as clean data is a review reporting fiction in a comfortable
 * direction.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

let m: {
	sqlite: import('better-sqlite3').Database;
	today: typeof import('./today');
};

const USER = 1;

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-catchup-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	// User 1 already exists: migration 0008 inserts the owner as part of
	// backfilling every pre-tenancy row to them.
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	m = { sqlite: dbMod.sqlite, today: await import('./today') };
});

const close = (d: string, isCatchup: boolean) =>
	m.sqlite
		.prepare(
			`INSERT INTO log_day (logged_on, entry_count, is_catchup, closed_at, user_id)
			 VALUES (?, 0, ?, 'x', ?) ON CONFLICT DO NOTHING`
		)
		.run(d, isCatchup ? 1 : 0, USER);

describe('missedDays reaches a week, not a day', () => {
	it('lists every unlogged day in the window, oldest first, excluding today', () => {
		const missed = m.today.missedDays(USER, '2026-09-14');
		expect(missed).toHaveLength(7);
		expect(missed[0]).toBe('2026-09-07');
		expect(missed[6]).toBe('2026-09-13');
		expect(missed).not.toContain('2026-09-14');
	});

	it('drops a day once it is closed, however it was closed', () => {
		close('2026-09-10', false);
		close('2026-09-11', true);
		const missed = m.today.missedDays(USER, '2026-09-14');
		expect(missed).not.toContain('2026-09-10');
		expect(missed).not.toContain('2026-09-11');
		expect(missed).toContain('2026-09-12');
	});

	it('never reaches past the window, so history does not reopen forever', () => {
		const missed = m.today.missedDays(USER, '2026-09-14');
		expect(missed.every((d) => d >= '2026-09-07')).toBe(true);
	});
});

describe('a missed day takes several purchases, not one', () => {
	it('splits a comma-separated line into one entry each', async () => {
		const entry = await import('./entry');
		const parts = 'kape 65, jeep 15'.split(',').map((t) => t.trim());
		const resolved = parts.map((t) => entry.resolveEntry(USER, t));

		expect(resolved).toHaveLength(2);
		expect(resolved.every((r) => r.kind === 'transaction')).toBe(true);
		// The second amount is the one the old single-parse path silently ate.
		const amounts = resolved.map((r) => (r as { amountMinor: number }).amountMinor);
		expect(amounts).toEqual([6500, 1500]);
	});

	it('parsing the whole line at once loses everything after the first amount', async () => {
		// The behaviour the split exists to avoid, asserted so nobody "simplifies"
		// the split away: one parse takes ₱65 and turns the rest into a word.
		const entry = await import('./entry');
		const whole = entry.resolveEntry(USER, 'kape 65, jeep 15');
		expect(whole.kind).not.toBe('transaction');
	});
});

describe('a reconstructed day is not a logged day', () => {
	it('counts them separately, which nothing did before', () => {
		const r = m.today.reconstructionRate(USER, '2026-09-08', '2026-09-14');
		// 09-10 closed honestly, 09-11 reconstructed.
		expect(r.reconstructed).toBe(1);
		expect(r.logged).toBe(1);
		expect(r.total).toBe(2);
	});

	it('treats an affirmed zero-spend day as logged, not reconstructed', () => {
		// "Nothing was spent that day" surrenders no detail, so it is not a
		// reconstruction — that distinction is the whole reason both buttons
		// exist rather than one.
		const r = m.today.reconstructionRate(USER, '2026-09-10', '2026-09-10');
		expect(r.reconstructed).toBe(0);
		expect(r.logged).toBe(1);
	});
});
