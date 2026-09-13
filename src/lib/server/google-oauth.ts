/**
 * Google's authorization-code flow (Spec §3.3) — the HTTP half of it.
 *
 * Deliberately no OAuth library. `fetch` for the two calls Google needs and
 * `crypto` for the state token are enough, and a dependency here would sit on
 * the critical path of every sign-in for a personal budgeting app that talks
 * to exactly one external service. `auth.ts` owns sessions, cookies and the
 * single-user escape hatch; this file only knows how to talk to Google.
 */

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

export interface GoogleConfig {
	clientId: string;
	clientSecret: string;
	/** Where this app is reachable, no trailing slash: https://split.example.com */
	origin: string;
}

export interface GoogleProfile {
	/** The stable subject id. This, never the email, is the identity (Spec §3.3). */
	sub: string;
	email: string | null;
	name: string | null;
}

export class GoogleAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GoogleAuthError';
	}
}

function redirectUri(origin: string): string {
	return `${origin}/auth/google/callback`;
}

/** Where to send the browser to start the flow. */
export function buildAuthorizationUrl(config: GoogleConfig, state: string): string {
	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: redirectUri(config.origin),
		response_type: 'code',
		scope: 'openid email profile',
		state,
		access_type: 'online',
		prompt: 'select_account'
	});
	return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

/**
 * Exchange an authorization code for the caller's profile.
 *
 * Two calls: the code buys a token, the token buys an identity. Neither the
 * code, the access token nor an id token is ever returned from here or
 * written anywhere — only `sub`, `email` and `name` survive this function,
 * which is the whole of what the app is allowed to keep (constraint: never
 * log or persist a client secret, an access token, or an id token).
 */
export async function exchangeCodeForProfile(
	config: GoogleConfig,
	code: string
): Promise<GoogleProfile> {
	const tokenRes = await fetch(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code,
			grant_type: 'authorization_code',
			redirect_uri: redirectUri(config.origin)
		})
	});
	if (!tokenRes.ok) {
		throw new GoogleAuthError(`Google token exchange failed with status ${tokenRes.status}`);
	}
	const tokenBody = (await tokenRes.json()) as { access_token?: string };
	if (!tokenBody.access_token) {
		throw new GoogleAuthError('Google token exchange did not return an access token');
	}

	const userRes = await fetch(USERINFO_ENDPOINT, {
		headers: { authorization: `Bearer ${tokenBody.access_token}` }
	});
	if (!userRes.ok) {
		throw new GoogleAuthError(`Google userinfo request failed with status ${userRes.status}`);
	}
	const profile = (await userRes.json()) as { sub?: string; email?: string; name?: string };
	if (!profile.sub) {
		throw new GoogleAuthError('Google userinfo did not return a subject id');
	}

	return { sub: profile.sub, email: profile.email ?? null, name: profile.name ?? null };
}
