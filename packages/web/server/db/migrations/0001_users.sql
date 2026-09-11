-- users: platform identity bound to a host linux account (plan section 7.3).
-- IDs are application-generated UUIDs so inserts behave identically on every backend.
CREATE TABLE users (
  id UUID PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  linux_uid INTEGER NOT NULL,
  linux_gid INTEGER NOT NULL,
  home_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_issuer_subject_key UNIQUE (issuer, subject),
  CONSTRAINT users_linux_home_key UNIQUE (linux_uid, home_path),
  -- Never bind the platform identity to root (uid/gid 0).
  CONSTRAINT users_no_root_uid CHECK (linux_uid > 0),
  CONSTRAINT users_no_root_gid CHECK (linux_gid > 0),
  -- home_path must be absolute, must not be the filesystem root, and must be
  -- stored normalized (resolved, no trailing slash) so the unique constraint
  -- above compares normalized paths only.
  CONSTRAINT users_home_normalized CHECK (home_path LIKE '/%' AND home_path NOT LIKE '%/')
);
