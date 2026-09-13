-- 0009 — Sessions are a row, not a token.
--
-- A2 adds Google sign-in (Spec §3.3). The alternative to a table here is a
-- signed JWT: no lookup, no server-side state, seemingly less machinery. It
-- is not, once revocation is required. Signing a user out, or killing every
-- session after a suspected leak, needs a JWT to carry a rotating signing key
-- and a rejection list — which is more moving parts than the one row this
-- migration adds. A session id is looked up, not decoded, so revoking it is
-- a DELETE.
--
-- The id is 32 random bytes as hex (crypto.randomBytes(32).toString('hex')),
-- never derived from anything guessable — it is the entire credential, so it
-- has to be unforgeable on its own. `ON DELETE CASCADE` means deleting a user
-- (the working deletion Spec §3.5 requires) takes every one of their sessions
-- with it in the same statement; there is no separate cleanup step to forget,
-- and none of A1's leak tests need to know this table exists to still hold.
--
-- `user_id` is NOT NULL like every other tenanted table (Spec §3.2, migration
-- 0008) — a session belonging to nobody is exactly as wrong as a transaction
-- belonging to nobody, and the schema-enumeration test in tenancy.test.ts
-- checks this table the same way it checks the other twenty.

CREATE TABLE session (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX idx_session_user ON session(user_id);
