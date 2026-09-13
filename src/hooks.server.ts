import type { Handle } from '@sveltejs/kit';
import { startScheduler } from '$lib/server/jobs';

// One process, one scheduler. Rollover and backup are idempotent and keyed by
// date, so this is safe on every restart (Spec §3).
startScheduler();

/**
 * A2 REPLACES THIS with a real session lookup. Until sign-in exists there is
 * exactly one account (Spec §3.2's app_user id 1, seeded by migration 0008),
 * so every request is attributed to it here, in this one place, rather than
 * defaulting quietly inside the database layer.
 */
export const handle: Handle = ({ event, resolve }) => {
	event.locals.userId = 1;
	return resolve(event);
};
