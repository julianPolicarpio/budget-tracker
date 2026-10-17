/**
 * scripts/serve.js must refuse a non-demo database BEFORE it creates
 * directories, opens the file or migrates it (I2): the built server's own
 * check runs too late to save a file serve.js has already migrated.
 *
 * The child gets a tmp database that has a real table and no demo marker, and
 * a tmp cwd. serve.js derives its live data dir from its own location (this
 * checkout's data/), which the guard only realpaths and stats; DATABASE_URL
 * never points there, so no process here opens the real database.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVE = resolve('scripts', 'serve.js');
const REAL_DATA = realpathSync.native(resolve('data'));

function tmpDbWithTables() {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'split-serve-guard-')));
	const db = join(dir, 'copy.db');
	const h = new Database(db);
	h.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, amount INTEGER)');
	h.exec('INSERT INTO ledger (amount) VALUES (12345)');
	h.close();
	return { dir, db };
}

function fingerprint(f: string) {
	const s = statSync(f);
	return {
		sha: createHash('sha256').update(readFileSync(f)).digest('hex'),
		size: s.size,
		mtimeMs: s.mtimeMs
	};
}

function runServe(cwd: string, extra: Record<string, string>) {
	// The test's own safety: never hand the child anything under the real data/.
	expect(realpathSync.native(extra.DATABASE_URL).startsWith(REAL_DATA)).toBe(false);
	return spawnSync(process.execPath, [SERVE], {
		cwd,
		encoding: 'utf8',
		timeout: 20_000,
		env: {
			PATH: process.env.PATH ?? '',
			HOME: process.env.HOME ?? '',
			HOST: '127.0.0.1',
			PORT: '0',
			SPLIT_DISABLE_JOBS: '1',
			...extra
		}
	});
}

describe('scripts/serve.js demo guard', () => {
	it('exits 1 on a database with tables and no demo marker, before any migration', () => {
		const { dir, db } = tmpDbWithTables();
		const before = fingerprint(db);
		const res = runServe(dir, { SPLIT_DEMO_MODE: '1', DATABASE_URL: db });
		expect(res.status).toBe(1);
		expect(res.stderr).toContain('Refusing to start the demo');
		expect(res.stdout).not.toContain('[migrate]');
		expect(res.stdout).not.toContain('[split] db');
		expect(fingerprint(db)).toEqual(before);
		// No backups/ directory, no journal: serve.js did nothing before refusing.
		expect(readdirSync(dir)).toEqual(['copy.db']);
	}, 30_000);

	it("exits 1 on SPLIT_DEMO_MODE='true' instead of starting as single-user", () => {
		const { dir, db } = tmpDbWithTables();
		const before = fingerprint(db);
		const res = runServe(dir, { SPLIT_DEMO_MODE: 'true', DATABASE_URL: db });
		expect(res.status).toBe(1);
		expect(res.stderr).toContain('SPLIT_DEMO_MODE');
		expect(res.stdout).not.toContain('[migrate]');
		expect(fingerprint(db)).toEqual(before);
		expect(readdirSync(dir)).toEqual(['copy.db']);
	}, 30_000);
});
