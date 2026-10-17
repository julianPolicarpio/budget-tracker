/**
 * The demo guard: a public demo must be unable to open the owner's real
 * database, whatever the working directory, path spelling or link trickery.
 *
 * Every test builds its own fake checkout in mkdtemp, with a fake
 * data/split.db holding a real table. Nothing here touches the repo's data/.
 * scripts/demo-guard.js imports nothing from src, so importing it statically
 * cannot open any database.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	DemoGuardError,
	assertDemoDatabase,
	demoModeEnabled
} from '../../../scripts/demo-guard.js';

/** A fake checkout: repo/data/split.db and repo/data/backups/x.db, both with data. */
function fakeRepo() {
	const dir = mkdtempSync(join(tmpdir(), 'split-guard-'));
	const repo = join(dir, 'repo');
	const data = join(repo, 'data');
	mkdirSync(join(data, 'backups'), { recursive: true });
	const live = join(data, 'split.db');
	const backup = join(data, 'backups', 'x.db');
	for (const f of [live, backup]) {
		const db = new Database(f);
		db.exec('CREATE TABLE txn (id INTEGER PRIMARY KEY, amount INTEGER)');
		db.exec('INSERT INTO txn (amount) VALUES (12345)');
		db.close();
	}
	const outside = join(dir, 'elsewhere');
	mkdirSync(outside);
	return { dir, repo, data, live, backup, outside };
}

/** Bytes plus mtime: proof a refused file was not written. */
function fingerprint(f: string) {
	const s = statSync(f);
	return {
		sha: createHash('sha256').update(readFileSync(f)).digest('hex'),
		size: s.size,
		mtimeMs: s.mtimeMs
	};
}

function listing(dir: string) {
	return readdirSync(dir).sort();
}

function markerRows(f: string): number {
	const db = new Database(f, { readonly: true, fileMustExist: true });
	try {
		return (db.prepare('SELECT count(*) AS n FROM demo_instance').get() as { n: number }).n;
	} finally {
		db.close();
	}
}

