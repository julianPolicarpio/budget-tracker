#!/usr/bin/env node
// Opens a period — the one manual step Phase 1 keeps out of the UI.
//
//   node scripts/open-period.js --alloc 4200 --days 7
//   node scripts/open-period.js --alloc 4200 --start 2026-08-17 --end 2026-08-23
//   node scripts/open-period.js --alloc 3900 --days 7 --supersede
//
// --alloc is the SPEND allocation for the whole period, in major units
// (₱4200), hand-entered per Spec §13 Phase 1. The daily number is derived from
// it once, here, and frozen. Nothing else in the app may write it (Spec §12).
//
// Periods are immutable. Changing a split mid-period does not edit the row —
// --supersede closes the current one and links a replacement via supersedes_id.

import Database from 'better-sqlite3';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailyAllowance, displayBand } from '../src/lib/allowance.ts';
import { parseMoney, formatMoney } from '../src/lib/money.ts';
import { addDays, daysBetweenInclusive, localToday } from '../src/lib/server/clock.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DATABASE_URL ?? join(root, 'data', 'split.db');

const args = parseArgs(process.argv.slice(2));
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
if (!settings) {
	console.error('No settings row. Run: node scripts/init.js');
	process.exit(1);
}

if (!args.alloc) {
	console.error('--alloc is required (the Spend allocation for the whole period)');
	process.exit(1);
}

const spendAllocMinor = parseMoney(String(args.alloc), settings.minor_units);
if (spendAllocMinor === null || spendAllocMinor <= 0) {
	console.error(`--alloc "${args.alloc}" is not a positive amount`);
	process.exit(1);
}

const startsOn = args.start ?? localToday(settings.timezone);
if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) {
	console.error(`--start must be YYYY-MM-DD (got "${startsOn}")`);
	process.exit(1);
}

let endsOn;
if (args.end) {
	endsOn = args.end;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) {
		console.error(`--end must be YYYY-MM-DD (got "${endsOn}")`);
		process.exit(1);
	}
} else {
	const days = args.days ? Number(args.days) : defaultDays(settings.period_kind);
	if (!Number.isInteger(days) || days <= 0) {
		console.error(`--days must be a positive integer (got "${args.days}")`);
		process.exit(1);
	}
	endsOn = addDays(startsOn, days - 1);
}

const days = daysBetweenInclusive(startsOn, endsOn);
if (days <= 0) {
	console.error('--end is before --start');
	process.exit(1);
}

const existing = db
	.prepare(
		`SELECT * FROM period
		 WHERE closed_at IS NULL AND NOT (ends_on < ? OR starts_on > ?)
		 ORDER BY id DESC`
	)
	.all(startsOn, endsOn);

if (existing.length && !args.supersede) {
	const p = existing[0];
	console.error(
		`Period #${p.id} (${p.starts_on} → ${p.ends_on}) is open and overlaps this range.\n` +
			`Periods are immutable — pass --supersede to close it and link a replacement.`
	);
	process.exit(1);
}

const allowance = dailyAllowance({ spendAllocMinor, days }, settings.haircut_pct);
const band = displayBand(allowance, {
	bandPct: settings.band_pct,
	roundingStep: settings.rounding_step
});

const now = new Date().toISOString();
const supersedesId = args.supersede && existing.length ? existing[0].id : null;

const insert = db.transaction(() => {
	if (supersedesId !== null) {
		for (const p of existing)
			db.prepare('UPDATE period SET closed_at = ? WHERE id = ?').run(now, p.id);
	}
	return db
		.prepare(
			`INSERT INTO period (starts_on, ends_on, days, spend_alloc_minor,
			                     daily_allowance_minor, haircut_pct_applied,
			                     phase_at_open, supersedes_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			startsOn,
			endsOn,
			days,
			spendAllocMinor,
			allowance,
			settings.haircut_pct,
			settings.phase,
			supersedesId,
			now
		).lastInsertRowid;
});

const id = insert();
const money = (m) =>
	formatMoney(m, { minorUnits: settings.minor_units, symbol: settings.currency_symbol });

console.log(`period #${id}${supersedesId ? ` (supersedes #${supersedesId})` : ''}`);
console.log(`  ${startsOn} → ${endsOn}  (${days} days)`);
console.log(`  spend allocation   ${money(spendAllocMinor)}`);
console.log(`  haircut applied    ${settings.haircut_pct}%`);
console.log(`  daily allowance    ${money(allowance)}   (frozen)`);
console.log(`  displayed band     ${money(band.low)} – ${money(band.high)}`);
db.close();

function defaultDays(kind) {
	return kind === 'weekly' ? 7 : kind === 'semimonthly' ? 15 : 30;
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		out[key] = next && !next.startsWith('--') ? (i++, next) : true;
	}
	return out;
}
