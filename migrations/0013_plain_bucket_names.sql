-- 0013 — The six buckets get names a stranger already knows.
--
-- The owner raised naming three separate times, and the third time was the
-- clearest: "the namings are off they dont follow semantics people dont know
-- what those words actually mean without searching them."
--
-- He was right, and `src/lib/categories.ts` had already solved it once for the
-- eight spending categories: "Labelled for what they mean, not for the spec's
-- shorthand... The keys stay as the spec names them." Nobody generalised it.
--
-- So this is a DISPLAY change that happens to live in data. `account.slug` and
-- `account.kind` — the things code joins and switches on — are untouched. Only
-- `name`, which exists to be read by a human, changes:
--
--   Inflow      -> Income            nobody says "inflow" out loud
--   Irregulars  -> Big bills         the correct term is "sinking fund", and
--                                    CNBC, PayPal, SoFi and Experian all
--                                    publish "what is a sinking fund"
--                                    explainers. A word needing that many
--                                    explainers fails the only test that
--                                    matters here.
--   Buffer      -> Emergency fund    what every bank calls this exact bucket
--   Grow        -> Savings           "Investing" would overpromise: the spec
--                                    says this account "holds a number you
--                                    type in monthly", with no portfolio and
--                                    no market data
--   Spend       -> Spending
--
-- Bills keeps its name. It was already the word.
--
-- ONLY UNEDITED ROWS MOVE. The WHERE clause matches the seeded default
-- exactly, so anyone who has renamed a bucket keeps their own word. A rename
-- is a small act of ownership and overwriting it would be rude, and this app
-- cannot tell a deliberate "Buffer" from a default one any other way.

UPDATE account SET name = 'Income'         WHERE kind = 'inflow'     AND name = 'Inflow';
UPDATE account SET name = 'Spending'       WHERE kind = 'spend'      AND name = 'Spend';
UPDATE account SET name = 'Big bills'      WHERE kind = 'irregulars' AND name = 'Irregulars';
UPDATE account SET name = 'Emergency fund' WHERE kind = 'buffer'     AND name = 'Buffer';
UPDATE account SET name = 'Savings'        WHERE kind = 'grow'       AND name = 'Grow';
