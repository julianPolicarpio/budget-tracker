/**
 * Which date-keyed jobs the scheduler runs. A public demo writes no backups:
 * runBackup writes into <dir of DATABASE_URL>/backups and prunes it, and a
 * demo has no reason to own such a directory.
 *
 * jobs.ts reaches ./db, so DATABASE_URL points at a temp file before the
 * dynamic import.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let jobs: typeof import('./jobs');

beforeAll(async () => {
	process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'split-jobs-')), 'split.db');
	process.env.SPLIT_DISABLE_JOBS = '1';
	jobs = await import('./jobs');
});

describe('scheduledJobKeys', () => {
	it('runs rollover, irregulars and backup outside demo mode', () => {
		expect(jobs.scheduledJobKeys({})).toEqual(['rollover', 'irregulars', 'backup']);
		expect(jobs.scheduledJobKeys({ SPLIT_DEMO_MODE: '0' })).toEqual([
			'rollover',
			'irregulars',
			'backup'
		]);
	});

	it('drops only the backup in demo mode', () => {
		expect(jobs.scheduledJobKeys({ SPLIT_DEMO_MODE: '1' })).toEqual(['rollover', 'irregulars']);
	});
});
