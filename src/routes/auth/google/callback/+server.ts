import { error, redirect } from '@sveltejs/kit';
import {
	resolveAuthMode,
	findOrCreateGoogleUser,
	createSession,
	sessionCookieAttrs,
	SESSION_COOKIE,
	STATE_COOKIE
} from '$lib/server/auth';
import { exchangeCodeForProfile, GoogleAuthError } from '$lib/server/google-oauth';
import type { RequestHandler } from './$types';

/**
 * Google sends the browser back here with `code` and `state`. `state` must
 * match the cookie `/auth/google` set — anything else is a forged or replayed
 * callback and is refused before Google is ever contacted (Spec §3.3).
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const mode = resolveAuthMode();
	if (mode.kind !== 'google') redirect(303, '/');

	const expectedState = cookies.get(STATE_COOKIE);
	cookies.delete(STATE_COOKIE, { path: '/' });

	const state = url.searchParams.get('state');
	const code = url.searchParams.get('code');

	if (!code || !state || !expectedState || state !== expectedState) {
		error(400, 'Sign-in could not be verified. Go back and try again.');
	}

	let profile;
	try {
		profile = await exchangeCodeForProfile(mode, code);
	} catch (err) {
		console.error(
			'[auth] Google sign-in failed:',
			err instanceof GoogleAuthError ? err.message : err
		);
		error(502, 'Google did not confirm your identity. Try again.');
	}

	const { userId } = findOrCreateGoogleUser(profile);
	const session = createSession(userId);
	cookies.set(SESSION_COOKIE, session.id, sessionCookieAttrs(url.protocol === 'https:'));

	redirect(303, '/');
};
