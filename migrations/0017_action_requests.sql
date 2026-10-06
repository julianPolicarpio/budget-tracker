-- One request ID identifies one completed quick create for one user.
-- The operation and input hash refuse accidental reuse for different work.
CREATE TABLE action_request (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  client_uuid TEXT NOT NULL,
  operation   TEXT NOT NULL,
  input_hash  TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, client_uuid)
);

CREATE INDEX idx_action_request_user ON action_request(user_id);
