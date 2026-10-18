/**
 * One click into a working app (Spec §3.4).
 *
 * Reviewers click a demo. Reviewers do not sign up. So this mints a fresh
 * tenant seeded with ninety days of history, gives it an ordinary session, and
 * drops the visitor on Today — no email, no Google, no form.
 *
 * POST, not GET, and deliberately: a GET would let any link preview, prefetch
 * or crawler create a tenant, and a bot sweeping the page would seed the
 * database a hundred times before anyone read a word of it.
 */

import { redirect, type RequestHandler } from '@sveltejs/kit';
import { createSession, SESSION_COOKIE, sessionCookieAttrs } from '$lib/server/auth';
import { countDemoUsers, createDemoUser } from '$lib/server/demo';
import { clientIp, demoLimiter } from '$lib/server/demo-limit';

export const POST: RequestHandler = ({ cookies, url, request, locals, getClientAddress }) => {
	// CF-Connecting-IP is trusted only in demo mode, where the tunnel is the only
	// way in: HOST is pinned to 127.0.0.1 on a bare host, or the container's port
	// is published on 127.0.0.1 only, so nothing can reach the server without
	// passing through Cloudflare, which sets the header.
	const ip = clientIp({
		authKind: locals.authKind,
		cfHeader: request.headers.get('cf-connecting-ip'),
		fallback: getClientAddress()
	});
	const verdict = demoLimiter.check(ip, countDemoUsers());
	if (verdict !== 'ok') redirect(303, `/signin?demo=${verdict}`);

	const userId = createDemoUser();
	const session = createSession(userId);
	cookies.set(SESSION_COOKIE, session.id, sessionCookieAttrs(url.protocol === 'https:'));
	redirect(303, '/');
};
