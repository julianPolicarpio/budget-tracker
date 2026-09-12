#!/usr/bin/env node
// Creates the single settings row. Idempotent: re-running updates in place.
//
//   node scripts/init.js --currency PHP --symbol ₱ --tz Asia/Manila \
//                        --period weekly --haircut 15 --band 10 --step 1000 \
//                        --take-home 6000

import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMoney, formatMoney } from '../src/lib/money.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DATABASE_URL ?? join(root, 'data', 'split.db');

const args = parseArgs(process.argv.slice(2));

const cfg = {
	currency_code: args.currency ?? 'PHP',
	currency_symbol: args.symbol ?? '₱',
	minor_units: int(args.minorUnits, 2),
	rounding_step: int(args.step, 1000),
	period_kind: args.period ?? 'weekly',
	week_starts_on: int(args.weekStart, 0),
	haircut_pct: int(args.haircut, 15),
	band_pct: int(args.band, 10),
	phase: int(args.phase, 0),
	timezone: args.tz ?? 'Asia/Manila'
};

if (!['weekly', 'semimonthly', 'monthly'].includes(cfg.period_kind)) {
	console.error(`--period must be weekly | semimonthly | monthly (got "${cfg.period_kind}")`);
	process.exit(1);
}
try {
	new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone });
} catch {
	console.error(`--tz "${cfg.timezone}" is not a valid IANA timezone`);
	process.exit(1);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

db.prepare(
	`INSERT INTO settings (id, currency_code, currency_symbol, minor_units, rounding_step,
	                       period_kind, week_starts_on, haircut_pct, band_pct, phase,
	                       timezone, created_at)
	 VALUES (1, @currency_code, @currency_symbol, @minor_units, @rounding_step,
	         @period_kind, @week_starts_on, @haircut_pct, @band_pct, @phase,
	         @timezone, @created_at)
	 ON CONFLICT(id) DO UPDATE SET
	   currency_code = excluded.currency_code,
	   currency_symbol = excluded.currency_symbol,
	   minor_units = excluded.minor_units,
	   rounding_step = excluded.rounding_step,
	   period_kind = excluded.period_kind,
	   week_starts_on = excluded.week_starts_on,
	   haircut_pct = excluded.haircut_pct,
	   band_pct = excluded.band_pct,
	   phase = excluded.phase,
	   timezone = excluded.timezone`
).run({ ...cfg, created_at: new Date().toISOString() });

// Weekly take-home, asserted once, for bufferWeeks() (F14 — the first
// milestone is six weeks of take-home, not six months). Only written when
// given, so re-running init to change the currency does not erase it.
// Phase 3 replaces this with the MIN of the last three months of real income.
let takeHomeMinor = null;
if (args.takeHome !== undefined) {
	takeHomeMinor = parseMoney(String(args.takeHome), cfg.minor_units);
	if (takeHomeMinor === null || takeHomeMinor <= 0) {
		console.error(`--take-home "${args.takeHome}" is not a positive amount`);
		process.exit(1);
	}
	db.prepare('UPDATE settings SET weekly_take_home_minor = ? WHERE id = 1').run(takeHomeMinor);
}

console.log('settings:');
for (const [k, v] of Object.entries(cfg)) console.log(`  ${k.padEnd(16)} ${v}`);

const stored = db.prepare('SELECT weekly_take_home_minor AS m FROM settings WHERE id = 1').get();
console.log(
	`  ${'weekly take-home'.padEnd(16)} ` +
		(stored?.m
			? formatMoney(stored.m, { minorUnits: cfg.minor_units, symbol: cfg.currency_symbol })
			: 'not set — buffer weeks stays blank until --take-home')
);
console.log(`\nNext: node scripts/open-period.js --alloc <amount> --days 7`);
db.close();

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) continue;
		const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		const next = argv[i + 1];
		out[key] = next && !next.startsWith('--') ? (i++, next) : 'true';
	}
	return out;
}

function int(v, fallback) {
	if (v === undefined) return fallback;
	const n = Number(v);
	if (!Number.isInteger(n)) {
		console.error(`expected an integer, got "${v}"`);
		process.exit(1);
	}
	return n;
}
