-- 0016: income arrivals (A6) + the shared-actions phase.
--
-- Two things land here:
--
-- 1. `income_arrival` — the ledger for op 2 of the effect matrix. Until now
--    money entered the system only by the user asserting a balance on the
--    Income account; A3.3 requires recording a real arrival into a chosen
--    account. An arrival is NOT a txn row: it is not income reporting, it
--    never touches `income_source` schedules, and the daily allowance never
--    changes because of it (invariant 10). It moves one balance up, and that
--    is all it does.
--
-- 2. `refund_of` linkage already shipped on `txn` in 0015; nothing more is
--    needed for op 8 at the schema level. This migration is arrivals only.

CREATE TABLE income_arrival (
  id             INTEGER PRIMARY KEY,
  arrived_on     TEXT    NOT NULL,             -- the money's own date, never backdated reporting
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  account_id     INTEGER NOT NULL REFERENCES account(id),  -- where it landed
  source_id      INTEGER REFERENCES income_source(id),     -- optional: which schedule it fulfils
  note           TEXT,
  client_uuid    TEXT    UNIQUE,               -- double-submit safe (matrix invariant 3)
  entered_at     TEXT    NOT NULL,
  user_id        INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE INDEX idx_arrival_user_date ON income_arrival(user_id, arrived_on);
CREATE INDEX idx_arrival_account   ON income_arrival(account_id);
