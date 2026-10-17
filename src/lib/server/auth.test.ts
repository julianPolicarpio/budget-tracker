/**
 * Sessions, provisioning and the single-user escape hatch (Spec §3.3, A2).
 *
 * Same harness as tenancy.test.ts: a throwaway SQLite file, migrated fresh,
 * so these tests never touch data/split.db and never depend on what ran
 * before them.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { applyMigrations } from '../../../scripts/apply-migrations.js';

type Mod = {
	sqlite: typeof import('./db').sqlite;
	auth: typeof import('./auth');
	googleOauth: typeof import('./google-oauth');
};

let m: Mod;

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-auth-'));
	process.env.DATABASE_URL = join(dir, 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';

	const dbMod = await import('./db');
	applyMigrations(dbMod.sqlite, resolve('migrations'));

	m = {
		sqlite: dbMod.sqlite,
		auth: await import('./auth'),
		googleOauth: await import('./google-oauth')
	};
});

/** A throwaway app_user row not owned by any test above it. */
function makeUser(): number {
	const info = m.sqlite.prepare(`INSERT INTO app_user (created_at) VALUES ('x')`).run();
	return Number(info.lastInsertRowid);
}

describe('session ids', () => {
	it('is 64 hex characters, and two consecutive ids differ', () => {
		const a = m.auth.createSessionId();
		const b = m.auth.createSessionId();
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(b).toMatch(/^[0-9a-f]{64}$/);
		expect(a).not.toBe(b);
	});
});

describe('session lifecycle', () => {
	it('an expired session resolves to no user', () => {
		const userId = makeUser();
		const now = new Date('2026-06-01T00:00:00.000Z');
		const session = m.auth.createSession(userId, now);

		// Just before expiry, still good.
		const almostExpired = new Date(now.getTime() + m.auth.SESSION_TTL_MS - 1);
		expect(m.auth.resolveSession(session.id, almostExpired)).toEqual({ userId });

		// Past it, gone.
		const afterExpiry = new Date(now.getTime() + m.auth.SESSION_TTL_MS + 1);
		expect(m.auth.resolveSession(session.id, afterExpiry)).toBeNull();
	});

	it('deleting a user cascades to their sessions', () => {
		const userId = makeUser();
		const session = m.auth.createSession(userId);
		expect(m.auth.resolveSession(session.id)).toEqual({ userId });

		m.sqlite.prepare('DELETE FROM app_user WHERE id = ?').run(userId);

		const row = m.sqlite.prepare('SELECT 1 FROM session WHERE id = ?').get(session.id);
		expect(row).toBeUndefined();
	});

	it('sliding renewal pushes the expiry back out', () => {
		const userId = makeUser();
		const now = new Date('2026-06-01T00:00:00.000Z');
		const session = m.auth.createSession(userId, now);

		const later = new Date(now.getTime() + 1000);
		const renewedExpiry = m.auth.renewSession(session.id, later);
		expect(renewedExpiry > session.expiresAt).toBe(true);

		// A moment that was past the *original* expiry is still valid, because
		// renewal moved the goalposts.
		const pastOriginalExpiry = new Date(now.getTime() + m.auth.SESSION_TTL_MS + 1);
		expect(m.auth.resolveSession(session.id, pastOriginalExpiry)).toEqual({ userId });
	});

	it('deleteSession revokes immediately', () => {
		const userId = makeUser();
		const session = m.auth.createSession(userId);
		m.auth.deleteSession(session.id);
		expect(m.auth.resolveSession(session.id)).toBeNull();
	});
});

describe('provisionUser', () => {
	it('gives a new user exactly one settings row and six accounts, all their own', () => {
		const userId = makeUser();
		m.auth.provisionUser(userId);

		const settingsRows = m.sqlite
			.prepare('SELECT user_id AS userId FROM settings WHERE user_id = ?')
			.all(userId) as { userId: number }[];
		expect(settingsRows).toHaveLength(1);

		const accounts = m.sqlite
			.prepare('SELECT slug, user_id AS userId FROM account WHERE user_id = ?')
			.all(userId) as { slug: string; userId: number }[];
		expect(accounts).toHaveLength(6);
		expect(new Set(accounts.map((a) => a.slug))).toEqual(
			new Set(['inflow', 'bills', 'spend', 'irregulars', 'buffer', 'grow'])
		);
		for (const a of accounts) expect(a.userId).toBe(userId);
	});
});

