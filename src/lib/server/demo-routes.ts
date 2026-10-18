import { isDemoHidden } from '$lib/nav/demo';

/**
 * Only page loads (GET/HEAD) are redirected: the typing bar posts to
 * `route?/action` on hidden paths, so POSTs must still reach them.
 */
export function demoRedirect(method: string, pathname: string, authKind: string): string | null {
	if (authKind !== 'demo') return null;
	if (method !== 'GET' && method !== 'HEAD') return null;
	return isDemoHidden(pathname) ? '/' : null;
}