/** Refused, by the check named, with the shared prefix. */
function expectRefusal(fn: () => unknown, reason: string) {
	let caught: unknown;
	try {
		fn();
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(DemoGuardError);
	const err = caught as DemoGuardError;
	expect(err.reason).toBe(reason);
	expect(err.message.startsWith('Refusing to start the demo:')).toBe(true);
}

describe('demoModeEnabled', () => {
	it("is on only for exactly '1'", () => {
		expect(demoModeEnabled({ SPLIT_DEMO_MODE: '1' })).toBe(true);
	});

	it("is off for unset, '' and '0'", () => {
		expect(demoModeEnabled({})).toBe(false);
		expect(demoModeEnabled({ SPLIT_DEMO_MODE: undefined })).toBe(false);
		expect(demoModeEnabled({ SPLIT_DEMO_MODE: '' })).toBe(false);
		expect(demoModeEnabled({ SPLIT_DEMO_MODE: '0' })).toBe(false);
	});

	it('throws on anything else instead of quietly falling through to single-user', () => {
		for (const v of ['true', 'yes', '1 ', ' 1', 'TRUE', '2']) {
			let caught: unknown;
			try {
				demoModeEnabled({ SPLIT_DEMO_MODE: v });
			} catch (err) {
				caught = err;
			}
			expect(caught, `SPLIT_DEMO_MODE=${JSON.stringify(v)}`).toBeInstanceOf(DemoGuardError);
			expect((caught as DemoGuardError).reason).toBe('bad-demo-flag');
			expect((caught as Error).message).toContain('SPLIT_DEMO_MODE');
		}
	});
});

describe('assertDemoDatabase: accepted', () => {
	it('a fresh path outside data/ is created and marked as a demo database', () => {
		const r = fakeRepo();
		const db = join(r.outside, 'new', 'demo.db');
		assertDemoDatabase(db, r.data);
		expect(existsSync(db)).toBe(true);
		expect(markerRows(db)).toBe(1);
	});

	it('an existing empty file is accepted and marked; the next start accepts the marker', () => {
		const r = fakeRepo();
		const db = join(r.outside, 'empty.db');
		writeFileSync(db, '');
		assertDemoDatabase(db, r.data);
		expect(markerRows(db)).toBe(1);
		// Second start: the marker is there, so nothing is added.
		assertDemoDatabase(db, r.data);
		expect(markerRows(db)).toBe(1);
	});

	it('a marked demo database that has since been migrated is still accepted', () => {
		const r = fakeRepo();
		const db = join(r.outside, 'demo.db');
		assertDemoDatabase(db, r.data);
		const h = new Database(db);
		h.pragma('journal_mode = WAL');
		h.exec('CREATE TABLE txn (id INTEGER PRIMARY KEY)');
		h.close();
		assertDemoDatabase(db, r.data);
		expect(markerRows(db)).toBe(1);
	});
});

describe('assertDemoDatabase: the positive check (a database is a demo database or it is refused)', () => {
	it('refuses a copy of the live database outside data/, and leaves it untouched', () => {
		const r = fakeRepo();
		const copy = join(r.outside, 'copy.db');
		copyFileSync(r.live, copy);
		const before = fingerprint(copy);
		const files = listing(r.outside);
		expectRefusal(() => assertDemoDatabase(copy, r.data), 'not-a-demo-database');
		expect(fingerprint(copy)).toEqual(before);
		// Rollback-journal file: a read-only open leaves nothing behind.
		expect(listing(r.outside)).toEqual(files);
	});

	it('refuses a WAL-mode copy without changing its bytes', () => {
		const r = fakeRepo();
		const copy = join(r.outside, 'wal.db');
		const h = new Database(copy);
		h.pragma('journal_mode = WAL');
		h.exec('CREATE TABLE txn (id INTEGER PRIMARY KEY)');
		h.close();
		const before = fingerprint(copy);
		expectRefusal(() => assertDemoDatabase(copy, r.data), 'not-a-demo-database');
		expect(fingerprint(copy)).toEqual(before);
		// SQLite may create an empty -wal and a -shm to read a WAL file; the
		// -wal must stay empty, i.e. no page was written.
		const wal = copy + '-wal';
		if (existsSync(wal)) expect(statSync(wal).size).toBe(0);
	});

	it('refuses a hard link to a backup, which no path or inode check against split.db can see', () => {
		const r = fakeRepo();
		const hard = join(r.outside, 'hard.db');
		linkSync(r.backup, hard);
		const before = fingerprint(r.backup);
		expectRefusal(() => assertDemoDatabase(hard, r.data), 'not-a-demo-database');
		expect(fingerprint(r.backup)).toEqual(before);
	});

	it('refuses the live file by absolute path when liveDataDir came from the wrong cwd (C1)', () => {
		const r = fakeRepo();
		// A launchd job with no WorkingDirectory runs from "/", so a cwd-derived
		// data dir points nowhere near the real one. The path checks cannot fire.
		const wrongDataDir = join(r.outside, 'data');
		const before = fingerprint(r.live);
		// The live-looking name check fires first now; the contents check below
		// covers a renamed copy, which no name check can see.
		expectRefusal(() => assertDemoDatabase(r.live, wrongDataDir), 'live-looking-path');
		const renamed = join(r.outside, 'renamed.db');
		copyFileSync(r.live, renamed);
		expectRefusal(() => assertDemoDatabase(renamed, wrongDataDir), 'not-a-demo-database');
		expect(fingerprint(r.live)).toEqual(before);
	});

	it('refuses a file that is not a SQLite database at all', () => {
		const r = fakeRepo();
		const junk = join(r.outside, 'junk.db');
		writeFileSync(junk, 'not a database');
		expectRefusal(() => assertDemoDatabase(junk, r.data), 'not-sqlite');
		expect(readFileSync(junk, 'utf8')).toBe('not a database');
	});
});

describe('assertDemoDatabase: path defence in depth', () => {
	it('refuses an unset or blank DATABASE_URL', () => {
		const r = fakeRepo();
		expectRefusal(() => assertDemoDatabase(undefined, r.data), 'missing-path');
		expectRefusal(() => assertDemoDatabase('  ', r.data), 'missing-path');
	});

	it('refuses the live file by absolute path when liveDataDir is right', () => {
		const r = fakeRepo();
		const before = fingerprint(r.live);
		expectRefusal(() => assertDemoDatabase(r.live, r.data), 'inside-live-data-dir');
		expect(fingerprint(r.live)).toEqual(before);
	});

	it('refuses a new file inside data/, and does not create it', () => {
		const r = fakeRepo();
		const db = join(r.data, 'demo.db');
		expectRefusal(() => assertDemoDatabase(db, r.data), 'inside-live-data-dir');
		expect(existsSync(db)).toBe(false);
	});

	it("refuses 'DATA/demo.db' on a case-insensitive volume (realpath.native, not realpath)", () => {
		const r = fakeRepo();
		const variant = join(r.repo, 'DATA');
		// This Mac's APFS is case-insensitive; on a case-sensitive volume the
		// variant is a different directory and nothing is being tested.
		expect(existsSync(variant)).toBe(true);
		expectRefusal(
			() => assertDemoDatabase(join(variant, 'demo.db'), r.data),
			'inside-live-data-dir'
		);
		expect(listing(r.data)).toEqual(['backups', 'split.db']);
	});

	it('refuses a new file under a symlinked directory that points into data/', () => {
		const r = fakeRepo();
		const link = join(r.outside, 'sneaky');
		symlinkSync(r.data, link);
		expectRefusal(() => assertDemoDatabase(join(link, 'demo.db'), r.data), 'inside-live-data-dir');
		expect(listing(r.data)).toEqual(['backups', 'split.db']);
	});

	it('refuses a file symlink outside data/ that points at the live file', () => {
		const r = fakeRepo();
		const link = join(r.outside, 'sym.db');
		symlinkSync(r.live, link);
		expectRefusal(() => assertDemoDatabase(link, r.data), 'resolves-into-live-data-dir');
	});

	it('refuses a dangling symlink into data/, and does not create its target', () => {
		const r = fakeRepo();
		const link = join(r.outside, 'dangling.db');
		symlinkSync(join(r.data, 'would-be.db'), link);
		expectRefusal(() => assertDemoDatabase(link, r.data), 'unresolvable-link');
		expect(listing(r.data)).toEqual(['backups', 'split.db']);
	});

	it('refuses a hard link outside data/ to the live file by inode', () => {
		const r = fakeRepo();
		const hard = join(r.outside, 'hard-live.db');
		linkSync(r.live, hard);
		expectRefusal(() => assertDemoDatabase(hard, r.data), 'same-file-as-live-db');
	});
});

describe('assertDemoDatabase: live-looking paths (a second checkout of the repo)', () => {
	it('refuses a missing split.db in another checkout, and does not create it', () => {
		const r = fakeRepo();
		const other = join(r.dir, 'second-checkout', 'data');
		mkdirSync(other, { recursive: true });
		const db = join(other, 'split.db');
		expectRefusal(() => assertDemoDatabase(db, r.data), 'live-looking-path');
		expect(existsSync(db)).toBe(false);
	});

	it('refuses a 0-byte SPLIT.DB, whatever its case', () => {
		const r = fakeRepo();
		const db = join(r.outside, 'SPLIT.DB');
		writeFileSync(db, '');
		expectRefusal(() => assertDemoDatabase(db, r.data), 'live-looking-path');
		expect(statSync(db).size).toBe(0);
	});

	it('refuses any name in a directory whose backups/ holds split-*.db files', () => {
		const r = fakeRepo();
		const dir = join(r.outside, 'looks-live');
		mkdirSync(join(dir, 'backups'), { recursive: true });
		writeFileSync(join(dir, 'backups', 'split-2026-10-01.db'), 'backup');
		expectRefusal(() => assertDemoDatabase(join(dir, 'demo.db'), r.data), 'live-looking-path');
		expect(listing(dir)).toEqual(['backups']);
	});

	it('still accepts a directory whose backups/ holds no split-*.db file', () => {
		const r = fakeRepo();
		const dir = join(r.outside, 'demo-home');
		mkdirSync(join(dir, 'backups'), { recursive: true });
		writeFileSync(join(dir, 'backups', 'notes.txt'), 'x');
		assertDemoDatabase(join(dir, 'demo.db'), r.data);
		expect(markerRows(join(dir, 'demo.db'))).toBe(1);
	});
});

describe('assertDemoDatabase: a 0-byte file is empty only without a live journal beside it', () => {
	for (const suffix of ['-wal', '-journal']) {
		it(`refuses a 0-byte file with a non-empty ${suffix}, and leaves the ${suffix} untouched`, () => {
			const r = fakeRepo();
			const db = join(r.outside, `orphan${suffix}.db`);
			writeFileSync(db, '');
			const side = db + suffix;
			writeFileSync(side, Buffer.alloc(4096, 7));
			const before = fingerprint(side);
			expectRefusal(() => assertDemoDatabase(db, r.data), 'unreadable');
			expect(fingerprint(side)).toEqual(before);
			expect(statSync(db).size).toBe(0);
		});
	}

	it('still accepts a 0-byte file whose -wal is also empty', () => {
		const r = fakeRepo();
		const db = join(r.outside, 'empty-wal.db');
		writeFileSync(db, '');
		writeFileSync(db + '-wal', '');
		assertDemoDatabase(db, r.data);
		expect(markerRows(db)).toBe(1);
	});
});
