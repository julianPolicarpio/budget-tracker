/**
 * Backup (Spec §12, data-loss row).
 *
 * One SQLite file on a machine in your home is one power supply away from
 * losing your financial history. `VACUUM INTO` writes a consistent copy while
 * the database stays open, which a file copy of a WAL database does not.
 *
 * **An untested backup is not a backup.** `restoreBackup()` exists so the
 * restore path is exercised by the test suite rather than discovered during an
 * actual loss — Spec §12 is explicit that Phase 2 tests the restore, not the
 * backup.
 */

import type BetterSqlite3 from 'better-sqlite3';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const BACKUP_PREFIX = 'split-';
const BACKUP_SUFFIX = '.db';

export interface BackupResult {
	path: string;
	bytes: number;
	pruned: string[];
}

/**
 * Write a consistent copy to `dir` named for the local date, then prune.
 * Re-running on the same date overwrites — the job is idempotent by date, so a
 * double tick is harmless (Spec §3).
 */
export function runBackup(
	db: BetterSqlite3.Database,
	dir: string,
	forDate: string,
	keep = 14
): BackupResult {
	mkdirSync(dir, { recursive: true });

	const path = join(dir, `${BACKUP_PREFIX}${forDate}${BACKUP_SUFFIX}`);
	// VACUUM INTO refuses to overwrite, so clear a same-day copy first.
	if (existsSync(path)) rmSync(path);

	db.prepare('VACUUM INTO ?').run(path);

	return { path, bytes: statSync(path).size, pruned: pruneBackups(dir, keep) };
}

/** Keep the newest `keep` backups by filename, which is by date. */
export function pruneBackups(dir: string, keep: number): string[] {
	if (!existsSync(dir)) return [];

	const files = readdirSync(dir)
		.filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
		.sort()
		.reverse();

	const doomed = files.slice(keep);
	for (const f of doomed) rmSync(join(dir, f));
	return doomed;
}

/**
 * Replace the live database with a backup.
 *
 * The current file is copied aside first. Restoring is the moment you are most
 * likely to be panicking, and losing the damaged original removes the evidence
 * of whatever went wrong.
 */
export function restoreBackup(backupPath: string, livePath: string): { safetyCopy: string | null } {
	if (!existsSync(backupPath)) throw new Error(`No backup at ${backupPath}`);

	// Verify it opens and carries the schema before overwriting anything.
	const probe = new Database(backupPath, { readonly: true });
	try {
		const tables = probe
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'txn'`)
			.all();
		if (tables.length === 0) throw new Error(`${basename(backupPath)} is not a Split database`);
	} finally {
		probe.close();
	}

	let safetyCopy: string | null = null;
	if (existsSync(livePath)) {
		safetyCopy = `${livePath}.pre-restore`;
		copyFileSync(livePath, safetyCopy);
	}

	copyFileSync(backupPath, livePath);
	// WAL and SHM belong to the replaced file; leaving them strands writes.
	for (const sidecar of ['-wal', '-shm']) {
		const p = `${livePath}${sidecar}`;
		if (existsSync(p)) rmSync(p);
	}

	return { safetyCopy };
}

export function listBackups(dir: string): { name: string; bytes: number }[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
		.sort()
		.reverse()
		.map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
}
