// Platform workspace routes (plan section 9.1):
//   GET  /api/platform/workspace           current user's workspace state
//   POST /api/platform/workspace/start     idempotent start (no container params)
//   GET  /api/platform/operations/:id      operation progress (owner or admin)
//
// Same registration contract as the auth routes: a complete no-op when the
// platform is disabled. Guards (request id, session, CSRF) are built from the
// shared auth primitives; they intentionally mirror auth/routes.js so the two
// modules stay independently registerable and testable.

import { randomUUID } from 'node:crypto';

import express from 'express';

import { isPlatformEnabled, createMigratedPlatformDb } from '../index.js';
import {
  readSessionCookie,
  resolvePlatformSession,
} from '../auth/sessions.js';
import {
  WorkspaceServiceError,
  ensureWorkspaceForUser,
  getOperationForUser,
  startWorkspace,
  toWorkspaceView,
} from './operations-service.js';

// POST /workspace/start must not accept arbitrary container configuration
// (plan section 8.1: the request only expresses "start my environment").
const FORBIDDEN_START_PARAMETERS = ['image', 'mount', 'mounts', 'host', 'uid', 'gid', 'user', 'ports', 'privileged'];

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

export async function registerPlatformWorkspaceRoutes(app, options = {}) {
  const { env = process.env, logger = console, db: dbOverride = null } = options;

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
      logger.error?.(`[platform-workspaces] session lookup failed: ${error?.message || error}`);
      return res.status(500).json({
        error: 'internal_error',
        request_id: req.platformRequestId,
      });
    }
  };

  const errorResponse = (req, res, error) => {
    if (error instanceof WorkspaceServiceError) {
      return res.status(error.status).json({
        error: error.code,
        request_id: req.platformRequestId,
      });
    }
    logger.error?.(`[platform-workspaces] request failed: ${error?.message || error}`);
    return res.status(500).json({
      error: 'internal_error',
      request_id: req.platformRequestId,
    });
  };

  app.get('/api/platform/workspace', requirePlatformSession, async (req, res) => {
    try {
      // Ownership comes from the server-side session identity only.
      const workspace = await ensureWorkspaceForUser(db, { userId: req.platformUser.id });
      return res.status(200).json({
        workspace: toWorkspaceView(workspace),
        request_id: req.platformRequestId,
      });
    } catch (error) {
      return errorResponse(req, res, error);
    }
  });

  // JSON body parser mounted per-route (upstream style): the common request
  // middleware intentionally skips /api paths, so platform POST routes must
  // attach their own parser or req.body stays undefined in production.
  const parseJsonBody = express.json({ limit: '64kb' });

  app.post(
    '/api/platform/workspace/start',
    requirePlatformSession,
    requireCsrfHeader,
    parseJsonBody,
    async (req, res) => {
      try {
        const supplied = FORBIDDEN_START_PARAMETERS.filter(
          (key) => req.body?.[key] !== undefined,
        );
        if (supplied.length > 0) {
          return res.status(400).json({
            error: 'unsupported_parameter',
            request_id: req.platformRequestId,
          });
        }
        const result = await startWorkspace(db, {
          user: req.platformUser,
          requestId: req.platformRequestId,
          logger,
        });
        // plan section 9.1: async operations answer 202 with the operation id.
        // A healthy workspace answers 200 with no new operation. The service
        // already returns public workspace views - do not remap them.
        if (result.status === 'healthy') {
          return res.status(200).json({
            workspace: result.workspace,
            operation: null,
            request_id: req.platformRequestId,
          });
        }
        return res.status(202).json({
          workspace: result.workspace,
          operation: {
            id: result.operation.id,
            kind: result.operation.kind,
            status: result.operation.status,
            generation: result.operation.generation,
          },
          request_id: req.platformRequestId,
        });
      } catch (error) {
        return errorResponse(req, res, error);
      }
    },
  );

  app.get('/api/platform/operations/:id', requirePlatformSession, async (req, res) => {
    try {
      const operation = await getOperationForUser(db, {
        user: req.platformUser,
        operationId: req.params.id,
      });
      return res.status(200).json({
        operation: {
          id: operation.id,
          workspace_id: operation.workspaceId,
          kind: operation.kind,
          status: operation.status,
          generation: operation.generation,
          requested_at: operation.requestedAt,
          started_at: operation.startedAt,
          finished_at: operation.finishedAt,
          error_code: operation.errorCode,
        },
        request_id: req.platformRequestId,
      });
    } catch (error) {
      return errorResponse(req, res, error);
    }
  });

  return { enabled: true, db };
}
