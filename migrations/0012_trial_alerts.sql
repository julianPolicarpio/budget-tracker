-- 0012 — A trial's own length decides its final alert (Spec §7.3, task A6).
--
-- `lead_days` already scales the FIRST warning by cadence
-- (subscription-cadence.ts's DEFAULT_LEAD_DAYS). The SECOND warning did not:
-- `pendingAlerts()` fired it at a hardcoded seven days out (`FINAL_ALERT_DAYS`)
-- for every subscription, trial or not. A trial forced `lead_days = 30`
-- regardless of how long the trial itself ran, so a 7-day trial's first
-- warning (day 30 -> immediately) and its second warning (day 7 -> the very
-- next sweep) both landed within 48 hours of signup, then the row went quiet
-- until the charge actually hit.
--
-- `final_lead_days` gives the second stage its own per-row threshold, the
-- same shape `lead_days` already has for the first. Every existing row keeps
-- today's behaviour exactly: the DEFAULT is the constant `FINAL_ALERT_DAYS`
-- that `pendingAlerts()` used to hardcode. Only new trial subscriptions,
-- created through the fixed quick-add and paste-a-trial flows, get a value
-- scaled to the trial's own length (<=7 days -> 1, <=14 -> 2, <=30 -> 3,
-- longer -> the same 7 every other commitment already gets).
--
-- A plain ADD COLUMN, not a rebuild: unlike the cadence CHECKs migration 0010
-- had to rebuild the whole table for, this is a brand-new column whose
-- constant default already satisfies its own CHECK, which SQLite allows
-- without the twelve-step recipe (Spec §10).

ALTER TABLE subscription
  ADD COLUMN final_lead_days INTEGER NOT NULL DEFAULT 7 CHECK (final_lead_days > 0);
