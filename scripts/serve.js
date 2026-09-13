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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DATABASE_URL ?? join(root, 'data', 'split.db');

// ─── Invariant 10: never bind to a public interface ───────────────────────
//
// Network isolation IS the auth boundary for this app. There is no login, no
// accounts table, no tenancy column — anything that can reach the port can
// read the whole financial history.
//
// Inside a container, HOST=0.0.0.0 is correct and safe: the container's
// network namespace is private and the host's port publish decides what is
// reachable (compose binds it to loopback). On a bare host the same value
// means every interface, including whatever the router forwards. So the check
// is conditional on where it is running, not on the string alone.
const host = process.env.HOST ?? '0.0.0.0';
const inContainer = existsSync('/.dockerenv') || process.env.SPLIT_IN_CONTAINER === '1';
const wildcard = host === '0.0.0.0' || host === '::' || host === '';

if (wildcard && !inContainer && process.env.SPLIT_ALLOW_PUBLIC_BIND !== 'i-understand') {
	console.error(
		`\nRefusing to start.\n\n` +
			`  HOST is "${host}", which on a bare host means every interface — including\n` +
			`  anything your router forwards. Split has no login: whatever reaches the port\n` +
			`  reads your whole financial history. Network isolation is the auth boundary\n` +
			`  (Spec §1 non-goals, invariant 10).\n\n` +
			`  Bind it to something private instead:\n\n` +
			`    HOST=127.0.0.1 node scripts/serve.js          # this machine only\n` +
			`    HOST=100.x.y.z node scripts/serve.js          # your Tailscale address\n\n` +
			`  Or run it in the container, where 0.0.0.0 is correct and the port publish\n` +
			`  in docker-compose.yml is what governs reach.\n`
	);
	process.exit(1);
}

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
console.log(
	`[split] listening on ${host}:${process.env.PORT ?? 3000}${inContainer ? ' (in container)' : ''}`
);

// The built server starts on import. Everything above must pass first.
await import(join(root, 'build', 'index.js'));
