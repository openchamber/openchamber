-- runtime_operations: auditable, idempotent start/stop/rebuild operations (plan section 7.3).
-- Retrying an operation with the same idempotency key targets the same row
-- instead of creating a duplicate operation for the workspace.
CREATE TABLE runtime_operations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL,
  requested_by UUID REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error_code TEXT,
  CONSTRAINT runtime_operations_idempotency_key UNIQUE (workspace_id, idempotency_key)
);
