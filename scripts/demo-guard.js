// The demo guard: a public demo instance must be unable to open the owner's
// real database, under any misconfiguration.
//
// Shared by `scripts/serve.js` (which runs it before it creates a directory,
// opens a file or migrates anything) and `src/lib/server/auth.ts` (the only
// check under `vite dev`). Plain ESM with no imports from src, for the same
// reason `apply-migrations.js` is: one copy of a security rule, usable from
// both sides.
//
// ── Why a positive check, not a path check ──────────────────────────────
//
// The first version refused paths inside data/. Every path rule failed open
// somewhere: a data dir derived from the wrong cwd, a plain copy of split.db,
// a hard link to a backup, a case variant on APFS. A path says where a file
// is, not what it holds. So the decision is made on the contents: a database
// is accepted only if it is empty (nothing has been written to it yet) or it
// carries the `demo_instance` marker that only this guard writes, and only
// into a database it has just found empty. The owner's database is neither,
// wherever it is and whatever it is called. The path checks stay as defence
// in depth, and because they refuse without opening anything.
//
// ── What reading a refused file costs ───────────────────────────────────
//
// The contents check opens the file read-only. A rollback-journal database is
// left exactly as it was, with nothing created beside it. A WAL-mode database
// cannot be read without its -wal and -shm, so SQLite creates them (an empty
// -wal, an index -shm) if they are missing and leaves them. No page of the
// database is written. That is the one side effect, and it only happens to a
// file that already got past every path check.

import Database from 'better-sqlite3';
import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	statSync
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const MARKER_TABLE = 'demo_instance';

const PREFIX = 'Refusing to start the demo:';

/**
 * Every refusal. `reason` names the check that fired, so tests (and logs) can
 * tell a path refusal from a contents refusal.
 *
 * @typedef {'bad-demo-flag' | 'missing-path' | 'inside-live-data-dir'
 *   | 'resolves-into-live-data-dir' | 'unresolvable-link' | 'same-file-as-live-db'
 *   | 'not-sqlite' | 'unreadable' | 'not-a-demo-database'} DemoGuardReason
 */
export class DemoGuardError extends Error {
	/**
	 * @param {DemoGuardReason} reason
	 * @param {string} detail
	 */
	constructor(reason, detail) {
		super(`${PREFIX} ${detail}`);
		this.name = 'DemoGuardError';
		/** @type {DemoGuardReason} */
		this.reason = reason;
	}
}

/**
 * Is this a demo instance? Exactly '1' is yes; unset, '' or '0' is no.
 * Anything else ('true', 'yes', '1 ') throws: a typo must not quietly start
 * the owner's single-user mode behind a public tunnel.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function demoModeEnabled(env) {
	const v = env.SPLIT_DEMO_MODE;
	if (v === '1') return true;
	if (v === undefined || v === '' || v === '0') return false;
	throw new DemoGuardError(
		'bad-demo-flag',
		`SPLIT_DEMO_MODE must be exactly "1" (demo) or unset/"0" (not demo). Got ${JSON.stringify(v)}.`
	);
}

/**
 * Does anything exist at p, counting a dangling symlink as something?
 * @param {string} p
 */
