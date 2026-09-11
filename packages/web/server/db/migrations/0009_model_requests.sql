-- model_requests: basic attribution and observability of model calls (plan section 7.3).
-- This is an operational ledger, not a precise financial billing record.
CREATE TABLE model_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  workspace_id UUID REFERENCES workspaces(id),
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT
);
