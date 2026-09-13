import { redirect } from '@sveltejs/kit';
import {
	resolveAuthMode,
	createStateToken,
	stateCookieAttrs,
	STATE_COOKIE
} from '$lib/server/auth';
import { buildAuthorizationUrl } from '$lib/server/google-oauth';
import type { RequestHandler } from './$types';

/**
 * Start the Google round trip. `state` is random and stored in a short-lived
 * cookie so the callback can refuse a request that did not originate here
 * (Spec §3.3's CSRF guard).
 */
export const GET: RequestHandler = ({ url, cookies }) => {
	const mode = resolveAuthMode();
	// No sign-in configured means single-user mode already attributes every
	// request to the owner — there is nothing to sign in to.
	if (mode.kind !== 'google') redirect(303, '/');

	const state = createStateToken();
	cookies.set(STATE_COOKIE, state, stateCookieAttrs(url.protocol === 'https:'));

	redirect(303, buildAuthorizationUrl(mode, state));
};
