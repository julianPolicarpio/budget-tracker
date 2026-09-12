/**
 * One SQLite file, WAL, in-process. No daemon, no pool, no uptime requirement.
 * For one user writing ~10 rows a day, anything else is a liability (Spec §9).
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

const dbPath = process.env.DATABASE_URL ?? resolve('data', 'split.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });
export { schema };
