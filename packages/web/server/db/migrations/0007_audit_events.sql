-- audit_events: metadata-only trail of platform actions and authorization outcomes
-- (plan sections 7.3 and 11.3). Deliberately contains no prompt, message, or
-- content fields. Rows are append-only: no API is provided to update or delete
-- them, and future migrations must not add content columns to this table.
CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id),
  target_user_id UUID REFERENCES users(id),
  workspace_id UUID REFERENCES workspaces(id),
  action TEXT NOT NULL,
  request_id TEXT,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
