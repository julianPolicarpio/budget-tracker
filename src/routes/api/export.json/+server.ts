import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * One person's whole database as JSON.
 *
 * G5 is that this survives five years with no maintenance. Part of that is
 * never being locked in: one file, one endpoint, everything in it, and an
 * import that takes it straight back.
 *
 * This endpoint read `SELECT * FROM <table>` with no filter until multi-tenancy
 * landed, which was correct when there was one human and catastrophic the
 * moment there were two: any signed-in person could download every other
 * person's complete financial history. It is now scoped, and `subscription` is
 * added to the list — it was missing, so exports have been silently dropping
 * bills since migration 0005.
 */
const TABLES = [
	'settings',
	'period',
	'txn',
	'log_day',
	'review',
	'review_step',
	'account',
	'goal',
	'transfer',
	'irregular',
	'irregular_instance',
	'allocation',
	'phase_change',
	'trip',
	'debt',
	'debt_payment',
	'rule',
	'wait_item',
	'subscription',
	'job_run'
] as const;

export const GET: RequestHandler = ({ locals }) => {
	const data: Record<string, unknown[]> = {};
	for (const table of TABLES) {
		try {
			// Every tenanted table filters. There is no branch here for "global"
			// tables on purpose: if one is ever added to TABLES without a user_id,
			// this throws and the export fails loudly rather than leaking quietly.
			data[table] = sqlite
				.prepare(`SELECT * FROM ${table} WHERE user_id = ?`)
				.all(locals.userId);
		} catch {
			// A table from a migration that has not run yet is absent, not fatal.
			data[table] = [];
		}
	}

	return json(
		{
			format: 'split-export',
			version: 1,
			exportedAt: new Date().toISOString(),
			tables: data
		},
		{
			headers: {
				'content-disposition': `attachment; filename="split-export-${new Date().toISOString().slice(0, 10)}.json"`
			}
		}
	);
};
