import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { startScheduler } from '$lib/server/jobs';
import {
	AuthConfigError,
	resolveAuthMode,
	resolveSession,
	renewSession,
	sessionCookieAttrs,
	SESSION_COOKIE
} from '$lib/server/auth';

/**
 * A2's single-user escape hatch (see auth.ts for the full rationale).
 * Resolved once at process startup, before anything else runs: an unsafe
 * combination of env vars refuses to start, the same way scripts/serve.js
 * refuses a wildcard bind with no login, rather than starting the scheduler
 * or serving a single request in a state that quietly hands out the owner's
 * data.
 */
let authMode: ReturnType<typeof resolveAuthMode>;
try {
	authMode = resolveAuthMode(process.env);
} catch (err) {
	console.error(err instanceof AuthConfigError ? err.message : String(err));
	process.exit(1);
}

console.log(
	authMode.kind === 'single-user'
		? '[split] auth: single-user mode — every request is user 1 (GOOGLE_CLIENT_ID is not set)'
		: `[split] auth: Google sign-in enabled (origin ${authMode.origin})`
);

// One process, one scheduler. Rollover and backup are idempotent and keyed by
// date, so this is safe on every restart (Spec §3).
startScheduler();

/**
 * Requests that must work with no session at all: the sign-in page itself,
 * the OAuth round trip, and the health check nothing here has authenticated
 * to poll.
 */
function isPublicPath(pathname: string): boolean {
	return (
		pathname === '/signin' ||
		pathname === '/api/health' ||
		// The demo mints its own tenant and its own session (§3.4). Requiring a
		// session to reach it would be circular, and the whole point is that a
		// reviewer gets in without signing up for anything.
		pathname === '/demo' ||
		pathname.startsWith('/auth/')
	);
}

export const handle: Handle = ({ event, resolve }) => {
	if (authMode.kind === 'single-user') {
		event.locals.userId = 1;
		return resolve(event);
	}

	const sessionId = event.cookies.get(SESSION_COOKIE);
	const session = sessionId ? resolveSession(sessionId) : null;

	if (session) {
		event.locals.userId = session.userId;
		// Sliding renewal: touching the app pushes the 30-day expiry back out,
		// on both the row and the cookie that carries it.
		renewSession(sessionId!);
		event.cookies.set(
			SESSION_COOKIE,
			sessionId!,
			sessionCookieAttrs(event.url.protocol === 'https:')
		);
		return resolve(event);
	}

	// A cookie that no longer resolves (expired, or never valid) is worth
	// clearing rather than leaving the browser to keep sending it forever.
	if (sessionId) event.cookies.delete(SESSION_COOKIE, { path: '/' });

	if (!isPublicPath(event.url.pathname)) {
		redirect(303, '/signin');
	}

	return resolve(event);
};
