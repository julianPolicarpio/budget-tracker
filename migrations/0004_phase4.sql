-- Split — migration 0004: Phase 4 (Spec §13 Phase 4)
--
-- Trip Mode, debt, if-then rules and the 72-hour list.
--
-- Travel is the most likely thing to break this app in real use (Spec §4.5):
-- the daily band goes red for the whole trip, the unplanned ratio spikes to
-- ~90%, the rolling averages carry a smear for three months afterwards, and
-- the streak starts feeling punitive at exactly the point where people abandon
-- the system. The resolving idea is one sentence:
--
--     A trip is not a spending period. It is a funded irregular being drawn
--     down.

PRAGMA foreign_keys = ON;

-- ─── Trips ───────────────────────────────────────────────────────────────
CREATE TABLE trip (
  id                    INTEGER PRIMARY KEY,
  label                 TEXT    NOT NULL,
  starts_on             TEXT    NOT NULL,
  ends_on               TEXT    NOT NULL,
  -- The day boundary follows your body, not your bank. Transition days are
  -- allowed to be 23 or 25 hours; log_day is keyed on a date string, so a
  -- short day is an ordinary row and a long day is an ordinary row.
  trip_tz               TEXT    NOT NULL,
  currency_code         TEXT    NOT NULL,
  currency_symbol       TEXT    NOT NULL,
  -- MUST NOT inherit settings.minor_units. JPY/KRW/VND = 0, most = 2,
  -- KWD/BHD/JOD = 3. A wrong value here is a silent 100x entry error on the
  -- first purchase abroad, in an unfamiliar currency, with no intuition to
  -- catch it.
  local_minor_units     INTEGER NOT NULL CHECK (local_minor_units BETWEEN 0 AND 3),
  -- The EFFECTIVE rate the user actually got, including ATM and card FX fees
  -- — not mid-market. Those fees run several percent, far larger than rate
  -- drift over two weeks, so a live mid-market rate would be *less* accurate
  -- than this locked one. No FX API, by design.
  fx_rate_to_home       REAL    NOT NULL CHECK (fx_rate_to_home > 0),
  envelope_minor        INTEGER NOT NULL CHECK (envelope_minor >= 0),
  irregular_instance_id INTEGER REFERENCES irregular_instance(id),
  buffer_draw_minor     INTEGER NOT NULL DEFAULT 0,
  status                TEXT    NOT NULL DEFAULT 'planned'
                          CHECK (status IN ('planned','active','settled','cancelled')),
  -- Settle takes TWO numbers and their difference is the point:
  --   envelope - logged  = estimate error   (did the trip cost what I thought)
  --   actual   - logged  = FX and fee error (was my rate right)
  -- Different failures, different fixes. Conflating them improves neither.
  logged_total_minor    INTEGER,
  actual_minor          INTEGER,
  settled_on            TEXT,
  created_at            TEXT    NOT NULL,
  CHECK (ends_on >= starts_on)
);

-- At most one active trip. Overlapping trips are a data-entry error, not a
-- feature.
CREATE UNIQUE INDEX idx_trip_active ON trip(status) WHERE status = 'active';
CREATE INDEX idx_trip_dates ON trip(starts_on) WHERE status IN ('planned', 'active');

-- ─── txn.trip_id gains its foreign key ───────────────────────────────────
-- Phase 3 added the column bare because SQLite accepts a forward reference at
-- ALTER time and then fails every INSERT with "no such table: main.trip",
-- including rows where the column is NULL. The trip table exists now, so the
-- constraint goes on by table rebuild — the standard SQLite pattern.
PRAGMA foreign_keys = OFF;

CREATE TABLE txn_new (
  id            INTEGER PRIMARY KEY,
  spent_on      TEXT    NOT NULL,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  category      TEXT    NOT NULL CHECK (category IN
                  ('food_in','food_out','transport','study_work',
                   'health','social','stuff','other')),
  planned       INTEGER NOT NULL CHECK (planned IN (0,1)),
  note          TEXT,
  period_id     INTEGER REFERENCES period(id),
  entered_at    TEXT    NOT NULL,
  client_uuid   TEXT    UNIQUE,
  trip_id            INTEGER REFERENCES trip(id),
  -- Source of truth for trip transactions. amount_minor (home) is DERIVED.
  -- Getting this backwards means a rate correction silently rewrites history.
  amount_local_minor INTEGER,
  fx_rate_used       REAL
);

INSERT INTO txn_new (id, spent_on, amount_minor, category, planned, note, period_id,
                     entered_at, client_uuid, trip_id, amount_local_minor, fx_rate_used)
  SELECT id, spent_on, amount_minor, category, planned, note, period_id,
         entered_at, client_uuid, trip_id, amount_local_minor, fx_rate_used
  FROM txn;

DROP TABLE txn;
ALTER TABLE txn_new RENAME TO txn;

CREATE INDEX idx_txn_date      ON txn(spent_on DESC);
CREATE INDEX idx_txn_period    ON txn(period_id, category);
CREATE INDEX idx_txn_metrics   ON txn(spent_on, category) WHERE trip_id IS NULL;
CREATE INDEX idx_txn_unplanned ON txn(spent_on) WHERE planned = 0 AND trip_id IS NULL;
CREATE INDEX idx_txn_trip      ON txn(trip_id, spent_on) WHERE trip_id IS NOT NULL;

