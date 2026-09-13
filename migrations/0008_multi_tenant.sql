-- 0008 — More than one person.
--
-- Until now network isolation WAS the auth boundary. There was no login and no
-- tenancy column because there was exactly one human, and `scripts/serve.js`
-- refused to bind anywhere a stranger could reach. That is invariant 10, and
-- the owner has decided to reverse it: Split becomes a public web app.
--
-- The security that isolation gave for free is now replaced by code, and code
-- has bugs. The entire risk of that trade sits in one failure mode: a query
-- that forgets its user_id shows a stranger someone else's financial history.
-- This migration is the first of three layers against it (spec §3.2) — the one
-- that makes an unowned row impossible to represent at all. `user_id` is
-- NOT NULL everywhere, so there is no such thing as a row without an owner.
--
-- Seven unique constraints were global and every one breaks with two users.
-- Five of them are column- or table-level and need a full table rebuild; a
-- sixth table, settings, is rebuilt for a different reason given below.
-- SQLite cannot drop a constraint in place. Two are indexes and are simply
-- dropped and recreated. Enumerated from the live schema rather than from
-- memory, because the first draft of the spec found only four:
--
--   account.slug            both users have a bucket called 'spend'
--   log_day PK              both log on the same date
--   job_run PK              rollover runs once per date, for everyone
--   review(kind,label)      both have a weekly review for '2026-W33'
--   phase_change(...)       both advance 0->1 on the same day
--   idx_period_open         both open a period on the same Monday
--   idx_trip_active         ONE person in the whole system may travel at a time
--
-- Three constraints are already scoped through a parent row and are left
-- alone: review_step(review_id, step_key), irregular_instance(irregular_id,
-- due_on), allocation(period_id, account_id). txn.client_uuid stays globally
-- unique — it is a UUID, and scoping it buys nothing.
--
-- ON THE PRAGMAS. Foreign keys are OFF for the whole of this file, switched
-- off by scripts/apply-migrations.js around the transaction — `PRAGMA
-- foreign_keys` is a no-op inside one, so it cannot be done from here. That is
-- what the twelve-step rebuild requires, and it is also the only way SQLite
-- will accept ADD COLUMN carrying both a REFERENCES clause and a non-NULL
-- default. `legacy_alter_table` stops RENAME TO from helpfully rewriting the
-- REFERENCES clauses of other tables to point at the temporary name mid-rebuild.
--
-- There is deliberately no `PRAGMA foreign_key_check` at the end of this file.
-- It would do nothing: exec() discards result rows, so the violations it finds
-- are thrown away. The runner performs that check after the commit and treats
-- a violation as fatal.
--
-- Every existing row becomes user 1 in this same transaction, so the database
-- never passes through a state where data exists without an owner.
--
-- ON `DEFAULT 1`, WHICH IS A COMPROMISE AND SHOULD BE READ AS ONE. SQLite
-- cannot add a NOT NULL column without a non-NULL default, so the fourteen
-- appended columns must carry one; and removing a default afterwards needs yet
-- another rebuild of all fourteen. The six rebuilt tables take the same default
-- so that one rule describes the whole schema instead of five exceptions.
--
-- The hazard is real and worth naming: with a default in place, an INSERT that
-- forgets user_id does not fail loudly. It silently files a stranger's row into
-- the owner's account. That is the tenancy leak running backwards.
--
-- What actually prevents it is not this column, it is forUser() in
-- src/lib/server/db/index.ts: the unscoped connection is never exported, so
-- there is no insert path that can omit the id. The default is a backfill
-- device and a backstop that should never fire. If it ever does, the
-- two-tenant leak test is what catches it.
--
-- Column position: user_id is the LAST column on every table. ALTER TABLE ADD
-- COLUMN can only append, so putting it last on the rebuilt tables too keeps
-- one rule instead of twenty exceptions.

PRAGMA legacy_alter_table = ON;

-- ── The person ────────────────────────────────────────────────────────────
--
-- Named app_user, never `account`: `account` already means a money bucket in
-- this schema (Spend, Bills, Irregulars) and reusing it would make every join
-- ambiguous to read.
--
-- google_sub is the stable Google subject id, not the email, because emails
-- change hands. It is nullable here and populated by A2, which adds sign-in;
-- this migration deliberately ships no authentication.

