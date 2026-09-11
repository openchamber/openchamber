// Platform login sessions (plan section 7.1 step 5 and table auth_sessions).
//
// The session secret is a cryptographically random value delivered to the
// browser as the HttpOnly `oc_platform_session` cookie; the database stores
// only its sha256 digest, so a database read alone cannot replay a session.
// Sessions expire, can be revoked (logout), and slide their last_seen_at on
// every authenticated request.

import crypto from 'crypto';
import { randomUUID } from 'crypto';

export const SESSION_COOKIE_NAME = 'oc_platform_session';
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// Sliding-window updates are throttled so a busy poll does not write on every request.
const LAST_SEEN_UPDATE_THROTTLE_MS = 60 * 1000;

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export async function createPlatformSession(
  db,
  { userId, now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS },
) {
  // 48 random bytes (64 base64url chars) - far above the 32-byte minimum.
  const token = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(now + ttlMs).toISOString();
  await db.query(
    `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), userId, hashSessionToken(token), expiresAt, new Date(now).toISOString()],
  );
  return { token, expiresAt };
}

const toMillis = (value) => {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? NaN : parsed;
};

// Resolves a session secret to its session + user row, enforcing expiry and
// revocation, and slides last_seen_at (throttled). Returns null for unknown,
// expired or revoked tokens - callers must respond 401 either way.
export async function resolvePlatformSession(db, { token, now = Date.now() }) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, s.revoked_at,
            u.id, u.issuer, u.subject, u.display_name, u.role, u.status,
            u.linux_uid, u.linux_gid, u.home_path
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashSessionToken(token)],
  );
  const row = rows[0];
  if (!row || row.revoked_at != null) return null;
  const expiresAtMs = toMillis(row.expires_at);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= now) return null;

  const lastSeenMs = row.last_seen_at == null ? NaN : toMillis(row.last_seen_at);
  if (Number.isNaN(lastSeenMs) || now - lastSeenMs >= LAST_SEEN_UPDATE_THROTTLE_MS) {
    await db.query(
      'UPDATE auth_sessions SET last_seen_at = $1 WHERE id = $2',
      [new Date(now).toISOString(), row.session_id],
    );
  }

  return {
    session: { id: row.session_id, expiresAt: row.expires_at },
    user: {
      id: row.id,
      issuer: row.issuer,
      subject: row.subject,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      linuxUid: row.linux_uid,
      linuxGid: row.linux_gid,
      homePath: row.home_path,
    },
  };
}

// Revokes the session behind a secret. Returns true when a live session was revoked.
export async function revokePlatformSession(db, { token, now = Date.now() }) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const { rowCount } = await db.query(
    `UPDATE auth_sessions SET revoked_at = $1
     WHERE token_hash = $2 AND revoked_at IS NULL`,
    [new Date(now).toISOString(), hashSessionToken(token)],
  );
  return rowCount > 0;
}

// Minimal cookie parsing: the platform ships exactly one cookie, so pulling it
// from the raw Cookie header avoids a cookie-parser dependency.
export function readSessionCookie(req) {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function buildCookie({ value, maxAgeSeconds, secure }) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ];
  if (Number.isFinite(maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.trunc(maxAgeSeconds)}`);
  }
  return parts.join('; ');
}

export function buildSessionCookie(token, { secure, ttlMs }) {
  return buildCookie({
    value: token,
    secure,
    maxAgeSeconds: Math.max(0, Math.floor(ttlMs / 1000)),
  });
}

export function buildClearedSessionCookie({ secure }) {
  return buildCookie({ value: '', secure, maxAgeSeconds: 0 });
}
