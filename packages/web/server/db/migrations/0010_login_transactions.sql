-- login_transactions: one-time OIDC login transactions (plan section 7.1 step 1).
-- Each row carries the state/nonce/PKCE material for one authorization
-- redirect. Rows are single-use: the callback consumes them with a
-- DELETE ... RETURNING, so a replayed or expired state simply finds nothing.
-- Lifetime is ~10 minutes, enforced in the application layer.
CREATE TABLE login_transactions (
  id UUID PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
