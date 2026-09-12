/**
 * The two catch-up modes (Spec §4.6).
 *
 * These exist because the last defect in this area — a zero-day control the
 * desktop shell hid entirely — shipped only because nothing exercised the
 * paths that close a day. The distinction under test is not cosmetic: filing a
 * zero-spend night as a lossy catch-up records that detail was surrendered
 * when none was.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	page: typeof import('../../routes/+page.server');
	clock: typeof import('./clock');
};

let m: Mod;
const TZ = 'Asia/Manila';

/** Invoke a form action the way SvelteKit does, with just the bits it reads. */
async function invoke(action: string, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const actions = m.page.actions as Record<string, (e: unknown) => Promise<unknown>>;
	return actions[action]({
		request: new Request('http://localhost/', { method: 'POST', body })
	});
}

function logDay(date: string) {
	return m.sqlite.prepare(`SELECT * FROM log_day WHERE logged_on = ?`).get(date) as
		| { logged_on: string; entry_count: number; is_catchup: number }
		| undefined;
}

/** Reset to: the day before yesterday logged, yesterday missing, today open. */
function seedGap(today: string) {
	m.sqlite.exec(`DELETE FROM log_day; DELETE FROM txn;`);
	m.sqlite
		.prepare(`INSERT INTO log_day (logged_on, entry_count, is_catchup, closed_at) VALUES (?,1,0,?)`)
		.run(m.clock.addDays(today, -2), '2026-01-01T00:00:00.000Z');
}

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-catchup-')), 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	const migrations = resolve('migrations');
	for (const f of readdirSync(migrations)
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		dbMod.sqlite.exec(readFileSync(join(migrations, f), 'utf8'));
	}
	dbMod.sqlite.exec(
		`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
		                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
		                       timezone, created_at)
		 VALUES (1, 'PHP', '₱', 2, 1000, 'weekly', 0, 15, 10, 0, '${TZ}', '2026-01-01T00:00:00.000Z')`
	);

	m = { sqlite: dbMod.sqlite, page: await import('../../routes/+page.server'), clock: await import('./clock') };
});

describe('catch-up modes', () => {
	// The action reads the wall clock, so the fixture is built around it.
	const today = () => m.clock.localToday(TZ, new Date());

	it('files the lossy catch-up flagged, and closes today with it', async () => {
		const t = today();
		seedGap(t);

		await invoke('catchUp', { mode: 'catchup' });

		expect(logDay(m.clock.addDays(t, -1))?.is_catchup).toBe(1);
		// "One combined entry for both days" — today rides along.
		expect(logDay(t)).toBeDefined();
	});

	it('files a zero-spend day unflagged, and leaves today alone', async () => {
		const t = today();
		seedGap(t);

		await invoke('catchUp', { mode: 'nothing' });

		const filed = logDay(m.clock.addDays(t, -1));
		expect(filed?.entry_count).toBe(0);
		// Nothing was surrendered, so nothing is marked surrendered.
		expect(filed?.is_catchup).toBe(0);
		// Asserting yesterday cost nothing says nothing about today.
		expect(logDay(t)).toBeUndefined();
	});

	it('defaults to the lossy catch-up when no mode is sent', async () => {
		const t = today();
		seedGap(t);

		await invoke('catchUp', {});

		expect(logDay(m.clock.addDays(t, -1))?.is_catchup).toBe(1);
	});

	it('rejects an unknown mode without writing anything', async () => {
		const t = today();
		seedGap(t);

		const result = (await invoke('catchUp', { mode: 'backfill' })) as { status: number };

		expect(result.status).toBe(400);
		expect(logDay(m.clock.addDays(t, -1))).toBeUndefined();
	});

	it('refuses either mode beyond the single-day window — no backfill', async () => {
		const t = today();
		m.sqlite.exec(`DELETE FROM log_day; DELETE FROM txn;`);
		// A gap four days back, with nothing adjacent to make it forgivable.
		m.sqlite
			.prepare(
				`INSERT INTO log_day (logged_on, entry_count, is_catchup, closed_at) VALUES (?,1,0,?)`
			)
			.run(m.clock.addDays(t, -5), '2026-01-01T00:00:00.000Z');

		for (const mode of ['catchup', 'nothing']) {
			const result = (await invoke('catchUp', { mode })) as { status: number };
			expect(result.status).toBe(409);
		}
		expect(logDay(m.clock.addDays(t, -4))).toBeUndefined();
	});
});
