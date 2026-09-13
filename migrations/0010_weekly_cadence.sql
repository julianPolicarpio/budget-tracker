-- 0010 — Weekly and fortnightly cadences (Spec §5.1).
--
-- The owner pays for laundry weekly, ₱170 to ₱250 — non-negotiable, and the
-- amount varies. Today that has nowhere honest to live: it is not a
-- subscription (the amount is not fixed) and the `irregular` table rejects
-- any cadence shorter than a month, so it lands in Spend, where a cost the
-- owner cannot decline sits inside the envelope that is supposed to mean
-- "money you chose to spend." `allocations.ts:57` already names this exact
-- failure mode for subscriptions; this migration is what lets an Irregular
-- (or a fixed-amount Subscription) say "weekly" at all.
--
-- Both tables' `cadence` CHECK constraints are widened to add 'weekly' and
-- 'fortnightly':
--
--   subscription.cadence  IN ('monthly','quarterly','semiannual','annual')
--                       -> ('weekly','fortnightly','monthly','quarterly',
--                           'semiannual','annual')
--   irregular.cadence     IN ('one_off','monthly','quarterly','semiannual',
--                              'annual','every_n_years')
--                       -> ('one_off','weekly','fortnightly','monthly',
--                           'quarterly','semiannual','annual','every_n_years')
--
-- Widening the CHECK is necessary but not sufficient — the application-side
-- fix (deleting `CADENCE_MONTHS`, giving cadence a `kind` of 'days' or
-- 'months' in `src/lib/subscription-cadence.ts`, `subscriptions.ts` and
-- `irregulars.ts`) is the harder half and ships alongside this file in the
-- same commit. This migration only makes the schema able to hold what the
-- application can now compute correctly.
--
-- SQLite cannot alter a CHECK constraint in place, so both tables need the
-- full create/copy/drop/rename rebuild — the same recipe `0008_multi_tenant`
-- used for five other tables, copied here rather than reinvented:
--
--   * `scripts/apply-migrations.js` already switches `PRAGMA foreign_keys`
--     OFF around this whole transaction. It cannot be done from inside this
--     file — the pragma is a no-op once a transaction is open — which is
--     exactly why that switch lives in the runner and not here.
--   * `PRAGMA legacy_alter_table = ON` stops `RENAME TO` from "helpfully"
--     rewriting other tables' REFERENCES clauses to point at the temporary
--     `_new` name mid-rebuild.
--   * There is deliberately no `PRAGMA foreign_key_check` in this file — the
--     runner performs it after commit and treats a violation as fatal;
--     running it here via `exec()` would discard the result rows and check
--     nothing.
--
-- Every column, every index, and every existing row is preserved exactly.
-- Both tables carry `user_id` since `0008_multi_tenant`, so both rebuilds
-- carry it forward — dropped from neither table's SELECT list, and both of
-- `idx_subscription_user` / `idx_irregular_user` are recreated afterwards.
-- Padding-percent defaults becoming cadence-aware (Spec §5.3) is an
-- application-layer decision made only when a NEW irregular is created; it
-- touches no column definition and rewrites no existing row, so it needs no
-- migration of its own.

PRAGMA legacy_alter_table = ON;

-- ── subscription ───────────────────────────────────────────────────────────

CREATE TABLE subscription_new (
  id             INTEGER PRIMARY KEY,
  label          TEXT    NOT NULL,
  vendor         TEXT,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  tax_minor      INTEGER          CHECK (tax_minor IS NULL OR tax_minor >= 0),

  -- Widened: 'weekly' and 'fortnightly' join the four calendar cadences.
  cadence        TEXT    NOT NULL CHECK (cadence IN
                   ('weekly','fortnightly','monthly','quarterly','semiannual','annual')),
  next_charge_on TEXT    NOT NULL,
  trial_ends_on  TEXT,
  cancel_by_on   TEXT,
  lead_days      INTEGER NOT NULL DEFAULT 30 CHECK (lead_days > 0),
  alert_stage    INTEGER NOT NULL DEFAULT 0 CHECK (alert_stage BETWEEN 0 AND 2),
  alerted_at     TEXT,
  last_used_on   TEXT,
  category       TEXT,
  note           TEXT,
  created_at     TEXT    NOT NULL,
  cancelled_at   TEXT,
  is_essential   INTEGER NOT NULL DEFAULT 0,
  user_id        INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE
);

INSERT INTO subscription_new
  SELECT id, label, vendor, amount_minor, tax_minor, cadence, next_charge_on,
         trial_ends_on, cancel_by_on, lead_days, alert_stage, alerted_at,
         last_used_on, category, note, created_at, cancelled_at, is_essential,
         user_id
  FROM subscription;

DROP TABLE subscription;
ALTER TABLE subscription_new RENAME TO subscription;

CREATE INDEX idx_subscription_deadline
  ON subscription(cancel_by_on)
  WHERE cancelled_at IS NULL AND cancel_by_on IS NOT NULL;
CREATE INDEX idx_subscription_live
  ON subscription(next_charge_on)
  WHERE cancelled_at IS NULL;
CREATE INDEX idx_subscription_user
  ON subscription(user_id) WHERE cancelled_at IS NULL;

-- ── irregular ───────────────────────────────────────────────────────────────

CREATE TABLE irregular_new (
  id           INTEGER PRIMARY KEY,
  label        TEXT    NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  is_estimate  INTEGER NOT NULL DEFAULT 1,

  -- Widened: 'weekly' and 'fortnightly' join the six existing cadences.
  cadence      TEXT    NOT NULL CHECK (cadence IN
                 ('one_off','weekly','fortnightly','monthly','quarterly','semiannual',
                  'annual','every_n_years')),
  cadence_n    INTEGER,
  next_due_on  TEXT    NOT NULL,
  category     TEXT,
  padding_pct  INTEGER NOT NULL DEFAULT 25,
  created_at   TEXT    NOT NULL,
  archived_at  TEXT,
  user_id      INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE
);

INSERT INTO irregular_new
  SELECT id, label, amount_minor, is_estimate, cadence, cadence_n, next_due_on,
         category, padding_pct, created_at, archived_at, user_id
  FROM irregular;

DROP TABLE irregular;
ALTER TABLE irregular_new RENAME TO irregular;

CREATE INDEX idx_irregular_live ON irregular(next_due_on) WHERE archived_at IS NULL;
CREATE INDEX idx_irregular_user ON irregular(user_id) WHERE archived_at IS NULL;

-- `irregular_instance.irregular_id REFERENCES irregular(id) ON DELETE CASCADE`
-- needs no change: `irregular_instance` is never rebuilt here, and its rows
-- keep referencing the same ids, which the rebuild above preserves exactly
-- via the explicit column list in the INSERT.
