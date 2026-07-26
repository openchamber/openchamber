/**
 * Express route registration for /api/harness/*
 */

import express from 'express';
import { detectAllHarnesses, detectHarness } from './detect.js';
import { isKnownHarnessId } from './registry.js';
import {
  getSessionBinding,
  initSessionBindings,
} from './session-bindings.js';
import { createHarnessRouter } from './router.js';
import { mergeHarnessBusyIntoSessionStatuses } from './session-status.js';
import { mergeHarnessMessagesIntoSessionMessages } from './session-messages.js';

/**
 * @param {import('express').Express} app
 * @param {object} [deps]
 * @param {() => ((payload: object, options?: object) => void) | null | undefined} [deps.getBroadcastGlobalUiEvent]
 * @param {boolean | (() => boolean)} [deps.getOpenCodeReady]
 * @param {ReturnType<typeof createHarnessRouter>} [deps.router]
 * @param {typeof detectAllHarnesses} [deps.detectAll]
 * @param {typeof detectHarness} [deps.detectOne]
 * @param {Parameters<typeof initSessionBindings>[0]} [deps.sessionBindings]
 * @param {boolean} [deps.initBindings]
 * @param {(path: string, directory?: string) => string} [deps.buildOpenCodeUrl]
 * @param {() => Record<string, string>} [deps.getOpenCodeAuthHeaders]
 */
export function registerHarnessRoutes(app, deps = {}) {
  const getBroadcast = typeof deps.getBroadcastGlobalUiEvent === 'function'
    ? deps.getBroadcastGlobalUiEvent
    : () => null;
  const getOpenCodeReady = () => {
    if (typeof deps.getOpenCodeReady === 'function') return deps.getOpenCodeReady() !== false;
    if (typeof deps.getOpenCodeReady === 'boolean') return deps.getOpenCodeReady;
    return true;
  };
  const detectAll = deps.detectAll || detectAllHarnesses;
  const detectOne = deps.detectOne || detectHarness;
  const router = deps.router || createHarnessRouter({ getBroadcast });
  const buildOpenCodeUrl = typeof deps.buildOpenCodeUrl === 'function' ? deps.buildOpenCodeUrl : null;
  const getOpenCodeAuthHeaders = typeof deps.getOpenCodeAuthHeaders === 'function'
    ? deps.getOpenCodeAuthHeaders
    : () => ({});

  if (deps.initBindings !== false) {
    initSessionBindings(deps.sessionBindings);
  }

  const json = express.json({ limit: '50mb' });

  const sendError = (res, error) => {
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) {
      console.error('[harness]', error?.code || 'HARNESS_ERROR', error?.message || error);
    }
    res.status(statusCode).json({
      error: error?.message || 'Harness request failed',
      code: error?.code || 'HARNESS_ERROR',
      ...(error?.status ? { status: error.status } : {}),
    });
  };

  // Overlay Claude busy onto OpenCode session status so UI poll/resync cannot
  // clear Stop / queue auto-send while a harness turn is active.
  // Also overlay harness turn-snapshot messages onto /session/:id/message —
  // OpenCode stores nothing for Claude turns, and an authoritative empty
  // refetch would wipe optimistic / event-applied chat (and stall the queue).
  if (buildOpenCodeUrl) {
    app.get('/api/session/status', async (req, res, next) => {
      try {
        const directory = typeof req.query?.directory === 'string' ? req.query.directory : '';
        const base = buildOpenCodeUrl('/session/status', '');
        const url = directory
          ? `${base}?directory=${encodeURIComponent(directory)}`
          : base;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...getOpenCodeAuthHeaders(),
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          // Fall through to generic OpenCode proxy on upstream failure so the
          // existing error contract is preserved when no harness overlay is needed.
          return next();
        }
        const openCodeStatuses = await response.json().catch(() => ({}));
        res.json(mergeHarnessBusyIntoSessionStatuses(openCodeStatuses, directory));
      } catch {
        next();
      }
    });

    app.get('/api/session/:sessionId/message', async (req, res, next) => {
      try {
        const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
        if (!sessionId) return next();
        const directory = typeof req.query?.directory === 'string' ? req.query.directory : '';
        const limit = typeof req.query?.limit === 'string' ? req.query.limit : '';
        const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
        const params = new URLSearchParams();
        if (directory) params.set('directory', directory);
        if (limit) params.set('limit', limit);
        const search = params.toString();
        const url = search ? `${base}?${search}` : base;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...getOpenCodeAuthHeaders(),
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          return next();
        }
        const openCodeMessages = await response.json().catch(() => []);
        res.json(mergeHarnessMessagesIntoSessionMessages(openCodeMessages, sessionId));
      } catch {
        next();
      }
    });
  }

  app.get('/api/harness', async (_req, res) => {
    try {
      const engines = await detectAll({ openCodeReady: getOpenCodeReady() });
      res.json({ engines });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/harness/sessions/:sessionId', (req, res) => {
    const binding = getSessionBinding(req.params.sessionId);
    if (!binding) {
      return res.status(404).json({ error: 'Session binding not found', code: 'BINDING_NOT_FOUND' });
    }
    res.json({ binding });
  });

  app.get('/api/harness/:id', async (req, res) => {
    const id = req.params.id;
    if (!isKnownHarnessId(id)) {
      return res.status(404).json({ error: 'Unknown harness', code: 'HARNESS_NOT_FOUND' });
    }
    try {
      const engine = await detectOne(id, { openCodeReady: getOpenCodeReady() });
      if (!engine) {
        return res.status(404).json({ error: 'Unknown harness', code: 'HARNESS_NOT_FOUND' });
      }
      res.json(engine);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/harness/:id/detect', async (req, res) => {
    const id = req.params.id;
    if (!isKnownHarnessId(id)) {
      return res.status(404).json({ error: 'Unknown harness', code: 'HARNESS_NOT_FOUND' });
    }
    try {
      const engine = await detectOne(id, { openCodeReady: getOpenCodeReady() });
      if (!engine) {
        return res.status(404).json({ error: 'Unknown harness', code: 'HARNESS_NOT_FOUND' });
      }
      // Detect failure must not look like ready+empty success — status field is authoritative.
      res.json(engine);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/harness/prompt', json, async (req, res) => {
    try {
      const result = await router.prompt(req.body || {});
      res.status(202).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/harness/abort', json, async (req, res) => {
    try {
      const result = await router.abort(req.body || {});
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/harness/permission/reply', json, async (req, res) => {
    try {
      if (typeof router.replyPermission !== 'function') {
        const error = new Error('Permission reply is unavailable');
        error.code = 'PERMISSION_UNAVAILABLE';
        error.statusCode = 503;
        throw error;
      }
      const result = await router.replyPermission(req.body || {});
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });
}
