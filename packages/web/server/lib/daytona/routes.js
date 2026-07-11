// Daytona sandbox management HTTP routes.
//
// Follows the registerXxxRoutes(app, dependencies) pattern used by other
// server modules. Registers REST endpoints for sandbox lifecycle (create,
// destroy, status, list) and an activity heartbeat endpoint.

import express from 'express';

/**
 * Register Daytona sandbox management routes on the Express app.
 *
 * @param {import('express').Application} app - Express application instance.
 * @param {{
 *   daytonaService: ReturnType<typeof import('./service.js').createDaytonaService>,
 *   uiAuthController?: { enabled: boolean, requireAuth: Function } | null,
 *   logger?: Pick<Console, 'log' | 'warn' | 'error'>,
 * }} dependencies
 */
export const registerDaytonaRoutes = (app, { daytonaService, uiAuthController = null, logger = console }) => {
  const { lifecycle, registry, monitor } = daytonaService;

  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  // Apply authentication when the UI auth controller is enabled.
  if (uiAuthController && uiAuthController.enabled && typeof uiAuthController.requireAuth === 'function') {
    router.use((req, res, next) => uiAuthController.requireAuth(req, res, next));
  }

  // POST /api/daytona/sandbox - Create a new sandbox for a chat session.
  router.post('/sandbox', async (req, res) => {
    const { sessionId } = req.body || {};

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required and must be a string' });
    }

    try {
      const result = await lifecycle.createSandbox(sessionId);
      monitor.resetTimer(sessionId);

      logger.log(`[Daytona] Sandbox created via API for session ${sessionId}`);

      return res.status(201).json({
        sandboxId: result.sandboxId,
        sessionId,
        status: 'running',
        openCodeUrl: result.openCodeUrl,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`[Daytona] Failed to create sandbox for session ${sessionId}: ${error?.message ?? error}`);
      return res.status(500).json({ error: 'Failed to create sandbox', detail: error?.message ?? String(error) });
    }
  });

  // DELETE /api/daytona/sandbox/:sessionId - Destroy a sandbox (exit command).
  router.delete('/sandbox/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    try {
      const entry = registry.get(sessionId);
      if (!entry) {
        return res.status(404).json({ error: 'No sandbox found for this session' });
      }

      await lifecycle.destroySandbox(sessionId);

      logger.log(`[Daytona] Sandbox destroyed via API for session ${sessionId}`);

      return res.json({ success: true, sessionId });
    } catch (error) {
      logger.error(`[Daytona] Failed to destroy sandbox for session ${sessionId}: ${error?.message ?? error}`);
      return res.status(500).json({ error: 'Failed to destroy sandbox', detail: error?.message ?? String(error) });
    }
  });

  // GET /api/daytona/sandbox/:sessionId/status - Get sandbox status and health.
  router.get('/sandbox/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    const entry = registry.get(sessionId);

    if (!entry) {
      return res.status(404).json({ error: 'No sandbox found for this session' });
    }

    return res.json({
      sessionId: entry.sessionId,
      sandboxId: entry.sandboxId,
      status: entry.status,
      openCodeUrl: entry.openCodeUrl,
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt,
    });
  });

  // GET /api/daytona/sandboxes - List all active sandboxes.
  router.get('/sandboxes', (_req, res) => {
    const active = registry.listActive();
    return res.json({
      count: active.length,
      sandboxes: active.map((entry) => ({
        sessionId: entry.sessionId,
        sandboxId: entry.sandboxId,
        status: entry.status,
        createdAt: entry.createdAt,
        lastActivityAt: entry.lastActivityAt,
      })),
    });
  });

  // POST /api/daytona/sandbox/:sessionId/activity - Heartbeat to reset inactivity timer.
  router.post('/sandbox/:sessionId/activity', (req, res) => {
    const { sessionId } = req.params;
    const entry = registry.get(sessionId);

    if (!entry) {
      return res.status(404).json({ error: 'No sandbox found for this session' });
    }

    monitor.resetTimer(sessionId);

    return res.json({ success: true, sessionId, lastActivityAt: Date.now() });
  });

  app.use('/api/daytona', router);
};