describe('findOrCreateGoogleUser', () => {
	it('two users signing in get different sessions, and one never resolves to the other', () => {
		const alice = m.auth.findOrCreateGoogleUser({
			sub: 'google-sub-alice',
			email: 'alice@example.com',
			name: 'Alice'
		});
		const bob = m.auth.findOrCreateGoogleUser({
			sub: 'google-sub-bob',
			email: 'bob@example.com',
			name: 'Bob'
		});
		expect(alice.isNew).toBe(true);
		expect(bob.isNew).toBe(true);
		expect(alice.userId).not.toBe(bob.userId);

		const sessionA = m.auth.createSession(alice.userId);
		const sessionB = m.auth.createSession(bob.userId);
		expect(sessionA.id).not.toBe(sessionB.id);

		expect(m.auth.resolveSession(sessionA.id)?.userId).toBe(alice.userId);
		expect(m.auth.resolveSession(sessionB.id)?.userId).toBe(bob.userId);
		expect(m.auth.resolveSession(sessionA.id)?.userId).not.toBe(bob.userId);
		expect(m.auth.resolveSession(sessionB.id)?.userId).not.toBe(alice.userId);
	});

	it('signing in again with the same google_sub returns the same user, not a new one', () => {
		const first = m.auth.findOrCreateGoogleUser({
			sub: 'google-sub-carol',
			email: 'carol@example.com',
			name: 'Carol'
		});
		const second = m.auth.findOrCreateGoogleUser({
			sub: 'google-sub-carol',
			email: 'carol@example.com',
			name: 'Carol'
		});
		expect(second.isNew).toBe(false);
		expect(second.userId).toBe(first.userId);
	});

	it('provisions the new user so signing in never crashes on a missing bucket', () => {
		const { userId } = m.auth.findOrCreateGoogleUser({
			sub: 'google-sub-dave',
			email: 'dave@example.com',
			name: 'Dave'
		});
		const accounts = m.sqlite
			.prepare('SELECT count(*) AS n FROM account WHERE user_id = ?')
			.get(userId) as { n: number };
		expect(accounts.n).toBe(6);
	});
});

describe('resolveAuthMode — the single-user escape hatch', () => {
	it('allows single-user mode on a loopback host, or when HOST is unset', () => {
		expect(m.auth.resolveAuthMode({ HOST: '127.0.0.1' })).toEqual({ kind: 'single-user' });
		expect(m.auth.resolveAuthMode({ HOST: 'localhost' })).toEqual({ kind: 'single-user' });
		expect(m.auth.resolveAuthMode({ HOST: '::1' })).toEqual({ kind: 'single-user' });
		expect(m.auth.resolveAuthMode({})).toEqual({ kind: 'single-user' });
	});

	it('refuses single-user mode when HOST is non-loopback and GOOGLE_CLIENT_ID is unset', () => {
		expect(() => m.auth.resolveAuthMode({ HOST: '0.0.0.0' })).toThrow(m.auth.AuthConfigError);
		expect(() => m.auth.resolveAuthMode({ HOST: '192.168.1.50' })).toThrow(m.auth.AuthConfigError);
	});

	it('refuses a client id with no secret or origin', () => {
		expect(() => m.auth.resolveAuthMode({ GOOGLE_CLIENT_ID: 'abc', HOST: '127.0.0.1' })).toThrow(
			m.auth.AuthConfigError
		);
	});

	it('returns full Google config once everything is set, even on a wildcard host', () => {
		const mode = m.auth.resolveAuthMode({
			GOOGLE_CLIENT_ID: 'abc',
			GOOGLE_CLIENT_SECRET: 'shh',
			PUBLIC_ORIGIN: 'https://split.example.com',
			HOST: '0.0.0.0'
		});
		expect(mode).toEqual({
			kind: 'google',
			clientId: 'abc',
			clientSecret: 'shh',
			origin: 'https://split.example.com'
		});
	});
});

