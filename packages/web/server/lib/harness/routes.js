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
import {
  getOrCreateSessionCapabilities,
} from './session-capabilities.js';
import { createHarnessRouter } from './router.js';
import { mergeHarnessBusyIntoSessionStatuses } from './session-status.js';
import { mergeHarnessMessagesIntoSessionMessages } from './session-messages.js';
import {
  createOpenCodeSessionFactory,
  importClaudeSessions,
  listClaudeImportCandidates,
} from './translators/claude-code/import-from-disk.js';

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
 * @param {typeof listClaudeImportCandidates} [deps.listClaudeImportCandidates]
 * @param {typeof importClaudeSessions} [deps.importClaudeSessions]
 * @param {(directory: string, title?: string | null) => Promise<string>} [deps.createOpenCodeSession]
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
    /**
     * GET an OpenCode path, or `null` when the overlay cannot be built.
     *
     * `null` means "no authoritative upstream answer" — callers fall through to
     * the generic proxy so the existing error contract is preserved rather than
     * turning an upstream failure into an empty success.
     *
     * @param {string} path
     * @param {Record<string, string>} query
     * @returns {Promise<unknown | null>}
     */
    const getFromOpenCode = async (path, query) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value) params.set(key, value);
      }
      const search = params.toString();
      const base = buildOpenCodeUrl(path, '');
      const response = await fetch(search ? `${base}?${search}` : base, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      return response.json().catch(() => null);
    };

    app.get('/api/session/status', async (req, res, next) => {
      try {
        const directory = typeof req.query?.directory === 'string' ? req.query.directory : '';
        const statuses = await getFromOpenCode('/session/status', { directory });
        if (statuses === null) return next();
        res.json(mergeHarnessBusyIntoSessionStatuses(statuses, directory));
      } catch {
        next();
      }
    });

    app.get('/api/session/:sessionId/message', async (req, res, next) => {
      try {
        const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
        if (!sessionId) return next();
        const messages = await getFromOpenCode(
          `/session/${encodeURIComponent(sessionId)}/message`,
          {
            directory: typeof req.query?.directory === 'string' ? req.query.directory : '',
            limit: typeof req.query?.limit === 'string' ? req.query.limit : '',
          },
        );
        if (messages === null) return next();
        res.json(mergeHarnessMessagesIntoSessionMessages(messages, sessionId));
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

  app.get('/api/harness/sessions/:sessionId/capabilities', (req, res) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required', code: 'PROMPT_INVALID' });
    }
    // Capabilities are useful before the first Claude turn (built-in slash
    // defaults). Binding may be absent for brand-new sessions that have only
    // selected Claude in the picker — still return defaults.
    const binding = getSessionBinding(sessionId);
    const capabilities = getOrCreateSessionCapabilities(sessionId);
    res.json({
      sessionId,
      harnessId: binding?.harnessId || 'claude-code',
      capabilities,
    });
  });

  // Claude Code local import — list candidates and bind OpenCode shells.
  // Registered before /api/harness/:id so path segments stay unambiguous.
  app.get('/api/harness/claude-code/import/candidates', async (_req, res) => {
    try {
      const listCandidates = typeof deps.listClaudeImportCandidates === 'function'
        ? deps.listClaudeImportCandidates
        : listClaudeImportCandidates;
      const payload = await listCandidates();
      res.json(payload);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/harness/claude-code/import', json, async (req, res) => {
    try {
      const body = req.body || {};
      const sessions = Array.isArray(body.sessions) ? body.sessions : null;
      if (!sessions) {
        return res.status(400).json({
          error: 'sessions array is required',
          code: 'IMPORT_INVALID',
        });
      }

      const createSession = typeof deps.createOpenCodeSession === 'function'
        ? deps.createOpenCodeSession
        : createOpenCodeSessionFactory({
          buildOpenCodeUrl,
          getOpenCodeAuthHeaders,
        });

      const importSessions = typeof deps.importClaudeSessions === 'function'
        ? deps.importClaudeSessions
        : importClaudeSessions;

      const payload = await importSessions({
        sessions,
        createSession,
      });
      res.json(payload);
    } catch (error) {
      sendError(res, error);
    }
  });

  // Read and re-probe are the same operation: detection is never cached, so GET
  // and POST share one handler.
  // Detect failure must not look like ready+empty success — the `status` field
  // on the returned engine is authoritative.
  const handleDetectOne = async (req, res) => {
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
  };

  app.get('/api/harness/:id', handleDetectOne);
  app.post('/api/harness/:id/detect', handleDetectOne);

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
