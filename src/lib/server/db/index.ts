/**
 * One SQLite file, WAL, in-process. No daemon, no pool, no uptime requirement.
 * For one user writing ~10 rows a day, anything else is a liability (Spec §9).
 *
 * ─── The choke point (Spec §3.2) ─────────────────────────────────────────
 *
 * This app used to have one human, and network isolation was the whole auth
 * story. It is becoming public, and the entire risk of that change sits in one
 * failure mode: a query that forgets its `user_id` shows a stranger someone
 * else's financial history.
 *
 * `user_id NOT NULL DEFAULT 1` does not prevent that, and the default actively
 * hides it — a forgotten id files a stranger's row into the owner's account
 * instead of throwing. So the protection cannot live in the schema. It lives
 * here.
 *
 * The unscoped handle is still exported, because migrations, the schema
 * enumeration test and a few genuinely global reads need it. It is called
 * `unsafeDb` so that its use is a visible decision at every call site rather
 * than the path of least resistance, and so that `grep unsafeDb src/` is a
 * complete audit in one command.
 *
 * Application code takes `forUser(userId)` instead. `owns(table)` is the
 * fragment every query composes with, in the same spirit as the `trip_id IS
 * NULL` quarantine in metrics.ts: put the rule in one place that callers
 * cannot forget, rather than in 61 places they must remember.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

/*
 * ─── The production-database guard ───────────────────────────────────────
 *
 * This line runs at IMPORT time, which is the whole hazard. A test that
 * imports any server module statically — `import { x } from './accounts'` at
 * the top of the file — pulls this module in before its own `beforeAll` has
 * had a chance to point DATABASE_URL at a temp directory. The fallback below
 * then opens the real `data/split.db`, and the test seeds its fixtures into
 * somebody's actual financial history. Silently, and with a green run.
 *
 * That is not hypothetical: it happened on 2026-09-22 and wrote two fixture
 * tenants and their cascaded rows into live data before anyone noticed.
 *
 * Every test in this repo already does the right thing — set DATABASE_URL,
 * then `await import()` the module inside `beforeAll`. The convention was
 * held by discipline alone, and discipline is not a mechanism. So: under a
 * test runner, an unset DATABASE_URL is a loud refusal rather than a quiet
 * default. The cost of being wrong in the other direction is unrecoverable.
 */
const explicitPath = process.env.DATABASE_URL;
const underTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
if (underTest && !explicitPath) {
	throw new Error(
		'Refusing to open the production database from a test run.\n' +
			'DATABASE_URL is unset, so this would have opened data/split.db — live user data.\n' +
			'This almost always means a test imported a server module statically. Instead:\n' +
			"  process.env.DATABASE_URL = join(mkdtempSync(...), 'split.db');\n" +
			"  const mod = await import('./the-module');   // inside beforeAll, after the line above\n" +
			'See any *.integration.test.ts in src/lib/server/ for the working pattern.'
	);
}

const dbPath = explicitPath ?? resolve('data', 'split.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

/**
 * The unscoped connection.
 *
 * Legitimate uses are narrow: migrations, the tenancy tests, and reads whose
 * answer is genuinely global. Everything else wants `forUser()`. If you are
 * about to reach for this in a route or a metric, that is the bug.
 */
export const unsafeDb = drizzle(sqlite, { schema });

export { schema };

/** Any table carrying a tenancy column. Tables without one cannot be scoped. */
export type Tenanted = { userId: import('drizzle-orm/sqlite-core').SQLiteColumn };

/**
 * Everything one person is allowed to see.
 *
 * `owns(t)` is the whole mechanism: compose it into a `where` and the row set
 * is theirs by construction. It returns a condition rather than a pre-built
 * query so that joins, aggregates and partial indexes all keep working — a
 * wrapper that only supported simple selects would just push callers back to
 * `unsafeDb`, which is the failure this exists to prevent.
 */
export function forUser(userId: number) {
	if (!Number.isInteger(userId) || userId < 1) {
		// A bad id must never silently become user 1. That is the tenancy leak
		// running backwards, and the DEFAULT on the column would let it pass.
		throw new Error(`forUser called with a non-user: ${String(userId)}`);
	}

	return {
		userId,
		db: unsafeDb,
		/** The `where` fragment that restricts a table to this person. */
		owns<T extends Tenanted>(t: T) {
			return eq(t.userId, userId);
		}
	};
}

export type Scope = ReturnType<typeof forUser>;
