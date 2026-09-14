-- 0014 — Where the money comes from.
--
-- The Accounts page has been telling the truth about itself for four phases:
-- "Only two of the five are known here. Bills, Emergency fund and Savings need
-- the income split, which needs income sources — a subsystem Spec §13's
-- roadmap never assigns to a phase."
--
-- So three of five transfer instructions were never computed, four of six
-- account balances read "never", and `spend_alloc_minor` had to be hand-typed
-- into `open-period.js --alloc` because nothing could derive it. Invariant 7
-- names `projectArrivals()` as the only honest path to an allocation, and
-- `projectArrivals()` did not exist — it appeared once, in a comment, warning
-- future readers about a function nobody had written.
--
-- ── THE BI-WEEKLY TRAP, which is why this table is shaped like this ──────
--
-- Spec §4.1: "Bi-weekly is 26 arrivals a year. Semi-monthly is 24. These are
-- different by ~8% and are conflated constantly, including by people who have
-- been paid bi-weekly for a decade."
--
-- They are not the same cadence with different words. Bi-weekly is every 14
-- DAYS and drifts through the calendar, landing three times in some months.
-- Semi-monthly is two fixed DATES and never drifts. Modelling both as "twice a
-- month" understates a bi-weekly income by 8% every year, and an allocation
-- built on it is quietly too small for ever.
--
-- That is why `anchor_on` and `second_day` both exist: day-based cadences step
-- from the anchor, date-based ones repeat on days of the month. One column
-- could not express both without lying about one of them.
--
-- ── Irregular income ────────────────────────────────────────────────────
--
-- Freelance and tips have no schedule, so Rule 1 fixes the ORDER instead of a
-- percentage, and budgets to the LOWEST of the last three months, never the
-- mean. `baseline_minor` holds that figure. A mean quietly budgets to a month
-- you may not have again; the minimum is the only number you can spend without
-- hoping.

CREATE TABLE income_source (
  id             INTEGER PRIMARY KEY,
  label          TEXT    NOT NULL,

  -- Gross-to-you, in home-currency minor units, per arrival. Not per month:
  -- per month is exactly the conversion that loses the 26-versus-24 difference.
  amount_minor   INTEGER NOT NULL CHECK (amount_minor >= 0),

  cadence        TEXT    NOT NULL CHECK (cadence IN
                   ('daily','weekly','biweekly','semimonthly','monthly','irregular')),

  -- The reference arrival. Day-based cadences (daily, weekly, biweekly) step
  -- forward from here; monthly repeats this date's day-of-month; semimonthly
  -- uses this day-of-month plus `second_day`.
  anchor_on      TEXT,

  -- Semi-monthly only: the other day of the month. 31 means "last day", since
  -- February has no 31st and a pay date does not skip a month.
  second_day     INTEGER CHECK (second_day IS NULL OR (second_day >= 1 AND second_day <= 31)),

  -- Irregular only: the lowest of the last three months (Rule 1). Never the
  -- mean. NULL until three months of history exist, and an irregular source
  -- with no baseline contributes NOTHING to an expectation rather than a guess.
  baseline_minor INTEGER CHECK (baseline_minor IS NULL OR baseline_minor >= 0),

  note           TEXT,
  created_at     TEXT    NOT NULL,
  archived_at    TEXT,

  user_id        INTEGER NOT NULL DEFAULT 1 REFERENCES app_user(id) ON DELETE CASCADE,

  -- A scheduled source without an anchor cannot be projected, and a
  -- semi-monthly one without a second day is really a monthly one wearing the
  -- wrong label. Both are caught here rather than discovered as a silently
  -- missing arrival.
  CHECK (cadence = 'irregular' OR anchor_on IS NOT NULL),
  CHECK (cadence <> 'semimonthly' OR second_day IS NOT NULL)
);

CREATE INDEX idx_income_source_live
  ON income_source(user_id) WHERE archived_at IS NULL;
