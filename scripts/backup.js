#!/usr/bin/env node
// Write a consistent backup now, and prune old ones.
//
//   node scripts/backup.js [--keep 14]
//
// The nightly job does this at 03:00. This is the manual handle, and the one
// you use before anything risky.

import Database from 'better-sqlite3';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBackup, listBackups } from '../src/lib/server/backup.ts';
import { localToday } from '../src/lib/server/clock.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DATABASE_URL ?? join(root, 'data', 'split.db');
const backupDir = join(dirname(dbPath), 'backups');

const keepArg = process.argv.indexOf('--keep');
const keep = keepArg === -1 ? 14 : Number(process.argv[keepArg + 1]);
if (!Number.isInteger(keep) || keep < 1) {
	console.error('--keep must be a positive integer');
	process.exit(1);
}

const db = new Database(dbPath);
const settings = db.prepare('SELECT timezone FROM settings WHERE id = 1').get();
const forDate = localToday(settings?.timezone ?? 'UTC');

let result;
try {
	result = runBackup(db, backupDir, forDate, keep);
} catch (err) {
	db.close();
	// SQLite's WAL mode needs shared memory to coordinate readers across
	// processes, and shared memory does not work over a virtualised bind mount
	// (macOS → Linux under Docker, network shares, some NAS setups). Where it
	// does not, a *second* process cannot read the live database at all — the
	// running server can, which is why the nightly in-process job still works.
	if (String(err.code ?? '').startsWith('SQLITE_IOERR') || err.code === 'SQLITE_BUSY') {
		console.error(
			`\nCannot back up while the server holds the database.\n\n` +
				`  ${err.code}: another process has ${dbPath} open and this filesystem does\n` +
				`  not support the shared memory WAL needs to coordinate them.\n\n` +
				`  Two ways forward, both fine:\n\n` +
				`    1. The nightly job already does this from inside the server process,\n` +
				`       where it works. Check: ls ${backupDir}\n\n` +
				`    2. To take one right now, stop the server and run this in a\n` +
				`       throwaway container — staying on one side of the mount avoids a\n` +
				`       race between the host releasing the file and the server reopening it:\n\n` +
				`         docker compose stop\n` +
				`         docker compose run --rm split node scripts/backup.js\n` +
				`         docker compose start\n`
		);
		process.exit(1);
	}
	throw err;
}
db.close();

console.log(`✓ ${result.path}  (${(result.bytes / 1024).toFixed(1)} kB)`);
if (result.pruned.length)
	console.log(`  pruned ${result.pruned.length}: ${result.pruned.join(', ')}`);
console.log(`\n${listBackups(backupDir).length} backups kept in ${backupDir}`);
console.log('Verify one with: node scripts/restore.js --list');
