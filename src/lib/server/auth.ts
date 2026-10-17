/**
 * Sign-in, sessions, and the single-user escape hatch (Spec §3.3, A2).
 *
 * ─── Why a session table, not a JWT ───────────────────────────────────────
 *
 * A signed token needs no lookup, which sounds like less machinery than this
 * file's one table. It is not, once revocation exists: signing a user out, or
 * killing every session after a suspected leak, needs the JWT to carry a
 * rotating signing key and a rejection list. A row you can DELETE is less
 * machinery than that. `migrations/0009_session.sql` explains the rest.
 *
 * ─── THE SINGLE-USER ESCAPE HATCH ─────────────────────────────────────────
 *
 * The owner runs this app on his own Mac right now, before he has Google
 * credentials. `resolveAuthMode()` must not lock him out: with no
 * `GOOGLE_CLIENT_ID`, the app runs exactly as it did before sign-in existed —
 * every request is `app_user` id 1, no redirect.
 *
 * That fallback is a security hole the moment it reaches a public bind:
 * anyone who can reach the port becomes the owner. So it is gated the same
 * way `scripts/serve.js` gates a wildcard bind — allowed on a loopback host,
 * refused everywhere else. Unlike that guard, there is no override variable
 * here. The fix for a refusal is to configure sign-in or bind somewhere
 * private, not to force it through.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { sqlite, unsafeDb, schema } from './db';
import type { Account } from './db/schema';

// ─── Cookies ────────────────────────────────────────────────────────────

export const SESSION_COOKIE = 'split_session';
export const STATE_COOKIE = 'split_oauth_state';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding
const STATE_TTL_S = 10 * 60; // 10 minutes is long enough for a Google redirect

export interface CookieAttrs {
	path: '/';
	httpOnly: true;
	sameSite: 'lax';
	secure: boolean;
	maxAge: number;
}

/** `secure` only when the request is https, so localhost http still works. */
export function sessionCookieAttrs(secure: boolean): CookieAttrs {
	return { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_TTL_MS / 1000 };
}

export function stateCookieAttrs(secure: boolean): CookieAttrs {
	return { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: STATE_TTL_S };
}

// ─── Sessions ───────────────────────────────────────────────────────────

/** 32 random bytes, hex — never Math.random, never derived from anything guessable. */
export function createSessionId(): string {
	return randomBytes(32).toString('hex');
}

/** The CSRF token for the OAuth round trip. Same primitive, smaller: 16 random bytes, hex. */
export function createStateToken(): string {
	return randomBytes(16).toString('hex');
}

export interface CreatedSession {
	id: string;
	expiresAt: string;
}

