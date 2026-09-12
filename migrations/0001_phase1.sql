-- Split — migration 0001: Phase 1 walking skeleton (Spec §13 Phase 1)
--
-- Scope is deliberately narrow: Today + log form + SQLite + one manually
-- created period. Tables for income sources, tranches, allocations, irregulars,
-- trips, debt, rules and reviews arrive in their own phases, in their own
-- migration files. Do not add them here "while you're in there" (Spec §12,
-- over-engineering row).
--
-- Money is ALWAYS integer minor units. Dates are local 'YYYY-MM-DD' strings,
-- never UTC timestamps, for anything the user sees (Spec §5, Spec §12).

PRAGMA foreign_keys = ON;

-- ─── Configuration (single row, id = 1) ──────────────────────────────────
CREATE TABLE settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  currency_code   TEXT    NOT NULL,
  currency_symbol TEXT    NOT NULL,
  minor_units     INTEGER NOT NULL DEFAULT 2,
  -- Band rounding, in minor units. 1000 = nearest ₱10.
  rounding_step   INTEGER NOT NULL DEFAULT 1000,
  period_kind     TEXT    NOT NULL CHECK (period_kind IN ('weekly','semimonthly','monthly')),
  week_starts_on  INTEGER NOT NULL DEFAULT 0,   -- 0 = Sunday
  -- The ×0.85 from Method Part II. Exposed and tunable, never hidden: a
  -- haircut discovered later reads as the app lying to you (Spec §12).
  haircut_pct     INTEGER NOT NULL DEFAULT 15,
  band_pct        INTEGER NOT NULL DEFAULT 10,  -- ±10% display band (Spec §4.2)
  phase           INTEGER NOT NULL DEFAULT 0,
  -- The day boundary. 'Today' is resolved in this zone, not in the server's.
  timezone        TEXT    NOT NULL DEFAULT 'UTC',
  created_at      TEXT    NOT NULL
);

-- ─── The immutable allocation snapshot ───────────────────────────────────
-- Never UPDATE a period's monetary fields. Supersede it (Spec §4.1 stage 3).
-- daily_allowance_minor is written HERE and nowhere else, so that no other
-- code path can move the one number the user trusts (Spec §12).
CREATE TABLE period (
  id                    INTEGER PRIMARY KEY,
  starts_on             TEXT    NOT NULL,
  ends_on               TEXT    NOT NULL,
  days                  INTEGER NOT NULL CHECK (days > 0),
  spend_alloc_minor     INTEGER NOT NULL CHECK (spend_alloc_minor >= 0),
  -- = spend_alloc / days * (1 - haircut).  NOT spend_alloc / days_remaining.
  -- See src/lib/server/allowance.ts for why that distinction is load-bearing.
  daily_allowance_minor INTEGER NOT NULL CHECK (daily_allowance_minor >= 0),
  haircut_pct_applied   INTEGER NOT NULL,   -- frozen; settings may change later
  phase_at_open         INTEGER NOT NULL,
  supersedes_id         INTEGER REFERENCES period(id),
  closed_at             TEXT,
  swept_minor           INTEGER,            -- surplus swept to Irregulars at close
  created_at            TEXT    NOT NULL,
  CHECK (ends_on >= starts_on)
);

-- At most one open, non-superseded period may start on a given day.
CREATE UNIQUE INDEX idx_period_open
  ON period(starts_on) WHERE closed_at IS NULL AND supersedes_id IS NULL;

-- ─── The manual log. Discretionary Spend ONLY ────────────────────────────
-- Bills and Irregulars are never logged here: they are already decided, and
-- logging them dilutes the attention that makes manual tracking work (F6).
CREATE TABLE txn (
  id           INTEGER PRIMARY KEY,
  spent_on     TEXT    NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  category     TEXT    NOT NULL CHECK (category IN
                 ('food_in','food_out','transport','study_work',
                  'health','social','stuff','other')),
  planned      INTEGER NOT NULL CHECK (planned IN (0,1)),  -- the diagnostic flag (F10)
  note         TEXT,                    -- optional, ≤ 60 chars, never required
  period_id    INTEGER REFERENCES period(id),
  entered_at   TEXT    NOT NULL,        -- for the <20s entry-latency metric (G1)
  client_uuid  TEXT    UNIQUE           -- idempotency key; double-submit safe
);
CREATE INDEX idx_txn_date   ON txn(spent_on DESC);
CREATE INDEX idx_txn_period ON txn(period_id, category);

-- ─── Explicit "nothing today" — keeps the streak honest (Spec §4.6) ──────
-- Keyed on a date STRING, which is what makes 23- and 25-hour days ordinary
-- rows rather than special cases (Spec §4.5, Spec §12).
CREATE TABLE log_day (
  logged_on   TEXT PRIMARY KEY,
  entry_count INTEGER NOT NULL DEFAULT 0,
  is_catchup  INTEGER NOT NULL DEFAULT 0,
  closed_at   TEXT NOT NULL
);
