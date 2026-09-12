-- Split — migration 0002: Phase 2, the ritual layer (Spec §13 Phase 2)
--
-- Adds the monitored artefact (F7), which is what makes the system work rather
-- than merely run: a written weekly row, snapshotted metrics, and a one-line
-- summary sent to one other human.
--
-- Still absent, on purpose: accounts, income sources, tranches, irregulars,
-- trips, debt, rules. The four balances logged at review step R1 live on the
-- review row itself — per Spec §14 Q3, balances are user-asserted weekly, and
-- a whole account subsystem is not needed to hold four numbers a week.

PRAGMA foreign_keys = ON;

-- ─── Take-home pay, asserted once ────────────────────────────────────────
-- Needed for bufferWeeks() (F14: the target is 6 weeks, not 6 months).
-- Phase 3 supersedes this with weeklyTakeHome() over real income rows, using
-- the MINIMUM of the last three months for irregular income — never the mean
-- (Rule 1, Spec §6.4). Until then the user states one number.
ALTER TABLE settings ADD COLUMN weekly_take_home_minor INTEGER;

-- ─── The monitored artefact (F7) ─────────────────────────────────────────
-- One row per completed ritual. Physical recording was a moderator in Harkin
-- et al.; `shared_at` is the public-reporting moderator, and it is one tap.
CREATE TABLE review (
  id                  INTEGER PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN
                        ('weekly','monthly','quarterly','annual')),
  period_label        TEXT NOT NULL,        -- '2026-W33'
  -- Not in Spec §5, added here on purpose: the label alone is not enough to
  -- recover the window once settings.week_starts_on changes. An artefact that
  -- cannot say which days it covered is not much of an artefact.
  starts_on           TEXT NOT NULL,
  ends_on             TEXT NOT NULL,
  completed_at        TEXT,

  -- R1, asserted by hand. Typing the number is doing the work (F7).
  spend_balance_minor INTEGER,
  irregulars_minor    INTEGER,
  buffer_minor        INTEGER,
  debt_total_minor    INTEGER,

  -- Snapshotted at R6. Method Part VIII's five metrics; the two that need
  -- subsystems this phase does not have stay NULL rather than being faked.
  total_spent_minor   INTEGER,
  unplanned_ratio_bp  INTEGER,              -- basis points
  buffer_weeks_x100   INTEGER,
  coverage_ratio_bp   INTEGER,              -- NULL until Phase 3 (irregulars)
  save_rate_bp        INTEGER,              -- NULL until Phase 3 (income)
  log_adherence_bp    INTEGER,
  streak_at_close     INTEGER,

  summary_line        TEXT,
  shared_at           TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (kind, period_label)
);
CREATE INDEX idx_review_window ON review(kind, ends_on DESC);

-- Partial completion persists: the wizard is resumable at the last step.
CREATE TABLE review_step (
  id          INTEGER PRIMARY KEY,
  review_id   INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  step_key    TEXT    NOT NULL,
  done_at     TEXT,
  payload     TEXT,                          -- JSON, step-specific
  UNIQUE (review_id, step_key)
);

-- ─── Job bookkeeping ─────────────────────────────────────────────────────
-- Background jobs are idempotent and keyed by date, because a home server
-- reboots and a cron tick gets skipped (Spec §3). This table records what has
-- run so a double fire is a no-op and a missed one is caught up.
CREATE TABLE job_run (
  job_key  TEXT NOT NULL,
  ran_for  TEXT NOT NULL,          -- the local date the run covers
  ran_at   TEXT NOT NULL,
  detail   TEXT,
  PRIMARY KEY (job_key, ran_for)
);
