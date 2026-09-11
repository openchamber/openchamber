-- runtime_operations: execution-tracking columns for the B2 runtime worker.
-- started_at is set atomically when a worker claims the operation (status
-- pending -> running); requested_at stays the enqueue time. request_id carries
-- the platform request that created the operation so completion audits can be
-- correlated with the attempt audit. reason records the operator-supplied
-- reason for stop/rebuild (plan section 8.5: admin stop requires a reason).
ALTER TABLE runtime_operations
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN request_id TEXT,
  ADD COLUMN reason TEXT;
