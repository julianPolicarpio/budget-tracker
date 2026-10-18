import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../scripts/apply-migrations.js';

// Must precede every server import: db/index.ts refuses the live database under Vitest.
process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-layout-')), 'split.db');
process.env.SPLIT_DISABLE_JOBS = '1';

let load: typeof import('./+layout.server').load;

beforeAll(async () => {
	const db = await import('$lib/server/db');
	applyMigrations(db.sqlite, resolve('migrations'));
	load = (await import('./+layout.server')).load;
});

function run(authKind: string) {
	return (load as unknown as (e: unknown) => { demo: boolean })({
		locals: { userId: 1, authKind }
	});
}

describe('root layout load', () => {
	it('flags demo only for the demo auth kind', () => {
		expect(run('demo').demo).toBe(true);
		expect(run('google').demo).toBe(false);
		expect(run('single-user').demo).toBe(false);
	});
});