function lexists(p) {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Canonical spelling of p: symlinks resolved on the deepest existing
 * ancestor, and that ancestor's case taken from disk. `realpathSync.native`,
 * because the JS realpathSync keeps the caller's case on a case-insensitive
 * volume, so 'DATA' would not compare equal to 'data'.
 *
 * @param {string} p
 */
function canonical(p) {
	let dir = resolve(p);
	const tail = [];
	while (!lexists(dir) && dirname(dir) !== dir) {
		tail.unshift(basename(dir));
		dir = dirname(dir);
	}
	return join(realpathSync.native(dir), ...tail);
}

/**
 * @param {string} p
 * @param {string} root
 */
function within(p, root) {
	return p === root || p.startsWith(root + sep);
}

/**
 * Is the file empty, a demo database, or something else?
 * Read-only throughout; see the header for the one WAL side effect.
 *
 * @param {string} file
 * @param {string} shown
 * @returns {'empty' | 'demo'}
 */
function inspect(file, shown) {
	// A zero-byte file is an empty database: SQLite treats it as one, and
	// there is nothing to read.
	if (statSync(file).size === 0) return 'empty';

	const header = Buffer.alloc(16);
	const fd = openSync(file, 'r');
	try {
		readSync(fd, header, 0, 16, 0);
	} finally {
		closeSync(fd);
	}
	if (header.toString('latin1') !== 'SQLite format 3\0') {
		throw new DemoGuardError('not-sqlite', `DATABASE_URL (${shown}) is not a SQLite database.`);
	}

	let db;
	try {
		db = new Database(file, { readonly: true, fileMustExist: true });
		const rows = /** @type {{ name: string, type: string }[]} */ (
			db.prepare('SELECT name, type FROM sqlite_master').all()
		);
		if (rows.length === 0) return 'empty';
		if (rows.some((r) => r.type === 'table' && r.name === MARKER_TABLE)) return 'demo';
	} catch (err) {
		throw new DemoGuardError(
			'unreadable',
			`DATABASE_URL (${shown}) could not be read to confirm it is a demo database: ` +
				`${err instanceof Error ? err.message : String(err)}`
		);
	} finally {
		db?.close();
	}
	throw new DemoGuardError(
		'not-a-demo-database',
		`DATABASE_URL (${shown}) is not a demo database. It already holds tables and has no ` +
			`${MARKER_TABLE} marker, so it may be real data. Point DATABASE_URL at a new or ` +
			`empty file outside the data directory.`
	);
}

/**
 * Write the marker, re-checking under the write lock so a file swapped in
 * between the read-only look and this open is refused rather than marked.
 *
 * @param {string} file
 * @param {string} shown
 */
function mark(file, shown) {
	mkdirSync(dirname(file), { recursive: true });
	const db = new Database(file);
	try {
		db.exec('BEGIN IMMEDIATE');
		try {
			const rows = /** @type {{ name: string, type: string }[]} */ (
				db.prepare('SELECT name, type FROM sqlite_master').all()
			);
			const marked = rows.some((r) => r.type === 'table' && r.name === MARKER_TABLE);
			if (!marked && rows.length > 0) {
				throw new DemoGuardError(
					'not-a-demo-database',
					`DATABASE_URL (${shown}) gained tables while it was being checked.`
				);
			}
			if (!marked) {
				db.exec(`CREATE TABLE ${MARKER_TABLE} (created_at TEXT NOT NULL)`);
				db.prepare(`INSERT INTO ${MARKER_TABLE} (created_at) VALUES (?)`).run(
					new Date().toISOString()
				);
			}
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
	} finally {
		db.close();
	}
}

/**
 * Refuse to run the demo against anything but a demo database.
 *
 * Path checks first (they refuse without opening anything), then the contents
 * check, then, only if both pass, the one write: the `demo_instance` marker.
 * Throws DemoGuardError; never exits the process itself.
 *
 * @param {string | undefined} dbPath DATABASE_URL, resolved against
 *   process.cwd() exactly as better-sqlite3 resolves it.
 * @param {string} liveDataDir the checkout's data/ directory.
 */
export function assertDemoDatabase(dbPath, liveDataDir) {
	const shown = dbPath ?? '';
	if (!dbPath || !dbPath.trim()) {
		throw new DemoGuardError('missing-path', 'DATABASE_URL must point at the demo database.');
	}
	const file = resolve(process.cwd(), dbPath);
	const live = canonical(liveDataDir);

	// (b) Path defence. The directory first: it covers a file that does not
	// exist yet, a symlinked directory and a case variant.
	if (within(canonical(dirname(file)), live)) {
		throw new DemoGuardError(
			'inside-live-data-dir',
			`DATABASE_URL (${shown}) is inside ${live}, where the real database lives.`
		);
	}

	const exists = lexists(file);
	if (exists) {
		// The file itself may be a symlink, which the directory cannot show.
		// A dangling one is refused: opening it would create its target.
		let real;
		try {
			real = realpathSync.native(file);
		} catch {
			throw new DemoGuardError(
				'unresolvable-link',
				`DATABASE_URL (${shown}) is a link that does not resolve to an existing file.`
			);
		}
		if (within(real, live)) {
			throw new DemoGuardError(
				'resolves-into-live-data-dir',
				`DATABASE_URL (${shown}) resolves to ${real}, inside ${live}.`
			);
		}
		// A hard link has no path to resolve; the inode is the only tell.
		const liveFile = join(live, 'split.db');
		if (lexists(liveFile)) {
			const a = statSync(real);
			const b = statSync(liveFile);
			if (a.dev === b.dev && a.ino === b.ino) {
				throw new DemoGuardError(
					'same-file-as-live-db',
					`DATABASE_URL (${shown}) is the same file as ${liveFile}.`
				);
			}
		}
	}

	// (c) The real guard: empty, or already a demo database.
	const state = exists ? inspect(file, shown) : 'empty';

	// (d) The only write, and only after (b) and (c).
	if (state === 'empty') mark(file, shown);
}
