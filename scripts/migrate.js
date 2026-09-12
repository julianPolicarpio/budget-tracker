#!/usr/bin/env node
// Applies every .sql file in ./migrations, in filename order, exactly once.
//
// Migrations are real SQL files, readable and reviewable — there is no silent
// schema push in anything that touches real data (working agreement).

import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DATABASE_URL ?? join(root, 'data', 'split.db');
const migrationsDir = join(root, 'migrations');

mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`CREATE TABLE IF NOT EXISTS _migration (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`);

const applied = new Set(
	db
		.prepare('SELECT name FROM _migration')
		.all()
		.map((r) => r.name)
);
const files = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort();

let count = 0;
for (const file of files) {
	if (applied.has(file)) continue;
	const sql = readFileSync(join(migrationsDir, file), 'utf8');
	// One transaction per migration: a half-applied schema is worse than none.
	db.exec('BEGIN');
	try {
		db.exec(sql);
		db.prepare('INSERT INTO _migration (name, applied_at) VALUES (?, ?)').run(
			file,
			new Date().toISOString()
		);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		console.error(`✗ ${file}\n${err.message}`);
		process.exit(1);
	}
	console.log(`✓ applied ${file}`);
	count++;
}

console.log(count === 0 ? `up to date (${files.length} migrations)` : `applied ${count}`);
console.log(`db: ${dbPath}`);
db.close();
