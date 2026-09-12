-- 0005 — Subscriptions.
--
-- A subscription is a BILLS item, not an Irregular (Spec §158: "contractual and
-- stable ... rent, tuition instalment, phone plan, transit pass, insurance
-- premium, subscriptions"). Filing one under Irregulars would apply the
-- mandatory +25% padding to a figure that is contractually exact, and would
-- accrue 1/12 monthly for a cost that already arrives monthly. Both are wrong.
--
-- It is also not a txn. Bills never touch Spend, so a subscription charge does
-- not enter the daily figure and must never appear in the eight categories'
-- weekly totals. `category` here is for the review's cull step only.
--
-- What this table exists for is the decision deadline, not the money. A free
-- trial's danger is not that you cannot afford ₱285 — it is that in twelve
-- months you will have forgotten the trial exists (F12: the snowball is built
-- from charges too small to notice individually).

CREATE TABLE subscription (
  id             INTEGER PRIMARY KEY,
  label          TEXT    NOT NULL,
  vendor         TEXT,

  -- Home currency minor units, like everything else. Spec §1 non-goals rule
  -- out per-account currency; a foreign-billed subscription is recorded at
  -- what it actually costs you in PHP.
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  tax_minor      INTEGER          CHECK (tax_minor IS NULL OR tax_minor >= 0),

  -- No 'one_off'. A charge that happens once is an Irregular; the whole point
  -- of this table is that the charge repeats until a human stops it.
  cadence        TEXT    NOT NULL CHECK (cadence IN
                   ('monthly','quarterly','semiannual','annual')),
  next_charge_on TEXT    NOT NULL,

  -- Set only while a free trial is running. `cancel_by_on` is the deadline the
  -- alerts key off, kept separate from `trial_ends_on` because the two differ
  -- whenever a vendor requires cancellation some days before the renewal.
  trial_ends_on  TEXT,
  cancel_by_on   TEXT,

  -- How far ahead the first warning fires. Long by default: a decision needs
  -- runway, unlike the horizon's seven days which only needs you to have the
  -- money ready.
  lead_days      INTEGER NOT NULL DEFAULT 30 CHECK (lead_days > 0),

  -- 0 = nothing sent, 1 = lead warning sent, 2 = final warning sent.
  --
  -- Deliberately state on the ROW, not a date key in `job_run` like the other
  -- scheduled work. The three date-keyed jobs only ever ask "did I run today",
  -- so a laptop asleep across the target date skips them forever. This one is
  -- re-asked by the same 15-minute sweep until it has actually been delivered,
  -- which is what makes a once-in-twelve-months alert survive a machine that
  -- sleeps. It fails only if the server is down for the entire lead window.
  alert_stage    INTEGER NOT NULL DEFAULT 0 CHECK (alert_stage BETWEEN 0 AND 2),
  alerted_at     TEXT,

  -- Spec §267's cull: "used in the last 30 days? If no, cancel now."
  last_used_on   TEXT,

  category       TEXT,
  note           TEXT,
  created_at     TEXT    NOT NULL,

  -- The decision, once made. `cancelled_at` records that you acted; a kept
  -- subscription simply stays live with its dates rolled forward.
  cancelled_at   TEXT
);

-- The query the scheduler runs every 15 minutes: live subscriptions with a
-- decision deadline still pending an alert.
CREATE INDEX idx_subscription_deadline
  ON subscription(cancel_by_on)
  WHERE cancelled_at IS NULL AND cancel_by_on IS NOT NULL;

CREATE INDEX idx_subscription_live
  ON subscription(next_charge_on)
  WHERE cancelled_at IS NULL;
