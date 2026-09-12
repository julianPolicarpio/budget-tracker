-- 0006 — Bills and subscriptions are the same shape.
--
-- Spec §158 lists subscriptions *inside* the Bills bucket: "rent, tuition
-- instalment, phone plan, transit pass, insurance premium, subscriptions,
-- minimum debt payments". They are one kind of thing — a charge that repeats
-- on a schedule until a human intervenes — so they get one table, not two.
--
-- The only real difference is whether intervening is an option. Home internet
-- is non-negotiable and the cull must never nag about it; a streaming service
-- is exactly what the cull exists to hunt. That is one boolean, not a schema.
--
-- Wording note: `is_essential` describes the COST, not the person. A thing can
-- be essential and still be the wrong price.

ALTER TABLE subscription ADD COLUMN is_essential INTEGER NOT NULL DEFAULT 0;
