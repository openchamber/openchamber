// Admin read models (plan sections 7.2 and 9.1): user list, workspace list
// with optional driver-reported resources, and paginated audit-event reads
// with a strict filter allowlist.
//
// Listing shape rules:
//   - user rows expose identity/role/status only - never uid/gid/home paths,
//     issuer/subject identifiers or anything credential-like;
//   - workspace rows reuse the public workspace view (no runtime_id,
//     internal_endpoint or credential_ref, plan section 7.3) plus the owner's
//     display name;
//   - driver-reported resources are surfaced only when a runtime driver is
//     wired into the route registration. When it is not (or inspection
//     fails), the value is null - absent data is reported as null, never
//     invented (plan section 11.2 honesty rule).

import { toWorkspaceView } from '../workspaces/operations-service.js';

// Domain error with a stable machine-readable code and HTTP-ish status, the
// same pattern as workspaces/operations-service.js.
export class AdminServiceError extends Error {
  constructor(code, { status = 400, message } = {}) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

export const AUDIT_EVENT_COLUMNS = Object.freeze([
  'id',
  'actor_user_id',
  'target_user_id',
  'workspace_id',
  'action',
  'request_id',
  'outcome',
  'created_at',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AUDIT_FILTER_KEYS = Object.freeze([
  'actor_user_id',
  'target_user_id',
  'workspace_id',
  'action',
  'outcome',
  'created_from',
  'created_to',
]);

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

function parsePageSize(raw, name) {
  if (raw === undefined) return name === 'limit' ? DEFAULT_PAGE_SIZE : 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || (name === 'limit' && (value < 1 || value > MAX_PAGE_SIZE))
    || (name === 'offset' && value < 0)) {
    throw new AdminServiceError('invalid_pagination', {
      message: `${name} must be an integer${name === 'limit' ? ` between 1 and ${MAX_PAGE_SIZE}` : ' >= 0'}`,
    });
  }
  return value;
}

function requireUuid(value, name) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AdminServiceError('invalid_filter', { message: `${name} must be a uuid` });
  }
  return value;
}

function requireTimestamp(value, name) {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || Number.isNaN(parsed)) {
    throw new AdminServiceError('invalid_filter', { message: `${name} must be an ISO-8601 timestamp` });
  }
  return new Date(parsed).toISOString();
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdminServiceError('invalid_filter', { message: `${name} must be a non-empty string` });
  }
  return value;
}

export async function listUsers(db, { limit, offset } = {}) {
  const pageSize = parsePageSize(limit, 'limit');
  const pageOffset = parsePageSize(offset, 'offset');
  const { rows } = await db.query(
    `SELECT id, display_name, role, status, created_at
     FROM users
     ORDER BY created_at ASC, id ASC
     LIMIT $1 OFFSET $2`,
    [pageSize, pageOffset],
  );
  const { rows: countRows } = await db.query('SELECT COUNT(*) AS total FROM users');
  return {
    users: rows.map((row) => ({
      id: row.id,
      display_name: row.display_name,
      role: row.role,
      status: row.status,
      created_at: row.created_at,
    })),
    total: Number(countRows[0].total),
  };
}

// driver: a RuntimeDriver (workspaces/runtime-driver.js) or null. Inspection
// failures and a missing driver both map to resources: null - the admin view
// reports absent data honestly instead of guessing.
export async function listWorkspaces(db, { driver = null } = {}) {
  const { rows } = await db.query(
    `SELECT w.*, u.display_name AS owner_display_name
     FROM workspaces w
     JOIN users u ON u.id = w.owner_user_id
     ORDER BY w.created_at ASC, w.id ASC`,
  );
  const workspaces = [];
  for (const row of rows) {
    let resources = null;
    if (driver && typeof driver.inspectWorkspace === 'function') {
      try {
        const inspected = await driver.inspectWorkspace({ workspace: row });
        if (inspected && typeof inspected === 'object') {
          resources = {
            state: inspected.state ?? null,
            active_tasks: Number.isInteger(inspected.activeTasks) ? inspected.activeTasks : null,
          };
        }
      } catch {
        resources = null;
      }
    }
    workspaces.push({
      ...toWorkspaceView(row),
      owner_display_name: row.owner_display_name,
      resources,
    });
  }
  return { workspaces, total: workspaces.length };
}

// Audit-event query with a strict filter allowlist (plan section 9.1):
// actor_user_id, target_user_id, workspace_id, action, outcome and a created
// range. Anything else is ignored rather than applied. Events are returned
// metadata-only - the column list above is the complete shape.
export async function listAuditEvents(db, { filters = {}, limit, offset } = {}) {
  const pageSize = parsePageSize(limit, 'limit');
  const pageOffset = parsePageSize(offset, 'offset');

  const conditions = [];
  const values = [];
  const addCondition = (fragment, value) => {
    values.push(value);
    conditions.push(`${fragment} $${values.length}`);
  };

  if (filters.actor_user_id !== undefined) {
    addCondition('actor_user_id =', requireUuid(filters.actor_user_id, 'actor_user_id'));
  }
  if (filters.target_user_id !== undefined) {
    addCondition('target_user_id =', requireUuid(filters.target_user_id, 'target_user_id'));
  }
  if (filters.workspace_id !== undefined) {
    addCondition('workspace_id =', requireUuid(filters.workspace_id, 'workspace_id'));
  }
  if (filters.action !== undefined) {
    addCondition('action =', requireNonEmptyString(filters.action, 'action'));
  }
  if (filters.outcome !== undefined) {
    addCondition('outcome =', requireNonEmptyString(filters.outcome, 'outcome'));
  }
  if (filters.created_from !== undefined) {
    addCondition('created_at >=', requireTimestamp(filters.created_from, 'created_from'));
  }
  if (filters.created_to !== undefined) {
    addCondition('created_at <=', requireTimestamp(filters.created_to, 'created_to'));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT ${AUDIT_EVENT_COLUMNS.join(', ')}
     FROM audit_events
     ${where}
     ORDER BY created_at ASC, id ASC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, pageOffset],
  );
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS total FROM audit_events ${where}`,
    values,
  );
  return {
    events: rows.map((row) => ({
      id: row.id,
      actor_user_id: row.actor_user_id,
      target_user_id: row.target_user_id,
      workspace_id: row.workspace_id,
      action: row.action,
      request_id: row.request_id,
      outcome: row.outcome,
      created_at: row.created_at,
    })),
    total: Number(countRows[0].total),
  };
}
