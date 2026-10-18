/**
 * Where a request should be sent so it lands on the canonical origin, or null
 * to serve it where it is. Pure, so it can be tested without hooks.server.ts's
 * startup side effects (process.exit, the scheduler).
 *
 * Only GETs are redirected: a POST's Origin header comes from the page that
 * submitted it, so redirecting the POST would not help. See hooks.server.ts.
 *
 * `hostHeader` is the HOST HEADER, not event.url: with ORIGIN set, adapter-node
 * rewrites event.url to the canonical origin, so comparing against it can never
 * differ.
 *
 * /api/health is exempt. The Docker HEALTHCHECK fetches it on 127.0.0.1 and
 * does not follow a redirect to the public host, so redirecting it would make a
 * healthy container report unhealthy. It returns only { ok }, no user data.
 */
export function canonicalRedirect(
	method: string,
	pathname: string,
	search: string,
	hostHeader: string | null,
	origin: string | null
): string | null {
	if (!origin || method !== 'GET' || pathname === '/api/health') return null;
	const want = new URL(origin);
	if (!hostHeader || hostHeader === want.host) return null;
	return new URL(pathname + search, origin).toString();
}
