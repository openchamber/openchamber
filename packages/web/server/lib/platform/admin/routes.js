// Platform admin routes (plan sections 7.2 and 9.1):
//   GET  /api/platform/admin/users                        user list (admin)
//   GET  /api/platform/admin/workspaces                   workspace states + resources (admin)
//   POST /api/platform/admin/workspaces/:id/stop          stop a user's environment (reason required)
//   POST /api/platform/admin/workspaces/:id/rebuild       rebuild keeping data (reason required, generation check)
//   GET  /api/platform/admin/audit-events                 paginated audit read (filter allowlist)
//
// Same registration contract as the auth/workspace routes: a complete no-op
// when the platform is disabled. Guards mirror auth/routes.js and
// workspaces/routes.js so the modules stay independently registerable; the
// admin role itself is re-read from the database on EVERY request by
// admin-guard.js (no stale caching).
//
// Stop/rebuild do NOT fork workspace logic: they call the exact same
// operations-service pipeline the user's own routes use, with the admin as
// `requested_by` and the operator reason persisted on the operation row.

import { randomUUID } from 'node:crypto';

import express from 'express';

import { isPlatformEnabled, createMigratedPlatformDb } from '../index.js';
import { writeAuditEvent } from '../audit/audit-writer.js';
import {
  readSessionCookie,
  resolvePlatformSession,
} from '../auth/sessions.js';
import {
  WorkspaceServiceError,
  getWorkspaceById,
  rebuildWorkspace,
  stopWorkspace,
} from '../workspaces/operations-service.js';
import { AdminServiceError, listAuditEvents, listUsers, listWorkspaces } from './admin-service.js';
import { requirePlatformAdmin } from './admin-guard.js';

const AUDIT_ACTIONS = Object.freeze({
  usersRead: 'platform.admin.users.read',
  workspacesRead: 'platform.admin.workspaces.read',
  workspaceStop: 'platform.admin.workspaces.stop',
  workspaceRebuild: 'platform.admin.workspaces.rebuild',
  auditRead: 'platform.admin.audit.read',
});

const requireCsrfHeader = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  if (typeof req.get('x-requested-with') === 'string' && req.get('x-requested-with').length > 0) {
    return next();
  }
  return res.status(403).json({
    error: 'csrf_header_required',
    request_id: req.platformRequestId,
  });
};

