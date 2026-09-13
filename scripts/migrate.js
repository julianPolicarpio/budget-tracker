#!/usr/bin/env node
// Applies every .sql file in ./migrations, in filename order, exactly once.
//
// Migrations are real SQL files, readable and reviewable — there is no silent
// schema push in anything that touches real data (working agreement).

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { applyMigrations } from './apply-migrations.js';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DATABASE_URL ?? join(root, 'data', 'split.db');
const migrationsDir = join(root, 'migrations');

mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const count = applyMigrations(db, migrationsDir, (f) => console.log(`✓ applied ${f}`));

console.log(count === 0 ? `up to date (${files.length} migrations)` : `applied ${count}`);
console.log(`db: ${dbPath}`);
db.close();