PRAGMA foreign_keys = ON;

-- ─── Debt ────────────────────────────────────────────────────────────────
CREATE TABLE debt (
  id                INTEGER PRIMARY KEY,
  label             TEXT    NOT NULL,
  balance_minor     INTEGER NOT NULL CHECK (balance_minor >= 0),
  apr_bp            INTEGER NOT NULL,      -- basis points: 1850 = 18.5%
  min_payment_minor INTEGER NOT NULL CHECK (min_payment_minor >= 0),
  opened_on         TEXT,
  closed_on         TEXT
);
CREATE INDEX idx_debt_live ON debt(apr_bp DESC) WHERE closed_on IS NULL;

CREATE TABLE debt_payment (
  id           INTEGER PRIMARY KEY,
  debt_id      INTEGER NOT NULL REFERENCES debt(id) ON DELETE CASCADE,
  paid_on      TEXT    NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0)
);
CREATE INDEX idx_debt_payment ON debt_payment(debt_id, paid_on DESC);

-- ─── If-then plans (F8) ──────────────────────────────────────────────────
-- Implementation intentions run at d = 0.65 across 94 tests and 8,000+
-- participants — the largest effect size in the whole plan. The cue must be a
-- concrete detectable event and the response must start within seconds of it.
--
-- These ship pre-populated because a blank rules page gets zero rules written,
-- and zero rules is zero effect (Appendix A).
CREATE TABLE rule (
  id          INTEGER PRIMARY KEY,
  cue         TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  category    TEXT    CHECK (category IN
                ('adherence','overspend','structural','social','travel','motivation')),
  fired_count INTEGER NOT NULL DEFAULT 0,
  last_fired  TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- ─── The 72-hour list (Rule 4) ───────────────────────────────────────────
-- Most items die on the list. The ones that survive are genuinely wanted, and
-- you get them without the cognitive cost of having resisted.
CREATE TABLE wait_item (
  id           INTEGER PRIMARY KEY,
  label        TEXT    NOT NULL,
  amount_minor INTEGER,
  added_at     TEXT    NOT NULL,
  ripe_at      TEXT    NOT NULL,      -- added_at + 72h
  outcome      TEXT CHECK (outcome IN ('bought','dropped','expired')),
  resolved_at  TEXT
);
CREATE INDEX idx_wait_open ON wait_item(ripe_at) WHERE resolved_at IS NULL;

INSERT INTO rule (cue, action, category, sort_order) VALUES
 ('I miss the daily log two nights in a row',
  'the next morning I log one combined entry for both days and do not attempt to reconstruct details',
  'adherence', 1),
 ('I miss a weekly money date',
  'I do a 5-minute version — balances and unplanned ratio only — within 24 hours',
  'adherence', 2),
 ('I have logged nothing for a full week',
  'I skip all backfill, reset the streak to zero, and start tonight',
  'adherence', 3),

 ('I am about to buy something over my daily allowance that is not on my calendar',
  'I add it to the 72-hour list and close the app or leave the shop',
  'overspend', 4),
 ('my Spend balance hits zero before the period ends',
  'I move exactly one day''s allowance from Irregulars, write the IOU, and repay it from next period''s Spend',
  'overspend', 5),
 ('I am shopping while tired, hungry, upset, or drinking',
  'I buy only what is on the list I wrote before leaving',
  'overspend', 6),
 ('a "sale" or "limited time" framing is what is making me want it',
  'it goes on the 72-hour list automatically, no exceptions',
  'overspend', 7),

 ('an unexpected bill arrives',
  'before paying it I check whether it belongs on the Irregulars list, and if it does I add it there in the same sitting',
  'structural', 8),
 ('my income changes by more than 10%',
  'I re-run the full split within 48 hours rather than waiting for the monthly',
  'structural', 9),
 ('I get a raise, allowance increase, or new income source',
  '50% of the increase goes to the current phase''s target before I ever see it in Spend',
  'structural', 10),
 ('a subscription renewal notice arrives',
  'I decide right then — keep or cancel — and never "decide later"',
  'structural', 11),

 ('friends propose something I cannot afford this week',
  'I say "I am out this week, but I am in for [specific alternative]" — a counter-offer, not a refusal',
  'social', 12),
 ('someone asks to borrow money',
  'I answer with a specific figure I am willing to treat as a gift, or "I cannot this time" — never an open-ended yes',
  'social', 13),

 ('I book a trip',
  'before I close the booking tab I add it to Irregulars with a padded estimate and a date',
  'travel', 14),
 ('I am on a trip and I have spent past the day''s envelope figure',
  'I take it out of a later day of the same trip rather than from Spend or Buffer',
  'travel', 15),
 ('I get home from a trip',
  'within seven days I record the actual total against my estimate',
  'travel', 16),
 ('I am paying in a foreign currency and hesitating',
  'I convert it to my home currency out loud before deciding',
  'travel', 17),

 ('I feel like the system is not working',
  'I open the weekly log and read the first row I ever wrote before making any changes',
  'motivation', 18),
 ('I have blown the budget badly',
  'I log the actual number anyway, in full, and change nothing until the next weekly review',
  'motivation', 19);
