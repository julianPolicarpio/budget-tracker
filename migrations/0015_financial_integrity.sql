-- 0015: financial integrity — A9 phase 1 (Spec amendment A3)
--
-- Four additions, none of which rewrite an existing row:
--
--   1. transfer.fee_txn_id   — the optional fee as a linked spending txn.
--                              A3.1: "A fee is a separate linked spending
--                              amount with an explicit paying account."
--                              The txn row itself carries the amount and the
--                              paying account; the transfer points at it.
--   2. transfer.client_uuid  — idempotency for the transfer operation, so a
--                              retried submit after an uncertain response
--                              cannot record the move twice (A6). Nullable;
--                              the UNIQUE lives in a partial index because
--                              SQLite cannot add a UNIQUE column via ALTER.
--   3. txn.refund_of         — a refund's link to the expense txn it
--                              returns. Nullable; no default (the same
--                              pattern migration 0011 used for leaf_id).
--   4. Two new tables:       expense_reservation — the append-only
--                              reservation ledger for planned expenses
--                              (A3.2: funding history is written as rows);
--                              balance_correction — the audit trail for a
--                              recorded-balance correction (A3.3: "a
--                              correction with an audit trail, not an
--                              inferred income or expense").
--   5. debt_payment.source_account_id — the explicit source account a debt
--                              payment draws from (A3.3: payments "must have
--                              an explicit source and target").
--
-- New tables carry a real owner on every insert (no `.default(1)` backfill
-- device — same rule as category_leaf in 0011).
--
-- Rollback: restore from backup (`node scripts/backup.js` runs before this
-- migration; `scripts/restore.js` puts it back). The migration itself is
-- applied once, tracked in _migrations, and never partially applied —
-- apply-migrations.js wraps each file in a transaction.

-- ── transfer: fee linkage + idempotency ────────────────────────────────────

ALTER TABLE transfer ADD COLUMN fee_txn_id INTEGER REFERENCES txn (id);

ALTER TABLE transfer ADD COLUMN client_uuid TEXT;

CREATE UNIQUE INDEX idx_transfer_client_uuid
  ON transfer (client_uuid)
WHERE client_uuid IS NOT NULL;

-- ── txn: refund linkage ─────────────────────────────────────────────────────

ALTER TABLE txn ADD COLUMN refund_of INTEGER REFERENCES txn (id);

-- ── expense_reservation: the reservation ledger ────────────────────────────
--
-- One row per reservation event, append-only. `kind` names the event:
--   fund    — money promised to the expense (A3.2 case 1 or case 2)
--   release — a promise withdrawn (funding reduced or reversed)
--   consume — the expense was paid; the promise became an actual payment
-- Reserved-for-expense = sum(fund) − sum(release) − sum(consume).
-- The same money can never fund two expenses: each row names exactly one
-- expense, and the fund operation checks available-unassigned inside its
-- transaction before inserting.

CREATE TABLE expense_reservation (
  id            INTEGER PRIMARY KEY,
  irregular_id  INTEGER NOT NULL REFERENCES irregular (id) ON DELETE CASCADE,
  account_id    INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL CHECK (kind IN ('fund', 'release', 'consume')),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  note          TEXT,
  client_uuid   TEXT,
  created_at    TEXT    NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES app_user (id) ON DELETE CASCADE
);

CREATE INDEX idx_expense_reservation_user
  ON expense_reservation (user_id, irregular_id);

CREATE UNIQUE INDEX idx_expense_reservation_client_uuid
  ON expense_reservation (client_uuid)
WHERE client_uuid IS NOT NULL;

-- ── balance_correction: the correction audit trail ─────────────────────────
--
-- assertBalance becomes a correction: old value, new value, and the delta the
-- user approved, kept forever. Historical rows are never rewritten (A3.3).

CREATE TABLE balance_correction (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  old_minor    INTEGER NOT NULL,
  new_minor    INTEGER NOT NULL,
  corrected_on TEXT    NOT NULL,
  note         TEXT,
  created_at   TEXT    NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES app_user (id) ON DELETE CASCADE
);

CREATE INDEX idx_balance_correction_user
  ON balance_correction (user_id, account_id);

-- ── debt_payment: explicit source ───────────────────────────────────────────

ALTER TABLE debt_payment ADD COLUMN source_account_id INTEGER REFERENCES account (id);
