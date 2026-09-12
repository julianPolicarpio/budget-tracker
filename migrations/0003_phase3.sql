-- Split — migration 0003: Phase 3, irregulars & phases (Spec §13 Phase 3)
--
-- The irregulars engine is the subsystem that separates people who "budget"
-- from people whose budget survives contact with reality (F10), and Spec §4.3
-- calls it the one that determines whether the system sees year two.
--
-- Still absent, on purpose: trips, debt, if-then rules, the 72-hour list, the
-- setup wizard, income sources. See the note on income at the bottom.

PRAGMA foreign_keys = ON;

-- ─── The metric quarantine, shipped early (Spec §13 Phase 3) ─────────────
-- Trip Mode is Phase 4, but the column and the query-layer default go in now,
-- while there are three metric queries instead of fifteen. Retrofitting it
-- after the trends grid exists means auditing every query and re-deriving
-- historical numbers.
--
-- NOTE: no `REFERENCES trip(id)` here, despite Spec §5 showing one. SQLite
-- accepts a forward reference at ALTER time and then fails *every* INSERT into
-- txn with "no such table: main.trip" — including rows where trip_id is NULL.
-- Phase 4 creates the trip table and adds the constraint by table rebuild.
ALTER TABLE txn ADD COLUMN trip_id INTEGER;
ALTER TABLE txn ADD COLUMN amount_local_minor INTEGER;
ALTER TABLE txn ADD COLUMN fx_rate_used REAL;

-- Metric indexes are trip-filtered to match the quarantine default.
CREATE INDEX idx_txn_metrics ON txn(spent_on, category) WHERE trip_id IS NULL;
CREATE INDEX idx_txn_unplanned ON txn(spent_on) WHERE planned = 0 AND trip_id IS NULL;
CREATE INDEX idx_txn_trip ON txn(trip_id, spent_on) WHERE trip_id IS NOT NULL;

-- ─── The five accounts (six rows; Grow is the fifth's second life) ───────
CREATE TABLE account (
  id            INTEGER PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN
                  ('inflow','bills','spend','irregulars','buffer','grow')),
  institution   TEXT,                       -- free text; the "different bank" reminder
  is_committed  INTEGER NOT NULL DEFAULT 0, -- 1 = deliberately inconvenient (F3)
  has_card      INTEGER NOT NULL DEFAULT 0,
  balance_minor INTEGER NOT NULL DEFAULT 0, -- last user-asserted balance (Q3)
  balance_as_of TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT
);

INSERT INTO account (id, slug, name, kind, is_committed, has_card, sort_order) VALUES
  (1,'inflow',     'Inflow',     'inflow',     0, 0, 1),
  (2,'bills',      'Bills',      'bills',      0, 0, 2),
  -- The only account with a card, and it is debit. Credit runs the
  -- willingness-to-pay premium up to 100% (F11).
  (3,'spend',      'Spend',      'spend',      0, 1, 3),
  (4,'irregulars', 'Irregulars', 'irregulars', 0, 0, 4),
  -- Different institution, no card, ideally a withdrawal delay. The friction
  -- is the feature (F3) — 28% take-up, +82% balances at twelve months.
  (5,'buffer',     'Buffer',     'buffer',     1, 0, 5),
  (6,'grow',       'Grow',       'grow',       1, 0, 6);

-- ─── Named goals: fine partitioning of the SAVINGS side only (F4) ────────
-- "Rent if I lose my job" saves more than "Buffer"; "Japan, March" more than
-- "Travel". Partitioning was worth roughly a third more saved. This is the one
-- place in the app where subdividing is correct — the spending pool stays whole.
CREATE TABLE goal (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES account(id),
  label        TEXT    NOT NULL,
  target_minor INTEGER,
  saved_minor  INTEGER NOT NULL DEFAULT 0,
  image_ref    TEXT,
  target_date  TEXT,
  status       TEXT    NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','reached','abandoned')),
  created_at   TEXT    NOT NULL
);
CREATE INDEX idx_goal_account ON goal(account_id) WHERE status = 'active';