export async function registerPlatformAdminRoutes(app, options = {}) {
  const {
    env = process.env,
    logger = console,
    db: dbOverride = null,
    driver = null,
  } = options;

  if (!dbOverride && !isPlatformEnabled()) {
    return { enabled: false };
  }

  const db = dbOverride ?? await createMigratedPlatformDb();

  app.use(['/api/platform'], (req, _res, next) => {
    if (!req.platformRequestId) req.platformRequestId = randomUUID();
    next();
  });

  const requirePlatformSession = async (req, res, next) => {
    try {
      const token = readSessionCookie(req);
      const resolved = token ? await resolvePlatformSession(db, { token }) : null;
      // Expired, revoked, unknown, disabled and unbound all answer with the
      // same 401 - the caller cannot distinguish another account's state.
      if (!resolved || resolved.user.status !== 'active') {
        return res.status(401).json({
          error: 'unauthenticated',
          request_id: req.platformRequestId,
        });
      }
      req.platformUser = resolved.user;
      req.platformSession = resolved.session;
      return next();
    } catch (error) {
      logger.error?.(`[platform-admin] session lookup failed: ${error?.message || error}`);
      return res.status(500).json({
        error: 'internal_error',
        request_id: req.platformRequestId,
      });
    }
  };

  const adminGuard = requirePlatformAdmin(db);

  const errorResponse = (req, res, error) => {
    if (error instanceof AdminServiceError || error instanceof WorkspaceServiceError) {
      return res.status(error.status).json({
        error: error.code,
        request_id: req.platformRequestId,
      });
    }
    logger.error?.(`[platform-admin] request failed: ${error?.message || error}`);
    return res.status(500).json({
      error: 'internal_error',
      request_id: req.platformRequestId,
    });
  };

  // Every admin attempt is audited with the platform request id, success and
  // failure alike (plan section 11.3). Best-effort, matching the rest of the
  // platform: an audit write failure must not mask the operation result.
  const auditAdmin = async (req, { action, targetUserId = null, workspaceId = null, outcome }) => {
    try {
      await writeAuditEvent(db, {
        actorUserId: req.platformUser.id,
        targetUserId,
        workspaceId,
        action,
        requestId: req.platformRequestId,
        outcome,
      });
    } catch (error) {
      logger.warn?.(`[platform-admin] failed to write audit event: ${error?.message || error}`);
    }
  };

  const requireReason = (req, res) => {
    const reason = req.body?.reason;
    if (typeof reason !== 'string' || reason.trim() === '') {
      res.status(400).json({
        error: 'reason_required',
        request_id: req.platformRequestId,
      });
      return null;
    }
    return reason.trim();
  };

  const operationView = (operation) => (operation ? {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    generation: operation.generation,
  } : null);

  // Driver-reported active tasks for the admin-stop confirmation (plan
  // section 8.5). Absent driver or a failed inspection report null, never a
  // fabricated number.
  const inspectActiveTasks = async (workspace) => {
    if (!driver || typeof driver.inspectWorkspace !== 'function') return null;
    try {
      const inspected = await driver.inspectWorkspace({ workspace });
      return Number.isInteger(inspected?.activeTasks) ? inspected.activeTasks : null;
    } catch {
      return null;
    }
  };

  app.get(
    '/api/platform/admin/users',
    requirePlatformSession,
    adminGuard,
    async (req, res) => {
      try {
        const result = await listUsers(db, {
          limit: req.query.limit,
          offset: req.query.offset,
        });
        await auditAdmin(req, { action: AUDIT_ACTIONS.usersRead, outcome: 'success' });
        return res.status(200).json({ ...result, request_id: req.platformRequestId });
      } catch (error) {
        await auditAdmin(req, { action: AUDIT_ACTIONS.usersRead, outcome: 'failure' });
        return errorResponse(req, res, error);
      }
    },
  );

  app.get(
    '/api/platform/admin/workspaces',
    requirePlatformSession,
    adminGuard,
    async (req, res) => {
      try {
        const result = await listWorkspaces(db, { driver });
        await auditAdmin(req, { action: AUDIT_ACTIONS.workspacesRead, outcome: 'success' });
        return res.status(200).json({ ...result, request_id: req.platformRequestId });
      } catch (error) {
        await auditAdmin(req, { action: AUDIT_ACTIONS.workspacesRead, outcome: 'failure' });
        return errorResponse(req, res, error);
      }
    },
  );

  // JSON body parser mounted per-route (upstream style): the common request
  // middleware intentionally skips /api paths, so platform POST routes must
  // attach their own parser or req.body stays undefined in production.
  const parseJsonBody = express.json({ limit: '64kb' });

  app.post(
    '/api/platform/admin/workspaces/:id/stop',
    requirePlatformSession,
    adminGuard,
    requireCsrfHeader,
    parseJsonBody,
    async (req, res) => {
      const reason = requireReason(req, res);
      if (reason === null) {
        return auditAdmin(req, { action: AUDIT_ACTIONS.workspaceStop, outcome: 'failure' });
      }
      try {
        const workspace = await getWorkspaceById(db, { workspaceId: req.params.id });
        if (!workspace) {
          await auditAdmin(req, { action: AUDIT_ACTIONS.workspaceStop, outcome: 'failure' });
          return res.status(404).json({
            error: 'workspace_not_found',
            request_id: req.platformRequestId,
          });
        }
        const activeTasks = await inspectActiveTasks(workspace);
        // The SAME operations pipeline as the user's own stop: idempotent
        // repeat returns the current state instead of duplicating work.
        const result = await stopWorkspace(db, {
          user: req.platformUser,
          workspaceId: workspace.id,
          requestId: req.platformRequestId,
          reason,
          logger,
        });
        await auditAdmin(req, {
          action: AUDIT_ACTIONS.workspaceStop,
          targetUserId: workspace.owner_user_id,
          workspaceId: workspace.id,
          outcome: 'success',
        });
        if (result.status === 'already_stopped') {
          return res.status(200).json({
            workspace: result.workspace,
            operation: null,
            active_tasks: activeTasks,
            request_id: req.platformRequestId,
          });
        }
        return res.status(202).json({
          workspace: result.workspace,
          operation: operationView(result.operation),
          active_tasks: activeTasks,
          request_id: req.platformRequestId,
        });
      } catch (error) {
        await auditAdmin(req, { action: AUDIT_ACTIONS.workspaceStop, outcome: 'failure' });
        return errorResponse(req, res, error);
      }
    },
  );

  app.post(
    '/api/platform/admin/workspaces/:id/rebuild',
    requirePlatformSession,
    adminGuard,
    requireCsrfHeader,
    parseJsonBody,
    async (req, res) => {
      const reason = requireReason(req, res);
      if (reason === null) {
        return auditAdmin(req, { action: AUDIT_ACTIONS.workspaceRebuild, outcome: 'failure' });
      }
      try {
        const workspace = await getWorkspaceById(db, { workspaceId: req.params.id });
        if (!workspace) {
          await auditAdmin(req, { action: AUDIT_ACTIONS.workspaceRebuild, outcome: 'failure' });
          return res.status(404).json({
            error: 'workspace_not_found',
            request_id: req.platformRequestId,
          });
        }
        // Optional caller-side generation check (plan section 9.1): when the
        // admin UI passes the generation it observed, a drifted workspace is
        // rejected instead of silently targeting a newer incarnation.
        if (req.body?.expected_generation !== undefined
          && req.body.expected_generation !== workspace.generation) {
          await auditAdmin(req, {
            action: AUDIT_ACTIONS.workspaceRebuild,
            targetUserId: workspace.owner_user_id,
            workspaceId: workspace.id,
            outcome: 'failure',
          });
          return res.status(409).json({
            error: 'generation_conflict',
            request_id: req.platformRequestId,
          });
        }
        const result = await rebuildWorkspace(db, {
          user: req.platformUser,
          workspaceId: workspace.id,
          requestId: req.platformRequestId,
          reason,
          logger,
        });
        await auditAdmin(req, {
          action: AUDIT_ACTIONS.workspaceRebuild,
          targetUserId: workspace.owner_user_id,
          workspaceId: workspace.id,
          outcome: 'success',
        });
        return res.status(202).json({
          workspace: result.workspace,
          operation: operationView(result.operation),
          request_id: req.platformRequestId,
        });
      } catch (error) {
        await auditAdmin(req, { action: AUDIT_ACTIONS.workspaceRebuild, outcome: 'failure' });
        return errorResponse(req, res, error);
      }
    },
  );

  app.get(
    '/api/platform/admin/audit-events',
    requirePlatformSession,
    adminGuard,
    async (req, res) => {
      try {
        const filters = {};
        for (const key of ['actor_user_id', 'target_user_id', 'workspace_id', 'action', 'outcome', 'created_from', 'created_to']) {
          if (req.query[key] !== undefined) filters[key] = req.query[key];
        }
        const result = await listAuditEvents(db, {
          filters,
          limit: req.query.limit,
          offset: req.query.offset,
        });
        await auditAdmin(req, { action: AUDIT_ACTIONS.auditRead, outcome: 'success' });
        return res.status(200).json({ ...result, request_id: req.platformRequestId });
      } catch (error) {
        await auditAdmin(req, { action: AUDIT_ACTIONS.auditRead, outcome: 'failure' });
        return errorResponse(req, res, error);
      }
    },
  );

  return { enabled: true, db };
}
