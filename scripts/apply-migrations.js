// The one migration runner, shared by `scripts/migrate.js` and
// `scripts/serve.js`.
//
// These two had separate copies of this loop. That was survivable while the
// loop was six obvious lines, and stopped being survivable the moment it grew
// the foreign-key handling below: two copies of subtle logic drift, and the
// copy that drifts is the one that runs on the server at 3am.
//
// ── Why foreign keys are OFF while a migration runs ──────────────────────
//
// SQLite cannot drop or alter a CHECK or UNIQUE constraint in place. Changing
// one means the twelve-step rebuild: create a new table, copy, drop the old,
// rename. That recipe requires foreign key enforcement to be OFF, because the
// DROP would otherwise fire cascades or fail against rows that are about to be
// re-pointed at the replacement table.
//
// `PRAGMA foreign_keys` is a no-op inside a transaction, so it cannot be set
// from within a migration file — it has to happen out here, around the
// transaction. `defer_foreign_keys` is not a substitute either: it moves the
// check to COMMIT but leaves the prepare-time restrictions in place, including
// the one that forbids ADD COLUMN with both a REFERENCES clause and a non-NULL
// default.
//
// ── Why the check is run out here too ────────────────────────────────────
//
// A migration file can contain `PRAGMA foreign_key_check;` and it will do
// nothing useful: exec() discards result rows, so the violations it reports are
// thrown away. The check is only worth anything if someone reads the answer and
// refuses to continue. That is this function's job.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {import('better-sqlite3').Database} Db */

/**
 * Apply every unapplied .sql file in `migrationsDir`, in filename order,
 * exactly once each.
 *
 * One transaction per migration: a half-applied schema is worse than none.
 * After each commit the database is checked for orphaned references, and a
 * violation is fatal — a migration that silently orphans rows is how a
 * tenancy bug ships.
 *
 * @param {Db} db
 * @param {string} migrationsDir
 * @param {(file: string) => void} [log]
 * @returns {number} how many migrations were applied
 */
export function applyMigrations(db, migrationsDir, log = () => {}) {
	db.exec(`CREATE TABLE IF NOT EXISTS _migration (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`);

	const rows = /** @type {{ name: string }[]} */ (db.prepare('SELECT name FROM _migration').all());
	const applied = new Set(rows.map((r) => r.name));

	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();

	const pending = files.filter((f) => !applied.has(f));
	if (pending.length === 0) return 0;

	// Remember what the caller had, and restore it whatever happens below.
	const had = db.pragma('foreign_keys', { simple: true });
	db.pragma('foreign_keys = OFF');

	try {
		for (const file of pending) {
			const sql = readFileSync(join(migrationsDir, file), 'utf8');

			db.exec('BEGIN');
			try {
				db.exec(sql);
				db.prepare('INSERT INTO _migration (name, applied_at) VALUES (?, ?)').run(
					file,
					new Date().toISOString()
				);
				db.exec('COMMIT');
			} catch (err) {
				db.exec('ROLLBACK');
				throw new Error(
					`${file} failed, nothing was applied: ${err instanceof Error ? err.message : String(err)}`
				);
			}

			// Committed, but not yet trusted.
			const violations = /** @type {{table: string, rowid: number, parent: string}[]} */ (
				db.pragma('foreign_key_check')
			);
			if (violations.length > 0) {
				const where = violations
					.slice(0, 5)
					.map((v) => `${v.table}.rowid=${v.rowid} -> ${v.parent}`)
					.join(', ');
				throw new Error(
					`${file} applied but left ${violations.length} orphaned reference(s): ${where}. ` +
						`The schema is committed and inconsistent — restore from a backup.`
				);
			}

			log(file);
		}
	} finally {
		db.pragma(`foreign_keys = ${had ? 'ON' : 'OFF'}`);
	}

	return pending.length;
}