CREATE TABLE app_user (
  id           INTEGER PRIMARY KEY,
  google_sub   TEXT UNIQUE,
  email        TEXT,
  display_name TEXT,
  created_at   TEXT    NOT NULL,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);

INSERT INTO app_user (id, google_sub, email, display_name, created_at, is_demo)
VALUES (1, NULL, NULL, 'Owner', '2026-09-13T00:00:00.000Z', 0);

-- ── Rebuilds: five tables whose unique constraints were global ────────────

-- account: slug was globally UNIQUE, so a second user could not have a bucket
-- called 'spend'.
CREATE TABLE account_new (
  id            INTEGER PRIMARY KEY,
  slug          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN
                  ('inflow','bills','spend','irregulars','buffer','grow')),
  institution   TEXT,
  is_committed  INTEGER NOT NULL DEFAULT 0,
  has_card      INTEGER NOT NULL DEFAULT 0,
  balance_minor INTEGER NOT NULL DEFAULT 0,
  balance_as_of TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT,
  user_id       INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE,
  UNIQUE (user_id, slug)
);
INSERT INTO account_new
  SELECT id, slug, name, kind, institution, is_committed, has_card,
         balance_minor, balance_as_of, sort_order, archived_at, 1
  FROM account;
DROP TABLE account;
ALTER TABLE account_new RENAME TO account;

-- log_day: the date alone was the primary key.
CREATE TABLE log_day_new (
  logged_on   TEXT    NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  is_catchup  INTEGER NOT NULL DEFAULT 0,
  closed_at   TEXT    NOT NULL,
  user_id     INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, logged_on)
);
INSERT INTO log_day_new
  SELECT logged_on, entry_count, is_catchup, closed_at, 1 FROM log_day;
DROP TABLE log_day;
ALTER TABLE log_day_new RENAME TO log_day;

-- job_run: idempotency is per user per date, not per date. One user's
-- rollover must not mark the job done for everybody else.
CREATE TABLE job_run_new (
  job_key  TEXT    NOT NULL,
  ran_for  TEXT    NOT NULL,
  ran_at   TEXT    NOT NULL,
  detail   TEXT,
  user_id  INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, job_key, ran_for)
);
INSERT INTO job_run_new SELECT job_key, ran_for, ran_at, detail, 1 FROM job_run;
DROP TABLE job_run;
ALTER TABLE job_run_new RENAME TO job_run;

-- review: '2026-W33' is a label every user has once a year.
CREATE TABLE review_new (
  id                  INTEGER PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN
                        ('weekly','monthly','quarterly','annual')),
  period_label        TEXT NOT NULL,
  starts_on           TEXT NOT NULL,
  ends_on             TEXT NOT NULL,
  completed_at        TEXT,
  spend_balance_minor INTEGER,
  irregulars_minor    INTEGER,
  buffer_minor        INTEGER,
  debt_total_minor    INTEGER,
  total_spent_minor   INTEGER,
  unplanned_ratio_bp  INTEGER,
  buffer_weeks_x100   INTEGER,
  coverage_ratio_bp   INTEGER,
  save_rate_bp        INTEGER,
  log_adherence_bp    INTEGER,
  streak_at_close     INTEGER,
  summary_line        TEXT,
  shared_at           TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL,
  user_id             INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE,
  UNIQUE (user_id, kind, period_label)
);
INSERT INTO review_new
  SELECT id, kind, period_label, starts_on, ends_on, completed_at,
         spend_balance_minor, irregulars_minor, buffer_minor, debt_total_minor,
         total_spent_minor, unplanned_ratio_bp, buffer_weeks_x100,
         coverage_ratio_bp, save_rate_bp, log_adherence_bp, streak_at_close,
         summary_line, shared_at, notes, created_at, 1
  FROM review;
DROP TABLE review;
ALTER TABLE review_new RENAME TO review;
CREATE INDEX idx_review_window ON review(user_id, kind, ends_on DESC);

