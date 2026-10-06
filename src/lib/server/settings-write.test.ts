/**
 * Settings writes, and the invariant they must not break: changing a setting
 * never rewrites an open period. Invariant 6 — periods are immutable, and
 * daily_allowance_minor is written only when a period is created.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

let m: { sqlite: import('better-sqlite3').Database; mod: typeof import('./settings-write') };
const USER = 1;

const VALID = {
	timezone: 'Asia/Manila',
	currencyCode: 'PHP',
	currencySymbol: '₱',
	minorUnits: 2,
	roundingStep: 1000,
	periodKind: 'weekly' as const,
	weekStartsOn: 0,
	haircutPct: 25,
	bandPct: 10
};

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-settings-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));
	m = { sqlite: dbMod.sqlite, mod: await import('./settings-write') };
});

beforeEach(() => {
	m.sqlite.prepare(`DELETE FROM period WHERE user_id = ?`).run(USER);
	m.sqlite
		.prepare(
			`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor,
			 daily_allowance_minor, haircut_pct_applied, phase_at_open, created_at, user_id)
			 VALUES ('2026-09-13','2026-09-19',7,700000,85000,15,0,'x',?)`
		)
		.run(USER);

	// applyMigrations alone leaves `settings` empty — it is populated at
	// runtime by provisionUser(), not by a migration (same gap setup.test.ts
	// documents). Re-seeded every test so each starts from the same state.
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

it('changing the haircut leaves the open period untouched', () => {
	m.mod.updateSettings(USER, { ...VALID, haircutPct: 25 });

	const p = m.sqlite.prepare(`SELECT * FROM period WHERE user_id = ?`).get(USER) as any;
	expect(p.daily_allowance_minor).toBe(85000);
	expect(p.haircut_pct_applied).toBe(15);

	const s = m.sqlite.prepare(`SELECT * FROM settings WHERE user_id = ?`).get(USER) as any;
	expect(s.haircut_pct).toBe(25);
});

it('rejects percentages outside 0–100', () => {
	expect(() => m.mod.updateSettings(USER, { ...VALID, haircutPct: 140 })).toThrow(/haircut/i);
});

it('rejects a bandPct outside 0–100', () => {
	expect(() => m.mod.updateSettings(USER, { ...VALID, bandPct: -1 })).toThrow(/band/i);
});

it('rejects a minorUnits outside 0–4', () => {
	expect(() => m.mod.updateSettings(USER, { ...VALID, minorUnits: 5 })).toThrow(/minor/i);
	expect(() => m.mod.updateSettings(USER, { ...VALID, minorUnits: -1 })).toThrow(/minor/i);
});

it('rejects a non-integer or sub-1 roundingStep', () => {
	expect(() => m.mod.updateSettings(USER, { ...VALID, roundingStep: 0 })).toThrow(/rounding/i);
	expect(() => m.mod.updateSettings(USER, { ...VALID, roundingStep: 1.5 })).toThrow(/rounding/i);
});

it('rejects a weekStartsOn outside 0–6', () => {
	expect(() => m.mod.updateSettings(USER, { ...VALID, weekStartsOn: 7 })).toThrow(/week/i);
});

it('rejects an unknown periodKind', () => {
	expect(() =>
		m.mod.updateSettings(USER, { ...VALID, periodKind: 'yearly' as never })
	).toThrow(/period/i);
});

it('rejects an empty timezone or currency code', () => {
	expect(() => m.mod.updateSettings(USER, { ...VALID, timezone: '  ' })).toThrow(/timezone/i);
	expect(() => m.mod.updateSettings(USER, { ...VALID, currencyCode: '' })).toThrow(/currency/i);
});

it('accepts a valid patch and writes every field', () => {
	m.mod.updateSettings(USER, { ...VALID, timezone: 'Europe/Lisbon', currencyCode: 'EUR' });
	const s = m.sqlite.prepare(`SELECT * FROM settings WHERE user_id = ?`).get(USER) as any;
	expect(s.timezone).toBe('Europe/Lisbon');
	expect(s.currency_code).toBe('EUR');
	expect(s.band_pct).toBe(10);
});
