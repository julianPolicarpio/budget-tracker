import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Container health. Deliberately shallow: it proves the process is up and the
 * database answers, and nothing more. A health check that runs real queries
 * becomes a load source and a source of false alarms.
 *
 * It returns no financial data — this is the one endpoint whose whole job is
 * to be polled by something that has not authenticated.
 */
export const GET: RequestHandler = () => {
	try {
		sqlite.prepare('SELECT 1').get();
		return json({ ok: true });
	} catch (err) {
		// The caller is unauthenticated: log the reason here, never send it.
		console.error(`[split] health check failed: ${(err as Error).message}`);
		return json({ ok: false }, { status: 503 });
	}
};
