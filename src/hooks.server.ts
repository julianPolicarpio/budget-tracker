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

/**
 * The configured origin, if there is one.
 *
 * adapter-node rejects any POST whose `Origin` header does not match `ORIGIN`.
 * That check is worth keeping — without it any page in the browser could POST
 * to a loopback-bound app — but it fails in a way that is very hard to read:
 * the browser sends the origin of the PAGE, so visiting `127.0.0.1:3000` when
 * ORIGIN says `localhost:3000` makes every form submission fail forever, with
 * a message about cross-site requests that names neither URL.
 *
 * Observed in production, and made invisible by the offline outbox: the field
 * cleared, the entry queued, the POST was refused, and the queue could never
 * drain because a replay carries the same wrong origin. Two entries sat there
 * for a day while the app looked like it was working.
 */
const CANONICAL_ORIGIN = process.env.ORIGIN?.trim() || null;

export const handle: Handle = ({ event, resolve }) => {
	/*
	 * Redirecting the POST itself would not help — the Origin header comes from
	 * the page that submitted it, not from this request's URL. So the fix is to
	 * make sure a navigation never LANDS on the wrong host: send GETs to the
	 * canonical origin, and every form on the page that follows is submitted
	 * from the right one.
	 */
	if (CANONICAL_ORIGIN && event.request.method === 'GET') {
		const want = new URL(CANONICAL_ORIGIN);
		if (event.url.host !== want.host) {
			const to = new URL(event.url);
			to.protocol = want.protocol;
			to.host = want.host;
			redirect(307, to.toString());
		}
	}

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
