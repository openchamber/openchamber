/**
 * Agent Loop REST API routes.
 *
 * Registers endpoints for managing agent loops and workpackage files.
 */

import express from 'express';

/**
 * Register agent loop routes on the Express app.
 *
 * @param {import('express').Application} app
 * @param {function} getService - Getter returning the current AgentLoopService instance
 * @param {object} deps
 * @param {object} deps.fsPromises
 * @param {function} deps.resolveWorkspacePathFromContext
 * @param {function} deps.isPathWithinRoot
 * @param {object} deps.path
 * @param {function} deps.validateWorkpackageFile
 */
function registerAgentLoopRoutes(app, getService, deps) {
  const { fsPromises, resolveWorkspacePathFromContext, isPathWithinRoot, path, validateWorkpackageFile } = deps;

  // ── Workpackage file endpoints ──────────────────────────────────────────
  // These must be registered BEFORE the :id wildcard route to avoid
  // "workpackages" matching as an :id parameter.

  /** Read and validate a workpackage file */
  app.get('/api/agent-loop/workpackages', async (req, res) => {
    const filePath = typeof req.query.path === 'string' && req.query.path.trim().length > 0
      ? req.query.path.trim()
      : 'workpackage.json';

    try {
      const resolved = await resolveWorkspacePathFromContext(req, filePath);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const content = await fsPromises.readFile(canonicalPath, 'utf8');
      const parsed = JSON.parse(content);

      if (!validateWorkpackageFile(parsed)) {
        return res.status(400).json({ error: 'Invalid workpackage file structure' });
      }

      res.json(parsed);
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Workpackage file not found' });
      }
      if (err instanceof SyntaxError) {
        return res.status(400).json({ error: 'Workpackage file contains invalid JSON' });
      }
      console.error('Failed to read workpackage file:', error);
      res.status(500).json({ error: (error && error.message) || 'Failed to read workpackage file' });
    }
  });

  /** Atomically update a workpackage's status in the file */
  app.post('/api/agent-loop/workpackages/status', express.json(), async (req, res) => {
    const { id, status, sessionId, error: wpError } = req.body ?? {};
    const filePath = typeof req.body?.path === 'string' && req.body.path.trim().length > 0
      ? req.body.path.trim()
      : 'workpackage.json';

    if (typeof id !== 'string' || !id.trim()) {
      return res.status(400).json({ error: 'Workpackage id is required' });
    }
    const validStatuses = ['pending', 'running', 'completed', 'failed', 'skipped'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    try {
      const resolved = await resolveWorkspacePathFromContext(req, filePath);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const content = await fsPromises.readFile(canonicalPath, 'utf8');
      const parsed = JSON.parse(content);

      if (!validateWorkpackageFile(parsed)) {
        return res.status(400).json({ error: 'Invalid workpackage file structure' });
      }

      const wp = parsed.workpackages.find((w) => w.id === id);
      if (!wp) {
        return res.status(404).json({ error: `Workpackage with id "${id}" not found` });
      }

      wp.status = status;
      if (typeof sessionId === 'string') wp.sessionId = sessionId;
      if (typeof wpError === 'string') wp.error = wpError;

      await fsPromises.writeFile(canonicalPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      res.json(parsed);
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Workpackage file not found' });
      }
      if (err instanceof SyntaxError) {
        return res.status(400).json({ error: 'Workpackage file contains invalid JSON' });
      }
      console.error('Failed to update workpackage status:', error);
      res.status(500).json({ error: (error && error.message) || 'Failed to update workpackage status' });
    }
  });

  // ── Loop management endpoints ──────────────────────────────────────────

  /** Start a new agent loop */
  app.post('/api/agent-loop/start', express.json(), async (req, res) => {
    if (!getService()) { return res.status(503).json({ error: 'Agent loop service not available' }); }
    try {
      const { filePath, providerID, modelID, agent, variant, systemPrompt, directory } = req.body || {};

      if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'filePath is required' });
      }
      if (!providerID || typeof providerID !== 'string') {
        return res.status(400).json({ error: 'providerID is required' });
      }
      if (!modelID || typeof modelID !== 'string') {
        return res.status(400).json({ error: 'modelID is required' });
      }

      const loop = await getService().startLoop({
        filePath,
        directory: directory || undefined,
        providerID,
        modelID,
        agent: agent || undefined,
        variant: variant || undefined,
        systemPrompt: systemPrompt || undefined,
      });

      res.json({ loop });
    } catch (error) {
      console.error('[AgentLoopRoutes] start error:', error);
      res.status(500).json({ error: error.message || 'Failed to start agent loop' });
    }
  });

  /** List all loops */
  app.get('/api/agent-loop/loops', (req, res) => {
    if (!getService()) { return res.status(503).json({ error: 'Agent loop service not available' }); }
    res.json({ loops: getService().getAllLoops() });
  });

  /** Get a single loop by ID */
  app.get('/api/agent-loop/:id', (req, res) => {
    if (!getService()) { return res.status(503).json({ error: 'Agent loop service not available' }); }
    const loop = getService().getLoop(req.params.id);
    if (!loop) {
      return res.status(404).json({ error: 'Loop not found' });
    }
    res.json({ loop });
  });

  /** Pause a loop */
  app.post('/api/agent-loop/:id/pause', (req, res) => {
    if (!getService()) { return res.status(503).json({ error: 'Agent loop service not available' }); }
    const loop = getService().pauseLoop(req.params.id);
    if (!loop) {
      return res.status(404).json({ error: 'Loop not found or not running' });
    }
    res.json({ loop });
  });

  /** Resume a paused loop */
  app.post('/api/agent-loop/:id/resume', async (req, res) => {
    if (!getService()) { return res.status(503).json({ error: 'Agent loop service not available' }); }
    try {
      const loop = await getService().resumeLoop(req.params.id);
      if (!loop) {
        return res.status(404).json({ error: 'Loop not found or not paused' });
      }
      res.json({ loop });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Failed to resume loop' });
    }
  });

  /** Skip current task */
  app.post('/api/agent-loop/:id/skip', async (req, res) => {
    if (!getService()) { return res.status(503).json({ error: 'Agent loop service not available' }); }
    try {
      const loop = await getService().skipCurrent(req.params.id);
      if (!loop) {
        return res.status(404).json({ error: 'Loop not found or no skippable task' });
      }
      res.json({ loop });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Failed to skip task' });
    }
  });

  /** Retry from the first failed task */
  app.post('/api/agent-loop/:id/retry', async (req, res) => {
    if (!getService()) { return res.status(503).json({ error: 'Agent loop service not available' }); }
    try {
      const loop = await getService().retryFailed(req.params.id);
      if (!loop) {
        return res.status(404).json({ error: 'Loop not found, not in error/completed state, or no failed task' });
      }
      res.json({ loop });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Failed to retry loop' });
    }
  });

  /** Stop a loop entirely */
  app.post('/api/agent-loop/:id/stop', async (req, res) => {
    if (!getService()) { return res.status(503).json({ error: 'Agent loop service not available' }); }
    try {
      const loop = await getService().stopLoop(req.params.id);
      if (!loop) {
        return res.status(404).json({ error: 'Loop not found' });
      }
      res.json({ loop });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Failed to stop loop' });
    }
  });

  /** Update loop configuration (model, agent, variant) */
  app.post('/api/agent-loop/:id/config', express.json(), (req, res) => {
    if (!getService()) { return res.status(503).json({ error: 'Agent loop service not available' }); }
    const { providerID, modelID, agent, variant } = req.body || {};
    const loop = getService().updateConfig(req.params.id, { providerID, modelID, agent, variant });
    if (!loop) {
      return res.status(404).json({ error: 'Loop not found' });
    }
    res.json({ loop });
  });
}

export { registerAgentLoopRoutes };