/** A brand new session for this user. */
export function createSession(userId: number, now: Date = new Date()): CreatedSession {
	const id = createSessionId();
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
	sqlite
		.prepare(`INSERT INTO session (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
		.run(id, userId, now.toISOString(), expiresAt);
	return { id, expiresAt };
}

/**
 * Who a session belongs to, or null if it does not exist or has expired.
 *
 * Deliberately unscoped: the whole point of a session lookup is to answer
 * "which user is this" before any user_id is known, so `forUser()` cannot sit
 * in front of it. This is exactly the "genuinely global read" the db module's
 * `unsafeDb`/`sqlite` exports exist for — it reads a table keyed by session
 * id, not by tenant, and there is no tenant to scope by yet.
 */
export function resolveSession(
	sessionId: string,
	now: Date = new Date()
): { userId: number } | null {
	const row = sqlite
		.prepare(`SELECT user_id AS userId, expires_at AS expiresAt FROM session WHERE id = ?`)
		.get(sessionId) as { userId: number; expiresAt: string } | undefined;

	if (!row) return null;
	// ISO 8601 strings with the same precision compare lexically the same as
	// chronologically, matching how the rest of the app compares date strings.
	if (row.expiresAt <= now.toISOString()) return null;
	return { userId: row.userId };
}

/** Sliding renewal: push the expiry out again because the session was used. */
export function renewSession(sessionId: string, now: Date = new Date()): string {
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
	sqlite.prepare(`UPDATE session SET expires_at = ? WHERE id = ?`).run(expiresAt, sessionId);
	return expiresAt;
}

/** Revocation. A DELETE is the entire mechanism — no key rotation, no rejection list. */
export function deleteSession(sessionId: string): void {
	sqlite.prepare(`DELETE FROM session WHERE id = ?`).run(sessionId);
}

// ─── New-user provisioning ─────────────────────────────────────────────
//
// Migration 0003 seeded the six money buckets and the settings row for user 1
// only. A user created by OAuth therefore owns neither, and a user who signs
// in and hits a crashing app is a bug, not a later task. Both are created
// here, in one transaction, on first sign-in — the same defaults
// `scripts/init.js` gives the owner, and the same six accounts migration
// 0003 seeds for user 1.

const STARTER_SETTINGS = {
	currencyCode: 'PHP',
	currencySymbol: '₱',
	minorUnits: 2,
	roundingStep: 1000,
	periodKind: 'weekly' as const,
	weekStartsOn: 0,
	haircutPct: 15,
	bandPct: 10,
	phase: 0,
	timezone: 'Asia/Manila'
};

const STARTER_ACCOUNTS: Array<{
	slug: string;
	name: string;
	kind: Account['kind'];
	isCommitted: 0 | 1;
	hasCard: 0 | 1;
	sortOrder: number;
}> = [
	{ slug: 'inflow', name: 'Income', kind: 'inflow', isCommitted: 0, hasCard: 0, sortOrder: 1 },
	{ slug: 'bills', name: 'Bills', kind: 'bills', isCommitted: 0, hasCard: 0, sortOrder: 2 },
	// The only account with a card, and it is debit — same note as migration 0003.
	{ slug: 'spend', name: 'Spending', kind: 'spend', isCommitted: 0, hasCard: 1, sortOrder: 3 },
	{
		slug: 'irregulars',
		name: 'Big bills',
		kind: 'irregulars',
		isCommitted: 0,
		hasCard: 0,
		sortOrder: 4
	},
	{ slug: 'buffer', name: 'Emergency fund', kind: 'buffer', isCommitted: 1, hasCard: 0, sortOrder: 5 },
	{ slug: 'grow', name: 'Savings', kind: 'grow', isCommitted: 1, hasCard: 0, sortOrder: 6 }
];

/** Exactly one settings row and the six starter accounts, for a brand new user. */
export function provisionUser(userId: number, now: Date = new Date()): void {
	unsafeDb.transaction((tx) => {
		tx.insert(schema.settings)
			.values({ ...STARTER_SETTINGS, createdAt: now.toISOString(), userId })
			.run();

		for (const acct of STARTER_ACCOUNTS) {
			tx.insert(schema.account)
				.values({
					slug: acct.slug,
					name: acct.name,
					kind: acct.kind,
					isCommitted: acct.isCommitted,
					hasCard: acct.hasCard,
					balanceMinor: 0,
					sortOrder: acct.sortOrder,
					userId
				})
				.run();
		}
	});
}

// ─── Identity ───────────────────────────────────────────────────────────

export interface GoogleIdentity {
	sub: string;
	email: string | null;
	name: string | null;
}

export interface FoundOrCreatedUser {
	userId: number;
	isNew: boolean;
}

/**
 * Look a Google identity up by its stable subject id, creating (and
 * provisioning) a fresh `app_user` on first sign-in.
 *
 * `google_sub`, never email, is the identity — emails change hands (Spec
 * §3.3). Unscoped for the same reason session lookups are: there is no
 * tenant yet, that is precisely what this function is deciding.
 */
export function findOrCreateGoogleUser(
	identity: GoogleIdentity,
	now: Date = new Date()
): FoundOrCreatedUser {
	const existing = unsafeDb
		.select({ id: schema.appUser.id })
		.from(schema.appUser)
		.where(eq(schema.appUser.googleSub, identity.sub))
		.get();

	if (existing) return { userId: existing.id, isNew: false };

	const created = unsafeDb
		.insert(schema.appUser)
		.values({
			googleSub: identity.sub,
			email: identity.email,
			displayName: identity.name,
			createdAt: now.toISOString()
		})
		.returning({ id: schema.appUser.id })
		.get();

	provisionUser(created.id, now);
	return { userId: created.id, isNew: true };
}

// ─── The single-user escape hatch ────────────────────────────────────────

export type AuthMode =
	| { kind: 'single-user' }
	| { kind: 'demo' }
	| { kind: 'google'; clientId: string; clientSecret: string; origin: string };

export class AuthConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthConfigError';
	}
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackOrUnset(host: string | undefined): boolean {
	return host === undefined || host === '' || LOOPBACK_HOSTS.has(host);
}

/** Resolve symlinks on the deepest part of the path that exists. */
function realDir(p: string): string {
	let dir = resolve(p);
	const tail: string[] = [];
	while (!existsSync(dir) && dirname(dir) !== dir) {
		tail.unshift(basename(dir));
		dir = dirname(dir);
	}
	return join(realpathSync(dir), ...tail);
}

/**
 * The public demo: every visitor gets their own seeded tenant via /demo.
 * Its one job is to be unable to reach the owner's money, so it refuses to
 * start unless the database lives outside this checkout's data/ directory.
 */
function resolveDemoMode(env: NodeJS.ProcessEnv, cwd: string): AuthMode {
	const refuse = (why: string) =>
		new AuthConfigError(`\nRefusing to start the demo.\n\n  ${why}\n`);
	if (env.GOOGLE_CLIENT_ID?.trim()) {
		throw refuse('SPLIT_DEMO_MODE=1 cannot be combined with GOOGLE_CLIENT_ID.');
	}
	if (!isLoopbackOrUnset(env.HOST) || !env.HOST) {
		throw refuse(
			`HOST must be a loopback address; the tunnel is the only way in. Got "${env.HOST ?? ''}".`
		);
	}
	const db = env.DATABASE_URL?.trim();
	if (!db) throw refuse('DATABASE_URL must point at the demo database.');
	const liveDataDir = realDir(join(cwd, 'data'));
	const dbDir = realDir(dirname(resolve(cwd, db)));
	if (dbDir === liveDataDir || dbDir.startsWith(liveDataDir + sep)) {
		throw refuse(`DATABASE_URL (${db}) is inside ${liveDataDir}, where the real database lives.`);
	}
	const inLive = (p: string) => p === liveDataDir || p.startsWith(liveDataDir + sep);
	const dbFile = resolve(cwd, db);
	if (existsSync(dbFile)) {
		// A symlink at the file itself: dirname alone cannot see it.
		if (inLive(realpathSync(dbFile))) {
			throw refuse(`DATABASE_URL (${db}) resolves to a file inside ${liveDataDir}.`);
		}
		// A hard link has no path to resolve; the inode is the only tell.
		const liveFile = join(cwd, 'data', 'split.db');
		if (existsSync(liveFile)) {
			const a = statSync(dbFile);
			const b = statSync(liveFile);
			if (a.dev === b.dev && a.ino === b.ino) {
				throw refuse(`DATABASE_URL (${db}) is the same file as ${liveFile}.`);
			}
		}
	}
	return { kind: 'demo' };
}

/**
 * Requests that must work with no session at all: the sign-in page itself,
 * the OAuth round trip, and the health check nothing here has authenticated
 * to poll. In demo mode there is no OAuth round trip, so /auth/* stays closed.
 */
export function isPublicPath(pathname: string, mode: AuthMode['kind']): boolean {
	return (
		pathname === '/signin' ||
		pathname === '/api/health' ||
		// The demo mints its own tenant and its own session (§3.4). Requiring a
		// session to reach it would be circular, and the whole point is that a
		// reviewer gets in without signing up for anything.
		pathname === '/demo' ||
		(mode !== 'demo' && pathname.startsWith('/auth/'))
	);
}

/**
 * Decide how requests get attributed to a user, from environment alone.
 *
 * Returns `{ kind: 'single-user' }` when no Google sign-in is configured and
 * the host is safe for it. Returns `{ kind: 'google', ... }` when sign-in is
 * fully configured. Throws `AuthConfigError` — meant to abort startup, the
 * same way `scripts/serve.js` refuses a wildcard bind — for every other
 * combination: a public-looking `HOST` with no sign-in, or a `GOOGLE_CLIENT_ID`
 * without its required partners.
 */
export function resolveAuthMode(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd()
): AuthMode {
	if (env.SPLIT_DEMO_MODE === '1') return resolveDemoMode(env, cwd);
	const clientId = env.GOOGLE_CLIENT_ID?.trim();

	if (!clientId) {
		if (isLoopbackOrUnset(env.HOST)) return { kind: 'single-user' };

		throw new AuthConfigError(
			`\nRefusing to start.\n\n` +
				`  GOOGLE_CLIENT_ID is not set and HOST is "${env.HOST}", which is not a\n` +
				`  loopback address. With no sign-in configured, single-user mode attributes\n` +
				`  every request reaching this port to user 1 (the owner) — on a bind anyone\n` +
				`  else can reach, that means anyone who reaches the port reads the owner's\n` +
				`  whole financial history.\n\n` +
				`  Either configure Google sign-in:\n\n` +
				`    GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... PUBLIC_ORIGIN=https://... \\\n` +
				`      node scripts/serve.js\n\n` +
				`  or bind somewhere private instead:\n\n` +
				`    HOST=127.0.0.1 node scripts/serve.js\n`
		);
	}

	const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
	const origin = env.PUBLIC_ORIGIN?.trim();
	const missing = [!clientSecret && 'GOOGLE_CLIENT_SECRET', !origin && 'PUBLIC_ORIGIN'].filter(
		(x): x is string => x !== false
	);

	if (missing.length > 0) {
		throw new AuthConfigError(
			`\nRefusing to start.\n\n` +
				`  GOOGLE_CLIENT_ID is set, so Google sign-in is expected, but ${missing.join(' and ')} ` +
				`${missing.length > 1 ? 'are' : 'is'} missing.\n` +
				`  Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_ORIGIN together.\n`
		);
	}

	return { kind: 'google', clientId, clientSecret: clientSecret!, origin: origin! };
}