describe('google-oauth: exchangeCodeForProfile', () => {
	const config = { clientId: 'id', clientSecret: 'secret', origin: 'https://split.example.com' };

	it('exchanges a code for a profile via two fetches, keeping only sub/email/name', async () => {
		const calls: string[] = [];
		const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
			const url = String(input instanceof Request ? input.url : input);
			calls.push(url);
			if (url.includes('oauth2.googleapis.com/token')) {
				return new Response(
					JSON.stringify({ access_token: 'fake-access-token', id_token: 'fake-id-token' }),
					{ status: 200 }
				);
			}
			if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
				return new Response(
					JSON.stringify({ sub: 'g-123', email: 'person@example.com', name: 'Person' }),
					{ status: 200 }
				);
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		try {
			const profile = await m.googleOauth.exchangeCodeForProfile(config, 'auth-code');
			expect(profile).toEqual({ sub: 'g-123', email: 'person@example.com', name: 'Person' });
			expect(calls).toHaveLength(2);
			// The secret went out over the wire (Google requires it), but never
			// comes back — the returned profile carries no token of any kind.
			expect(Object.keys(profile)).toEqual(['sub', 'email', 'name']);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it('throws GoogleAuthError when the token exchange fails, never a live-credentials test', async () => {
		const fetchSpy = vi
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response('nope', { status: 400 }));
		try {
			await expect(m.googleOauth.exchangeCodeForProfile(config, 'bad-code')).rejects.toThrow(
				m.googleOauth.GoogleAuthError
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe('resolveAuthMode — demo mode', () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-demo-mode-'));
	const repo = join(dir, 'repo');
	mkdirSync(join(repo, 'data'), { recursive: true });
	const demoDb = join(dir, 'demo', 'demo.db');
	mkdirSync(dirname(demoDb), { recursive: true });

	it('starts with loopback, no Google, and a DB outside the repo data dir', () => {
		expect(m.auth.resolveAuthMode({ SPLIT_DEMO_MODE: '1', HOST: '127.0.0.1', DATABASE_URL: demoDb }, repo)).toEqual({ kind: 'demo' });
	});
	it('refuses alongside Google sign-in', () => {
		expect(() => m.auth.resolveAuthMode({ SPLIT_DEMO_MODE: '1', HOST: '127.0.0.1', DATABASE_URL: demoDb, GOOGLE_CLIENT_ID: 'x' }, repo)).toThrow(m.auth.AuthConfigError);
	});
	it('refuses a non-loopback bind', () => {
		expect(() => m.auth.resolveAuthMode({ SPLIT_DEMO_MODE: '1', HOST: '0.0.0.0', DATABASE_URL: demoDb }, repo)).toThrow(m.auth.AuthConfigError);
	});
	it('refuses with no DATABASE_URL', () => {
		expect(() => m.auth.resolveAuthMode({ SPLIT_DEMO_MODE: '1', HOST: '127.0.0.1' }, repo)).toThrow(m.auth.AuthConfigError);
	});
	it('refuses the live database, directly or through a symlink', () => {
		expect(() => m.auth.resolveAuthMode({ SPLIT_DEMO_MODE: '1', HOST: '127.0.0.1', DATABASE_URL: join(repo, 'data', 'split.db') }, repo)).toThrow(m.auth.AuthConfigError);
		const link = join(dir, 'sneaky');
		symlinkSync(join(repo, 'data'), link);
		expect(() => m.auth.resolveAuthMode({ SPLIT_DEMO_MODE: '1', HOST: '127.0.0.1', DATABASE_URL: join(link, 'other.db') }, repo)).toThrow(m.auth.AuthConfigError);
	});
});

describe('resolveAuthMode — demo mode, links to the live file', () => {
	const dir = mkdtempSync(join(tmpdir(), 'split-demo-link-'));
	const repo = join(dir, 'repo');
	mkdirSync(join(repo, 'data'), { recursive: true });
	const live = join(repo, 'data', 'split.db');
	writeFileSync(live, 'fake');
	mkdirSync(join(dir, 'demo'), { recursive: true });
	const env = (db: string) => ({ SPLIT_DEMO_MODE: '1', HOST: '127.0.0.1', DATABASE_URL: db });

	it('refuses a symlink outside data/ that points at the live file', () => {
		const link = join(dir, 'demo', 'sym.db');
		symlinkSync(live, link);
		expect(() => m.auth.resolveAuthMode(env(link), repo)).toThrow(m.auth.AuthConfigError);
	});
	it('refuses a hard link outside data/ to the live file', () => {
		const hard = join(dir, 'demo', 'hard.db');
		linkSync(live, hard);
		expect(() => m.auth.resolveAuthMode(env(hard), repo)).toThrow(m.auth.AuthConfigError);
	});
	it('still starts with a new file outside data/', () => {
		expect(m.auth.resolveAuthMode(env(join(dir, 'demo', 'fresh.db')), repo)).toEqual({ kind: 'demo' });
	});
});

describe('isPublicPath', () => {
	it('keeps /auth/* public for Google and closes it in demo mode', () => {
		expect(m.auth.isPublicPath('/auth/google', 'google')).toBe(true);
		expect(m.auth.isPublicPath('/auth/google', 'demo')).toBe(false);
		expect(m.auth.isPublicPath('/demo', 'demo')).toBe(true);
		expect(m.auth.isPublicPath('/signin', 'demo')).toBe(true);
		expect(m.auth.isPublicPath('/', 'demo')).toBe(false);
	});
});
