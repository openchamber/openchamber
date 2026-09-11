-- model_access_tokens: digest-only tokens for authorized model access (plan section 7.3).
-- These tokens grant model usage within one workspace generation only; they
-- carry no platform administrator capability. Only the digest is stored.
CREATE TABLE model_access_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  workspace_id UUID REFERENCES workspaces(id),
  generation INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
