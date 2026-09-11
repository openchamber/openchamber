// Model access tokens (plan sections 7.3 and 11.1).
//
// A model access token authorizes model usage within ONE workspace generation
// only; it carries no platform administrator capability. The random secret is
// delivered to the user's sandbox (e.g. via the runtime environment); the
// database stores ONLY its sha256 digest, so a database read alone cannot
// replay a token. Rebuild, workspace stop or user deprovisioning revokes the
// old credentials - a revoked or stale-generation token must fail validation
// (enforced in model-service.js, tested there).

import crypto from 'crypto';
import { randomUUID } from 'node:crypto';

export const DEFAULT_MODEL_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export function hashModelAccessToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function toTokenView(row) {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    generation: row.generation,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

// Issue a token bound to (user, workspace, generation).
export async function issueModelAccessToken(
  db,
  { userId, workspaceId, generation, ttlMs = DEFAULT_MODEL_TOKEN_TTL_MS, now = Date.now() },
) {
  if (typeof userId !== 'string' || userId === '') {
    throw new Error('issueModelAccessToken requires a userId');
  }
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new Error('issueModelAccessToken requires a workspaceId');
  }
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error('issueModelAccessToken requires a non-negative integer generation');
  }
  // 32 random bytes (43 base64url chars) - far above the 32-byte minimum.
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + ttlMs).toISOString();
  const { rows } = await db.query(
    `INSERT INTO model_access_tokens (id, user_id, workspace_id, generation, token_hash, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'active', $6)
     RETURNING *`,
    [randomUUID(), userId, workspaceId, generation, hashModelAccessToken(token), expiresAt],
  );
  return { token, tokenDigest: hashModelAccessToken(token), expiresAt, record: toTokenView(rows[0]) };
}

// Revoke by scope: any combination of user, workspace and generation. At
// least one scope field is required so a caller cannot wipe every token with
// an empty filter. Returns the number of tokens revoked.
export async function revokeModelAccessTokens(
  db,
  { userId = null, workspaceId = null, generation = null, now = Date.now() } = {},
) {
  if (userId === null && workspaceId === null && generation === null) {
    throw new Error('revokeModelAccessTokens requires at least one scope (userId, workspaceId or generation)');
  }
  const conditions = [];
  const values = [];
  if (userId !== null) {
    values.push(userId);
    conditions.push(`user_id = $${values.length}`);
  }
  if (workspaceId !== null) {
    values.push(workspaceId);
    conditions.push(`workspace_id = $${values.length}`);
  }
  if (generation !== null) {
    values.push(generation);
    conditions.push(`generation = $${values.length}`);
  }
  const { rowCount } = await db.query(
    `UPDATE model_access_tokens
     SET status = 'revoked'
     WHERE status = 'active' AND ${conditions.join(' AND ')}`,
    values,
  );
  return { revoked: rowCount };
}

// Resolve a token digest to its record plus the workspace's CURRENT
// generation, so callers can detect stale-generation credentials. Returns
// null for unknown digests.
export async function resolveModelAccessToken(db, { tokenDigest }) {
  if (typeof tokenDigest !== 'string' || tokenDigest === '') return null;
  const { rows } = await db.query(
    `SELECT t.*, w.generation AS workspace_generation
     FROM model_access_tokens t
     LEFT JOIN workspaces w ON w.id = t.workspace_id
     WHERE t.token_hash = $1`,
    [tokenDigest],
  );
  if (!rows[0]) return null;
  return { ...toTokenView(rows[0]), workspaceGeneration: rows[0].workspace_generation };
}