-- phase_change: two users advancing 0->1 on the same day is ordinary, not a
-- duplicate.
CREATE TABLE phase_change_new (
  id          INTEGER PRIMARY KEY,
  from_phase  INTEGER NOT NULL,
  to_phase    INTEGER NOT NULL,
  proposed_on TEXT    NOT NULL,
  rationale   TEXT    NOT NULL,
  accepted_at TEXT,
  declined_at TEXT,
  user_id     INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE,
  UNIQUE (user_id, from_phase, to_phase, proposed_on)
);
INSERT INTO phase_change_new
  SELECT id, from_phase, to_phase, proposed_on, rationale, accepted_at,
         declined_at, 1
  FROM phase_change;
DROP TABLE phase_change;
ALTER TABLE phase_change_new RENAME TO phase_change;

-- settings: a HARD singleton, `id INTEGER PRIMARY KEY CHECK (id = 1)`. Adding
-- a column and a unique index is not enough and was the first draft's mistake:
-- the CHECK rejects a second row outright, so a second user could not hold
-- settings at all and sign-up in A2 would have been impossible. The constraint
-- has to go, which means a rebuild.
--
-- The singleton property it was protecting is real and is kept, moved to where
-- it now belongs: one settings row per person, enforced by idx_settings_user
-- below rather than by pinning the primary key to a literal.
CREATE TABLE settings_new (
  id              INTEGER PRIMARY KEY,
  currency_code   TEXT    NOT NULL,
  currency_symbol TEXT    NOT NULL,
  minor_units     INTEGER NOT NULL DEFAULT 2,
  rounding_step   INTEGER NOT NULL DEFAULT 1000,
  period_kind     TEXT    NOT NULL CHECK (period_kind IN ('weekly','semimonthly','monthly')),
  week_starts_on  INTEGER NOT NULL DEFAULT 0,
  haircut_pct     INTEGER NOT NULL DEFAULT 15,
  band_pct        INTEGER NOT NULL DEFAULT 10,
  phase           INTEGER NOT NULL DEFAULT 0,
  timezone        TEXT    NOT NULL DEFAULT 'UTC',
  created_at      TEXT    NOT NULL,
  weekly_take_home_minor INTEGER,
  user_id         INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE
);
INSERT INTO settings_new
  SELECT id, currency_code, currency_symbol, minor_units, rounding_step,
         period_kind, week_starts_on, haircut_pct, band_pct, phase, timezone,
         created_at, weekly_take_home_minor, 1
  FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

-- ── The other fourteen: the column appends ────────────────────────────────
--
-- DEFAULT 1 does double duty. It backfills every existing row to the owner in
-- the same statement that adds the column, and SQLite requires a non-NULL
-- default when adding a NOT NULL column. A2 sets user_id explicitly on insert;
-- the default is a migration device, not an application default to rely on.

ALTER TABLE allocation         ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE debt               ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE debt_payment       ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE goal               ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE irregular          ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE irregular_instance ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE period             ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE rule               ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE subscription       ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE transfer           ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE trip               ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE txn                ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE wait_item          ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE review_step        ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE;

-- ── The two partial unique indexes ───────────────────────────────────────
--
-- Both encoded "only one of these may exist" as a global truth. Scoped, they
-- say the thing that was actually meant: only one per person.

DROP INDEX idx_period_open;
CREATE UNIQUE INDEX idx_period_open
  ON period(user_id, starts_on) WHERE closed_at IS NULL AND supersedes_id IS NULL;

DROP INDEX idx_trip_active;
CREATE UNIQUE INDEX idx_trip_active
  ON trip(user_id, status) WHERE status = 'active';

-- settings was a singleton addressed as `WHERE id = 1` in at least five
-- places. It becomes one row per person, enforced here rather than by
-- convention.
CREATE UNIQUE INDEX idx_settings_user ON settings(user_id);

-- ── Tenancy-aware lookups ────────────────────────────────────────────────
--
-- Every hot read now filters on user_id first. Without these the scoped
-- selectors added in this task turn full-table scans into the normal case.

CREATE INDEX idx_txn_user_date      ON txn(user_id, spent_on DESC);
CREATE INDEX idx_period_user        ON period(user_id, starts_on DESC);
CREATE INDEX idx_log_day_user       ON log_day(user_id, logged_on DESC);
CREATE INDEX idx_subscription_user  ON subscription(user_id) WHERE cancelled_at IS NULL;
CREATE INDEX idx_irregular_user     ON irregular(user_id) WHERE archived_at IS NULL;
