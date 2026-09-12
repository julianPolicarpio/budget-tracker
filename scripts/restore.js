#!/usr/bin/env node
// Restore the database from a backup.
//
//   node scripts/restore.js --list
//   node scripts/restore.js --from split-2026-08-16.db
//   node scripts/restore.js --latest
//
// An untested backup is not a backup (Spec §12), which is why this path is
// exercised by the test suite and not only in an emergency. The current
// database is copied to <db>.pre-restore first — you are most likely to be
// panicking at exactly this moment, and destroying the damaged original
// destroys the evidence of whatever went wrong.
//
// Stop the server before restoring. A running process holds the old file open.

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { listBackups, restoreBackup } from '../src/lib/server/backup.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DATABASE_URL ?? join(root, 'data', 'split.db');
const backupDir = join(dirname(dbPath), 'backups');

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : (args[i + 1] ?? true);
};

const backups = listBackups(backupDir);

if (args.includes('--list') || args.length === 0) {
	if (backups.length === 0) {
		console.log(`No backups in ${backupDir}. Make one: node scripts/backup.js`);
		process.exit(0);
	}
	console.log(`${backups.length} backups in ${backupDir}:\n`);
	for (const b of backups) console.log(`  ${b.name}  (${(b.bytes / 1024).toFixed(1)} kB)`);
	console.log(`\nRestore with: node scripts/restore.js --from ${backups[0].name}`);
	process.exit(0);
}

const chosen = args.includes('--latest') ? backups[0]?.name : flag('--from');
if (typeof chosen !== 'string') {
	console.error('Pass --from <file> or --latest. See --list.');
	process.exit(1);
}

const backupPath = isAbsolute(chosen) ? chosen : join(backupDir, chosen);
const { safetyCopy } = restoreBackup(backupPath, dbPath);

// Prove the restored file is usable before claiming success.
const db = new Database(dbPath, { readonly: true });
const counts = {
	txn: db.prepare('SELECT count(*) AS n FROM txn').get().n,
	log_day: db.prepare('SELECT count(*) AS n FROM log_day').get().n,
	period: db.prepare('SELECT count(*) AS n FROM period').get().n,
	review: db.prepare('SELECT count(*) AS n FROM review').get().n
};
db.close();

console.log(`✓ restored ${chosen} → ${dbPath}`);
if (safetyCopy) console.log(`  previous database kept at ${safetyCopy}`);
console.log(
	'  ' +
		Object.entries(counts)
			.map(([k, v]) => `${k}: ${v}`)
			.join('  ·  ')
);
