import { error, json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Restore from an export.
 *
 * Destructive by design — it replaces the contents of every table it carries,
 * because a half-merged database is worse than either version. It refuses
 * anything that is not a Split export, and it runs in one transaction so a
 * failure part-way leaves the original intact.
 *
 * The `?confirm=replace` guard exists because this endpoint is one fetch away
 * from erasing the whole ledger.
 */
const RESTORE_ORDER = [
	'settings',
	'account',
	'goal',
	'period',
	'allocation',
	'irregular',
	'irregular_instance',
	'trip',
	'txn',
	'log_day',
	'review',
	'review_step',
	'transfer',
	'phase_change',
	'debt',
	'debt_payment',
	'rule',
	'wait_item',
	'job_run'
] as const;

export const POST: RequestHandler = async ({ request, url, locals }) => {
	const userId = locals.userId;
	if (url.searchParams.get('confirm') !== 'replace') {
		error(
			400,
			'This replaces all of your data. Re-send with ?confirm=replace if that is what you want.'
		);
	}

	let payload: { format?: string; tables?: Record<string, Record<string, unknown>[]> };
	try {
		payload = await request.json();
	} catch {
		error(400, 'That is not JSON.');
	}

	if (payload?.format !== 'split-export' || !payload.tables) {
		error(422, 'That is not a Split export.');
	}

	const tables = payload.tables;
	const applied: Record<string, number> = {};

	try {
		sqlite.exec('PRAGMA foreign_keys = OFF');
		sqlite.exec('BEGIN');

		// Children first on the way out, parents first on the way in.
		//
		// These DELETEs carried no WHERE clause until multi-tenancy landed. That
		// was merely dramatic with one user and destructive across tenants: an
		// import would have wiped every other account in the system and replaced
		// it with the importer's file. Scoped, "replace everything" means replace
		// everything *of yours*.
		for (const table of [...RESTORE_ORDER].reverse()) {
			try {
				sqlite.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
			} catch {
				// Table absent in this schema version; nothing to clear.
			}
		}

		for (const table of RESTORE_ORDER) {
			const rows = tables[table];
			if (!Array.isArray(rows) || rows.length === 0) {
				applied[table] = 0;
				continue;
			}

			// user_id is taken from the session, never from the file. A payload
			// claiming to own someone else's rows must not be able to write them,
			// so the exported value is dropped and the importer's own id is
			// substituted on every row.
			const columns = Object.keys(rows[0]).filter((c) => c !== 'user_id');
			const stmt = sqlite.prepare(
				`INSERT INTO ${table} (${[...columns, 'user_id'].join(',')}) ` +
					`VALUES (${[...columns, 'user_id'].map(() => '?').join(',')})`
			);
			for (const row of rows) stmt.run([...columns.map((c) => row[c] ?? null), userId]);
			applied[table] = rows.length;
		}

		sqlite.exec('COMMIT');
	} catch (err) {
		sqlite.exec('ROLLBACK');
		error(422, `Import failed and nothing was changed: ${(err as Error).message}`);
	} finally {
		sqlite.exec('PRAGMA foreign_keys = ON');
	}

	return json({ restored: applied });
};
