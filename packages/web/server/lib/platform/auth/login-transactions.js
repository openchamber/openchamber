// One-time OIDC login transactions (plan section 7.1 step 1).
//
// A login transaction binds the `state`, `nonce` and PKCE code verifier that
// one authorization redirect needs. Consumption is a single atomic
// DELETE ... RETURNING keyed by state, which gives single-use semantics for
// free: a replayed state, an expired transaction and an unknown state are all
// indistinguishable "nothing found" outcomes. Expiry (~10 minutes) is
// evaluated in the application layer against the stored expires_at timestamp.

import { randomUUID } from 'crypto';

export const LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1000;

export async function createLoginTransaction(
  db,
  { state, nonce, codeVerifier, now = Date.now(), ttlMs = LOGIN_TRANSACTION_TTL_MS },
) {
  if (typeof state !== 'string' || state.length === 0) {
    throw new Error('login transaction requires a non-empty state');
  }
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new Error('login transaction requires a non-empty nonce');
  }
  if (typeof codeVerifier !== 'string' || codeVerifier.length === 0) {
    throw new Error('login transaction requires a non-empty code verifier');
  }
  const expiresAt = new Date(now + ttlMs).toISOString();
  await db.query(
    `INSERT INTO login_transactions (id, state, nonce, code_verifier, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), state, nonce, codeVerifier, expiresAt],
  );
  return { state, nonce, codeVerifier, expiresAt };
}

const toMillis = (value) => {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? NaN : parsed;
};

// Single-use consumption: deletes the row and returns its verification
// material, or null when the state is unknown or already expired. Callers
// treat null as an invalid login transaction.
export async function consumeLoginTransaction(db, { state, now = Date.now() }) {
  const { rows } = await db.query(
    `DELETE FROM login_transactions
     WHERE state = $1
     RETURNING nonce, code_verifier, expires_at`,
    [state],
  );
  const row = rows[0];
  if (!row) return null;
  const expiresAtMs = toMillis(row.expires_at);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= now) {
    return null;
  }
  return {
    nonce: row.nonce,
    codeVerifier: row.code_verifier,
    expiresAt: row.expires_at,
  };
}
