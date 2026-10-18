/**
 * Screens a public-demo visitor is not shown. Only page loads (GET/HEAD) are
 * redirected: the typing bar posts to `route?/action` on these same paths, so
 * POSTs must still reach them.
 */
const HIDDEN_PREFIXES = [
	'/accounts',
	'/irregulars',
	'/subscriptions',
	'/trips',
	'/debt',
	'/rules',
	'/trends',
	'/settings',
	'/setup'
] as const;

export function demoRedirect(method: string, pathname: string, authKind: string): string | null {
	if (authKind !== 'demo') return null;
	if (method !== 'GET' && method !== 'HEAD') return null;
	const hidden = HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
	return hidden ? '/' : null;
}
