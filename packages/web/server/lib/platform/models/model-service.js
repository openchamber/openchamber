// Model request validation and recording (plan sections 11.1 and 11.2).
//
// validateModelRequest is the seam the future model proxy calls per upstream
// request, BEFORE any provider forwarding: it enforces the token binding, the
// generation match, the model whitelist and per-user capacity, in that order.
// Capacity is acquired LAST so a failed check never leaks a concurrency slot.
// The proxy releases the slot when the upstream request finishes or times
// out (governor.release; the TTL lease backstops a crashed holder).
//
// Recording (start/finish/failure) attributes every model request to its
// user and workspace. Usage is a verbatim jsonb passthrough: when the
// provider returns no usage the record keeps the '{}' default - unknown
// stays unknown and is never zero-filled into a fake "free" call (plan
// section 11.2).

import { randomUUID } from 'node:crypto';

import { isModelAllowed } from './runtime-config.js';
import { resolveModelAccessToken } from './access-tokens.js';

const toMillis = (value) => {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? NaN : parsed;
};

// Enforce: token valid + active + unexpired + owned by this user/workspace,
// token generation matches the workspace's CURRENT generation (a rebuild
// invalidates old credentials), model in the deployment whitelist, capacity
// available (acquire). Returns {ok:true, token} or {ok:false, code}.
export async function validateModelRequest(
  db,
  { user, workspace = null, model, tokenDigest, governor, allowedModels, now = Date.now() },
) {
  const fail = (code) => ({ ok: false, code });

  if (!governor || typeof governor.acquire !== 'function') {
    throw new Error('validateModelRequest requires a concurrency governor');
  }
  if (!Array.isArray(allowedModels)) {
    throw new Error('validateModelRequest requires the resolved allowed-model list');
  }
  if (!user || typeof user.id !== 'string' || user.id === '') {
    throw new Error('validateModelRequest requires a user with an id');
  }

  // 1. Token: known digest, active, unexpired, owned by this user+workspace.
  if (typeof tokenDigest !== 'string' || tokenDigest === '') {
    return fail('token_invalid');
  }
  const record = await resolveModelAccessToken(db, { tokenDigest });
  if (!record) return fail('token_invalid');
  if (record.status !== 'active') return fail('token_revoked');
  const expiresAtMs = toMillis(record.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= now) return fail('token_expired');
  if (record.userId !== user.id) return fail('token_invalid');
  if (workspace && record.workspaceId !== workspace.id) return fail('token_invalid');

  // 2. The credential is bound to one workspace generation; a rebuilt
  // workspace must not accept the old incarnation's token.
  const currentGeneration = workspace && Number.isInteger(workspace.generation)
    ? workspace.generation
    : record.workspaceGeneration;
  if (record.generation !== currentGeneration) return fail('generation_mismatch');

  // 3. Deployment whitelist (plan section 11.2: enforced by the module).
  if (!isModelAllowed(allowedModels, model)) return fail('model_not_allowed');

  // 4. Capacity - strictly last so failures above never consume a slot.
  const acquired = governor.acquire(user.id);
  if (!acquired.ok) return fail(acquired.code);

  return { ok: true, token: record };
}

// Record a model request start. Status begins at 'started'; the proxy calls
// finish/failure exactly once per start.
export async function startModelRequest(
  db,
  { userId, workspaceId = null, model, now = Date.now() },
) {
  if (typeof userId !== 'string' || userId === '') {
    throw new Error('startModelRequest requires a userId');
  }
  if (typeof model !== 'string' || model === '') {
    throw new Error('startModelRequest requires a model');
  }
  const id = randomUUID();
  await db.query(
    `INSERT INTO model_requests (id, user_id, workspace_id, model, status, started_at)
     VALUES ($1, $2, $3, $4, 'started', $5)`,
    [id, userId, workspaceId, model, new Date(now).toISOString()],
  );
  return { id };
}

// Complete a request. Usage is stored verbatim when the provider reported
// it; when omitted the row keeps its '{}' default (unknown, not zero).
export async function finishModelRequest(db, { id, usage, now = Date.now() } = {}) {
  const usageJson = usage === undefined || usage === null ? '{}' : JSON.stringify(usage);
  const { rows } = await db.query(
    `UPDATE model_requests
     SET status = 'completed', finished_at = $2, usage = $3::jsonb
     WHERE id = $1
     RETURNING *`,
    [id, new Date(now).toISOString(), usageJson],
  );
  if (!rows[0]) throw new Error(`model request ${id} not found`);
  return rows[0];
}

// Fail a request with a stable, locatable error code.
export async function failModelRequest(db, { id, errorCode, now = Date.now() } = {}) {
  if (typeof errorCode !== 'string' || errorCode.trim() === '') {
    throw new Error('failModelRequest requires an errorCode');
  }
  const { rows } = await db.query(
    `UPDATE model_requests
     SET status = 'failed', finished_at = $2, error_code = $3
     WHERE id = $1
     RETURNING *`,
    [id, new Date(now).toISOString(), errorCode],
  );
  if (!rows[0]) throw new Error(`model request ${id} not found`);
  return rows[0];
}
