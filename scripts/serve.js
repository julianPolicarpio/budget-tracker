#!/usr/bin/env node
/**
 * Production entry point: migrate, check the bind, then serve.
 *
 * Migrations run here rather than in an entrypoint script so that a container
 * that starts is a container whose schema is current — there is no window
 * where the app is up against an old database.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from './apply-migrations.js';
import { assertDemoDatabase, demoModeEnabled } from './demo-guard.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DATABASE_URL ?? join(root, 'data', 'split.db');

// ─── The demo guard, before anything touches the database ────────────────
//
// The built server checks demo mode too, but only once it is imported at the
// bottom of this file, after the migrations below have already opened and
// written to DATABASE_URL. So the check runs here first. The live data dir
// comes from this file's location, never from the cwd, which is "/" under a
// launchd job with no WorkingDirectory. demoModeEnabled() runs even when the
// demo is off, so SPLIT_DEMO_MODE=true exits instead of starting single-user.
try {
	// DATABASE_URL, not dbPath: with it unset, dbPath falls back to the real
	// database, and the refusal should say "unset", not "inside data/".
	if (demoModeEnabled(process.env)) assertDemoDatabase(process.env.DATABASE_URL, join(root, 'data'));
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}

// ─── The bind address, and what replaced it ───────────────────────────────
//
// This used to refuse any public bind outright, because network isolation WAS
// the auth boundary: there was no login, so whatever reached the port read the
// whole financial history. That was invariant 10 and it was correct.
//
// Going multi-user reversed it (spec §2.3). Authorisation is now application
// code — Google sign-in, a session cookie, and the forUser() choke point that
// makes an unscoped query impossible to write — so a public bind is exactly
// what a deployed instance is supposed to have, and a guard that refuses it
// would be a guard everyone routinely overrides. That trains people to
// override guards, which is worse than not having one.
//
// The dangerous case still exists and is still refused, just not from here:
// `resolveAuthMode()` in src/lib/server/auth.ts throws when GOOGLE_CLIENT_ID
// is unset AND the bind is not loopback, because single-user mode attributes
// every request to user 1. It runs at module load inside the handler imported
// at the bottom of this file, so it fails before anything is served.
//
// Deliberately NOT duplicated here. Two copies of a security rule drift, and
// the copy that drifts is the one running on the server. The migration loop in
// this same directory taught that lesson once already.
const host = process.env.HOST ?? '0.0.0.0';
const inContainer = existsSync('/.dockerenv') || process.env.SPLIT_IN_CONTAINER === '1';

// ─── Migrate ──────────────────────────────────────────────────────────────
mkdirSync(dirname(dbPath), { recursive: true });
mkdirSync(join(dirname(dbPath), 'backups'), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
let count = 0;
try {
	count = applyMigrations(db, join(root, 'migrations'), (f) => console.log(`[migrate] applied ${f}`));
} catch (err) {
	console.error(`Migration failed: ${err.message}`);
	process.exit(1);
}

db.close();

console.log(
	`[split] db ${dbPath} · ${count === 0 ? 'schema current' : `applied ${count} migration(s)`}`
);
// The built server starts on import, and resolveAuthMode() runs during it —
// so this is where a misconfigured deployment dies. The "listening" line comes
// AFTER, because printing it first meant the log claimed a bind that never
// happened, in exactly the situation where someone is reading the log
// carefully to find out why nothing works.
await import(join(root, 'build', 'index.js'));

console.log(
	`[split] listening on ${host}:${process.env.PORT ?? 3000}${inContainer ? ' (in container)' : ''}`
);
