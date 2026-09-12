import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * The whole database as JSON.
 *
 * G5 is that this survives five years with no maintenance. Part of that is
 * never being locked in: one file, one endpoint, everything in it, and an
 * import that takes it straight back.
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
	'job_run'
] as const;

export const GET: RequestHandler = () => {
	const data: Record<string, unknown[]> = {};
	for (const table of TABLES) {
		try {
			data[table] = sqlite.prepare(`SELECT * FROM ${table}`).all();
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
