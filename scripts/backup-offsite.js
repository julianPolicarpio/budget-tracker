#!/usr/bin/env node
// An encrypted snapshot that leaves the machine.
//
//   SPLIT_BACKUP_PASSPHRASE=... node scripts/backup-offsite.js
//   SPLIT_BACKUP_PASSPHRASE=... node scripts/backup-offsite.js --to /Volumes/backup
//
// ── Why this exists separately from the nightly backup ───────────────────
//
// `runBackup()` already writes a consistent copy every night, using
// VACUUM INTO, into `data/backups/`. That is the right thing and it is not a
// backup. It sits on the same disk as the database it is protecting, so it
// survives a bad migration and nothing else — not a lost VPS, not a dead
// volume, not a provider closing an account.
//
// It also now holds OTHER PEOPLE'S financial history (spec §3.5). A copy of
// that on a cheap VPS with no encryption at rest is a thing you have to think
// about before it leaks, not afterwards.
//
// ── What it does, and what it deliberately does not ──────────────────────
//
// Produces one AES-256 encrypted file, named for the date, and stops. It does
// NOT ship it anywhere, because the transport depends on infrastructure that
// does not exist yet and guessing would mean writing an S3 client for a bucket
// nobody has created. Pipe the output wherever it belongs:
//
//   scp  "$(node scripts/backup-offsite.js --quiet)" you@elsewhere:/backups/
//   rclone copy "$(...)" remote:split-backups/
//
// ── On the crypto ────────────────────────────────────────────────────────
//
// openssl, via the system binary, with PBKDF2 key derivation. No dependency,
// present on both macOS and Debian, and a format anyone can decrypt in twenty
// years without this repo:
//
//   openssl enc -d -aes-256-cbc -pbkdf2 -in split-2026-09-14.db.enc -out split.db
//
// A backup you cannot decrypt without a specific version of a specific tool is
// a backup that fails exactly when you need it. This one needs openssl and a
// passphrase, and nothing else.

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DATABASE_URL ?? join(root, 'data', 'split.db');

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const toIdx = args.indexOf('--to');
const outDir = toIdx >= 0 && args[toIdx + 1] ? args[toIdx + 1] : join(root, 'data', 'offsite');

const passphrase = process.env.SPLIT_BACKUP_PASSPHRASE;
if (!passphrase) {
	console.error(
		'\nRefusing to run.\n\n' +
			'  SPLIT_BACKUP_PASSPHRASE is not set. This snapshot contains real financial\n' +
			'  history — and, on a deployed instance, other people’s. Writing it\n' +
			'  unencrypted to somewhere off the machine is the one thing this script\n' +
			'  exists to avoid.\n\n' +
			'  Store the passphrase somewhere that is NOT this server. A passphrase kept\n' +
			'  beside the thing it protects protects nothing.\n'
	);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const date = new Date().toISOString().slice(0, 10);
const plain = join(outDir, `split-${date}.db`);
const enc = join(outDir, `split-${date}.db.enc`);

// VACUUM INTO, not a file copy. The database runs in WAL mode, so `cp` catches
// the main file without the write-ahead log and silently loses recent writes.
// This is the same call runBackup() makes, for the same reason.
const db = new Database(dbPath, { readonly: true });
try {
	rmSync(plain, { force: true });
	db.prepare('VACUUM INTO ?').run(plain);
} finally {
	db.close();
}

try {
	execFileSync(
		'openssl',
		['enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-in', plain, '-out', enc, '-pass', 'stdin'],
		{ input: passphrase }
	);
} finally {
	// The unencrypted snapshot never outlives this process, even on failure.
	rmSync(plain, { force: true });
}

if (quiet) {
	console.log(enc);
} else {
	console.log(`[offsite] ${enc} · ${statSync(enc).size} bytes`);
	console.log('[offsite] now move it off this machine. A backup on the same disk is not one.');
}
