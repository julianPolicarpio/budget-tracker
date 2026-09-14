/**
 * The off-site snapshot (Spec §3.5).
 *
 * `runBackup()` already writes nightly into `data/backups/`, which is the right
 * thing and is not a backup: it sits on the disk it is protecting. On a
 * deployed instance it also holds other people's financial history, so the copy
 * that leaves the machine has to be encrypted before it goes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

const SCRIPT = resolve('scripts/backup-offsite.js');

function seedDb(dir: string): string {
	const p = join(dir, 'split.db');
	const db = new Database(p);
	db.exec(`CREATE TABLE txn (id INTEGER PRIMARY KEY, amount_minor INTEGER)`);
	db.prepare(`INSERT INTO txn (amount_minor) VALUES (6500)`).run();
	db.close();
	return p;
}

describe('the off-site snapshot', () => {
	it('refuses to run without a passphrase rather than writing plaintext', () => {
		const dir = mkdtempSync(join(tmpdir(), 'split-offsite-'));
		const dbPath = seedDb(dir);

		expect(() =>
			execFileSync('node', [SCRIPT, '--to', join(dir, 'out')], {
				env: { ...process.env, DATABASE_URL: dbPath, SPLIT_BACKUP_PASSPHRASE: '' },
				stdio: 'pipe'
			})
		).toThrow();

		expect(existsSync(join(dir, 'out'))).toBe(false);
	});

	it('encrypts, leaves no plaintext behind, and round-trips', () => {
		const dir = mkdtempSync(join(tmpdir(), 'split-offsite-'));
		const dbPath = seedDb(dir);
		const out = join(dir, 'out');

		execFileSync('node', [SCRIPT, '--to', out, '--quiet'], {
			env: { ...process.env, DATABASE_URL: dbPath, SPLIT_BACKUP_PASSPHRASE: 'correct horse' },
			stdio: 'pipe'
		});

		const files = readdirSync(out);
		// The unencrypted snapshot must not outlive the process, even briefly.
		expect(files.every((f) => f.endsWith('.enc'))).toBe(true);
		expect(files).toHaveLength(1);

		const restored = join(dir, 'restored.db');
		execFileSync('openssl', [
			'enc',
			'-d',
			'-aes-256-cbc',
			'-pbkdf2',
			'-in',
			join(out, files[0]),
			'-out',
			restored,
			'-pass',
			'pass:correct horse'
		]);

		const db = new Database(restored, { readonly: true });
		const row = db.prepare(`SELECT amount_minor AS a FROM txn`).get() as { a: number };
		db.close();
		expect(row.a).toBe(6500);
	});

	it('cannot be decrypted with the wrong passphrase', () => {
		const dir = mkdtempSync(join(tmpdir(), 'split-offsite-'));
		const dbPath = seedDb(dir);
		const out = join(dir, 'out');

		execFileSync('node', [SCRIPT, '--to', out, '--quiet'], {
			env: { ...process.env, DATABASE_URL: dbPath, SPLIT_BACKUP_PASSPHRASE: 'right' },
			stdio: 'pipe'
		});
		const file = join(out, readdirSync(out)[0]);

		expect(() =>
			execFileSync(
				'openssl',
				['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-in', file, '-out', join(dir, 'x.db'), '-pass', 'pass:wrong'],
				{ stdio: 'pipe' }
			)
		).toThrow();
	});
});
