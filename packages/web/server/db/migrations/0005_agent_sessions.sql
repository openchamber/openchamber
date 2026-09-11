-- agent_sessions: mapping between platform conversations and OpenCode sessions (plan section 7.3).
-- execution_mode records whether the conversation runs in native or compat
-- mode; the (workspace_id, opencode_session_id) pair is the resume key.
CREATE TABLE agent_sessions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  execution_mode TEXT NOT NULL,
  opencode_session_id TEXT NOT NULL,
  work_dir TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_sessions_workspace_opencode_key UNIQUE (workspace_id, opencode_session_id)
);
