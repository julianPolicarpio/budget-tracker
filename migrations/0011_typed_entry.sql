-- 0011 — Typed entry: the router, transfers, and two-level categories
-- (Spec §5.2–§5.9).
--
-- The owner's daily log asked three decisions per entry — amount, one of
-- eight categories, planned/unplanned — in vocabulary he could not map to his
-- own purchases ("kape" is not "Eating out" to him), and he stopped logging
-- after ten transactions. The fix is one typed field: "kape 65", "wifi bill
-- 750", "withdraw 2000". Before any of that can save, the app has to decide
-- what KIND of record it is, because the four kinds are not interchangeable:
--
--   * a transaction spends against today's band
--   * an existing fixed commitment (subscription) has already been reserved
--     by commitmentsPerPeriod() and logging it again as a transaction spends
--     it a second time
--   * an existing varying commitment (irregular) settles an instance, it does
--     not spend against Spend either
--   * a transfer (withdraw/atm/moved) moves the user's own money between
--     their own pockets and touches neither Spend nor the band
--
-- Guessing the CATEGORY wrong costs one line in the weekly review. Guessing
-- the RECORD KIND wrong corrupts the daily figure for the rest of the period
-- — that is the whole reason this migration and the router beside it exist.
--
-- Four schema pieces support that:
--
--   1. `txn.source` — cash / ewallet / card / bank / unknown (Spec §5.4).
--      Recorded on every transaction, surfaced only in the weekly review,
--      never a balance and never shown on Today. Defaults to 'unknown' so
--      existing rows need no backfill decision.
--   2. `txn.label` + `txn.leaf_id` — the two-level category (Spec §5.5). The
--      eight existing `txn.category` roots never change; `category_leaf` is
--      a user-grown leaf under exactly one root, and `label_map` is the
--      per-user "typed word -> (english, root, leaf)" dictionary the router
--      consults and the user extends by answering a question once. Neither
--      table carries anything resembling a budget, target or limit — that is
--      invariant 4's absolute rule, unchanged by categories being allowed to
--      grow.
--   3. `category_leaf` and `label_map` are brand-new tables with no
--      pre-existing rows, so — like `session` in migration 0009 — their
--      `user_id` gets no `.default(1)` backfill device; a real owner is
--      always supplied by the code that inserts the first row.
--      carrying no IOU. See below — this is the one existing table this
--      migration reshapes, and it is not optional.
--
-- ── Why a withdrawal writes NOTHING ──────────────────────────────────────
--
-- Spec §5.4 said a withdrawal "moves the user's own money between their own
-- pockets, and the transfer table already models exactly that." It does not,
-- and the first attempt at this migration proved it: `transfer` was built by
-- `0003_phase3.sql` for inter-bucket moves under Rule 3 — every withdrawal
-- from savings carries an IOU — and it carries
-- `CHECK (from_account_id <> to_account_id)`. A cash withdrawal is a
-- same-account row, because this app models BUCKETS, not the physical form
-- money is in. There is no cash-on-hand bucket to move to.
--
-- The first fix widened that CHECK. That was the wrong trade: it weakened a
-- sanity constraint on a financial table in order to store a row with no
-- consumer — a spend→spend entry that never touches a balance and appears on
-- no screen.
--
-- So a withdrawal records nothing, and the spec line is what changes. This is
-- not a gap: withdrawing cash genuinely does not move money between buckets,
-- so there is nothing for a bucket-shaped model to record. What the owner
-- actually asked for — "we need to know where we took the money from" — is
-- `txn.source` below. The coffee bought with that cash is logged as
-- `source = 'cash'`, which is the fact that carries information. The
-- withdrawal itself is correctly a no-op, and the router says so out loud
-- rather than writing a row to look busy.
--
--   * `scripts/apply-migrations.js` already switches `PRAGMA foreign_keys`
--     OFF around this whole transaction. It cannot be done from inside this
--     file — the pragma is a no-op once a transaction is open.
--   * `PRAGMA legacy_alter_table = ON` stops `RENAME TO` from "helpfully"
--     rewriting other tables' REFERENCES clauses mid-rebuild.
--   * There is deliberately no `PRAGMA foreign_key_check` in this file — the
--     runner performs it after commit and treats a violation as fatal;
--     running it here via `exec()` would discard the result rows and check
--     nothing.
--
-- Every column, every index, and every existing row is preserved exactly.
-- `transfer` has carried `user_id` since `0008_multi_tenant`; the rebuild
-- keeps it, and `idx_transfer_open_iou` is recreated afterwards.
--
-- Everything else here — `txn`'s two new columns, `category_leaf`,
-- `label_map` — only ADDs columns or CREATEs new tables, so none of that
-- needs the rebuild dance. SQLite's one real restriction on ADD COLUMN is
-- that a column cannot combine a REFERENCES clause with a non-NULL DEFAULT
-- in the same statement; `txn.leaf_id` has REFERENCES but is nullable with
-- no default, and `txn.source` has NOT NULL DEFAULT but no REFERENCES, so
-- both are clear.

PRAGMA legacy_alter_table = ON;


-- ── txn: the two typed-entry columns ──────────────────────────────────────

ALTER TABLE txn ADD COLUMN label TEXT;

ALTER TABLE txn ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'
  CHECK (source IN ('cash','ewallet','card','bank','unknown'));

-- ── category_leaf, label_map: the two-level category ──────────────────────

CREATE TABLE category_leaf (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  root       TEXT    NOT NULL CHECK (root IN
               ('food_in','food_out','transport','study_work','health','social','stuff','other')),
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  UNIQUE (user_id, root, name)
);

CREATE INDEX idx_category_leaf_user ON category_leaf(user_id, root);

ALTER TABLE txn ADD COLUMN leaf_id INTEGER REFERENCES category_leaf(id);

CREATE TABLE label_map (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  typed   TEXT    NOT NULL,
  english TEXT    NOT NULL,
  root    TEXT    NOT NULL CHECK (root IN
            ('food_in','food_out','transport','study_work','health','social','stuff','other')),
  leaf_id INTEGER REFERENCES category_leaf(id),
  UNIQUE (user_id, typed)
);

CREATE INDEX idx_label_map_user ON label_map(user_id);
