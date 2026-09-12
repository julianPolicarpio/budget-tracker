-- 0007 — A period with nothing logged is missing data, not a good week.
--
-- closePeriod() computes swept = spend_alloc - spent. When the owner simply
-- stopped logging for a stretch, `spent` reads back as zero because nothing
-- was recorded, and the sweep records a surplus that was never real — a
-- to-do to move money into savings that does not exist. Spec §4.1 (public
-- multi-user redesign) names exactly this: periods 3 to 5 swept their full
-- allocations because no log_day row existed for their range, not because
-- those weeks were frugal.
--
-- `is_gap` marks that distinction on the period itself, at close time, so
-- every later consumer — trend averages, review comparisons — can exclude a
-- gap period by reading one column instead of re-deriving "was there data"
-- from log_day each time. A catch-up row where the user explicitly said
-- "nothing was spent" is real data and does not set this flag.

ALTER TABLE period ADD COLUMN is_gap INTEGER NOT NULL DEFAULT 0;
