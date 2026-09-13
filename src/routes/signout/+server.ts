import { redirect } from '@sveltejs/kit';
import { deleteSession, SESSION_COOKIE } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/** Sign out: delete the session row and clear the cookie. POST, not a link — it is destructive. */
export const POST: RequestHandler = ({ cookies }) => {
	const sessionId = cookies.get(SESSION_COOKIE);
	if (sessionId) deleteSession(sessionId);
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/signin');
};
