-- user_preferences: per-user UI preferences restorable across browsers (plan section 7.3).
-- Never store upstream provider keys or runtime configuration here.
CREATE TABLE user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  locale TEXT,
  theme TEXT,
  last_project TEXT,
  last_session_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