-- ─── Rule 3: every withdrawal from savings carries an IOU ────────────────
-- Straight from the winning arm of the Drexler trial. The note is the entire
-- mechanism: it turns an invisible leak into a countable event, and at the
-- quarterly review you read the list. Seeing four in a row does more than any
-- rule prohibiting the transfer would have.
CREATE TABLE transfer (
  id              INTEGER PRIMARY KEY,
  moved_on        TEXT    NOT NULL,
  from_account_id INTEGER NOT NULL REFERENCES account(id),
  to_account_id   INTEGER NOT NULL REFERENCES account(id),
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  iou_reason      TEXT,                      -- REQUIRED when from = irregulars|buffer|grow
  iou_repay_by    TEXT,
  repaid_at       TEXT,
  created_at      TEXT    NOT NULL,
  CHECK (from_account_id <> to_account_id)
);
CREATE INDEX idx_transfer_open_iou
  ON transfer(moved_on) WHERE iou_reason IS NOT NULL AND repaid_at IS NULL;

-- ─── Irregulars ──────────────────────────────────────────────────────────
CREATE TABLE irregular (
  id           INTEGER PRIMARY KEY,
  label        TEXT    NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),  -- BEFORE padding
  is_estimate  INTEGER NOT NULL DEFAULT 1,
  cadence      TEXT    NOT NULL CHECK (cadence IN
                 ('one_off','monthly','quarterly','semiannual','annual','every_n_years')),
  cadence_n    INTEGER,                       -- years, for every_n_years
  next_due_on  TEXT    NOT NULL,
  category     TEXT,
  -- The mandatory +25% (F10). People underestimate weekly spending by ~30%,
  -- and exclude exceptional costs entirely because each feels like a one-off
  -- while in aggregate they are perfectly predictable. Not negotiable downward.
  padding_pct  INTEGER NOT NULL DEFAULT 25,
  created_at   TEXT    NOT NULL,
  archived_at  TEXT
);
CREATE INDEX idx_irregular_live ON irregular(next_due_on) WHERE archived_at IS NULL;

CREATE TABLE irregular_instance (
  id             INTEGER PRIMARY KEY,
  irregular_id   INTEGER NOT NULL REFERENCES irregular(id) ON DELETE CASCADE,
  due_on         TEXT    NOT NULL,
  expected_minor INTEGER NOT NULL,           -- includes padding
  -- Stored separately from expected on purpose: the delta is the honest
  -- measure of your prediction bias and it feeds the annual re-estimate.
  actual_minor   INTEGER,
  status         TEXT    NOT NULL DEFAULT 'projected'
                   CHECK (status IN ('projected','due','settled','skipped','rescheduled')),
  settled_on     TEXT,
  UNIQUE (irregular_id, due_on)
);
CREATE INDEX idx_ii_due ON irregular_instance(due_on) WHERE status IN ('projected','due');
CREATE INDEX idx_ii_settled ON irregular_instance(settled_on) WHERE status = 'settled';

-- ─── Per-period allocations to each account ──────────────────────────────
-- A `planned` allocation with no executed_at is money the app believes is
-- somewhere it is not. Spec §4.1 surfaces it on Today after 48 hours, because
-- an unexecuted split silently invalidates every downstream number.
CREATE TABLE allocation (
  id           INTEGER PRIMARY KEY,
  period_id    INTEGER NOT NULL REFERENCES period(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES account(id),
  amount_minor INTEGER NOT NULL,
  executed_at  TEXT,
  UNIQUE (period_id, account_id)
);
CREATE INDEX idx_allocation_pending ON allocation(period_id) WHERE executed_at IS NULL;

-- ─── Phase proposals (Spec §4.4) ─────────────────────────────────────────
-- The engine proposes; it never auto-advances. A phase change reallocates
-- someone's money, and doing that silently is unacceptable regardless of
-- whether the arithmetic is right.
CREATE TABLE phase_change (
  id          INTEGER PRIMARY KEY,
  from_phase  INTEGER NOT NULL,
  to_phase    INTEGER NOT NULL,
  proposed_on TEXT    NOT NULL,
  rationale   TEXT    NOT NULL,       -- the arithmetic, shown to the user
  accepted_at TEXT,
  declined_at TEXT,
  UNIQUE (from_phase, to_phase, proposed_on)
);

-- ─── A note on income sources ────────────────────────────────────────────
-- Spec §4.1 and §6.1c describe income_source, projectArrivals() and the
-- ordered waterfall in detail, but Spec §13's roadmap never assigns them to a
-- phase: Phase 1 is "one manually-created period", Phase 3 is "irregulars &
-- phases", Phase 4 is "trips, debt, trends & polish". This migration follows
-- the roadmap and leaves them out rather than quietly widening the phase.
--
-- The consequence is visible, not hidden: save rate stays NULL on the review
-- snapshot, and rollover keeps carrying the allocation forward instead of
-- projecting arrivals. Both say so in the UI.
