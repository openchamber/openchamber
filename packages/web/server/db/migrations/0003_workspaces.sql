-- workspaces: one stable record per user across container rebuilds (plan section 7.3).
-- desired_state/observed_state follow the workspace state model; generation is
-- bumped on every rebuild so late callbacks from older runtimes cannot
-- overwrite newer state.
CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL UNIQUE REFERENCES users(id),
  desired_state TEXT NOT NULL DEFAULT 'stopped',
  observed_state TEXT NOT NULL DEFAULT 'stopped',
  generation INTEGER NOT NULL DEFAULT 0,
  runtime_id TEXT,
  internal_endpoint TEXT,
  credential_ref TEXT,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_activity_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
