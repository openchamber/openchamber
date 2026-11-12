import express from 'express';
import { z } from 'zod';

import { asControlError } from '../openchamber-control/error.js';

const ACTIONS = new Set(['approve', 'decline', 'stop', 'resume']);
const listQuerySchema = z.union([
  z.object({ sessionId: z.string().trim().min(1) }),
  // Repeated for a project's folder and its worktrees.
  z.object({ directory: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1).max(100)]) }),
]);
const directoryQuerySchema = z.object({ directory: z.string().trim().min(1) });
const startBodySchema = z.object({
  directory: z.string().trim().min(1),
  // The project folder whose saved workflow runs, when the session is in a worktree.
  scriptDirectory: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).nullish(),
  name: z.string().trim().min(1),
  args: z.json().optional(),
});

/**
 * The user's side of workflow runs: the runs of a session for the chat, the
 * work-status panel and the Workflows panel, one run's log, script and result
 * and one agent's prompt and answer for that panel, and the approve, decline,
 * stop and resume buttons.
 * Registered only in builds with workflows.
 */
export const registerWorkflowRoutes = (app, runtime) => {
  app.get('/api/openchamber/workflows', async (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'sessionId or directory is required' });
    try {
      const runs = 'sessionId' in query.data
        ? await runtime.list({ sessionId: query.data.sessionId })
        : await runtime.listByDirectory({ directories: [query.data.directory].flat() });
      return res.json({ runs });
    } catch (error) {
      const controlError = asControlError(error, 'Could not read workflow runs');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  // Before /:runId, which would read "saved" as a run id.
  app.get('/api/openchamber/workflows/saved', async (req, res) => {
    const query = directoryQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'directory is required' });
    try {
      return res.json(await runtime.listSaved({ directory: query.data.directory }));
    } catch (error) {
      const controlError = asControlError(error, 'Could not read saved workflows');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.post('/api/openchamber/workflows/start', express.json({ limit: '64kb' }), async (req, res) => {
    const body = startBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'directory and name are required' });
    try {
      return res.json(await runtime.startSaved(body.data));
    } catch (error) {
      const controlError = asControlError(error, 'Could not start the workflow');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.get('/api/openchamber/workflows/:runId', async (req, res) => {
    try {
      return res.json(await runtime.detail({ runId: req.params.runId }));
    } catch (error) {
      const controlError = asControlError(error, 'Could not read the workflow run');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.get('/api/openchamber/workflows/:runId/agents/:key', async (req, res) => {
    try {
      return res.json(await runtime.agentDetail({ runId: req.params.runId, key: req.params.key }));
    } catch (error) {
      const controlError = asControlError(error, 'Could not read the workflow agent');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.delete('/api/openchamber/workflows/:runId', async (req, res) => {
    try {
      return res.json(await runtime.remove({ runId: req.params.runId }));
    } catch (error) {
      const controlError = asControlError(error, 'Could not delete the workflow run');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.post('/api/openchamber/workflows/:runId/:action', express.json({ limit: '4kb' }), async (req, res) => {
    const { runId, action } = req.params;
    if (!ACTIONS.has(action)) return res.status(404).json({ error: `Unknown workflow action: ${action}` });
    try {
      return res.json(await runtime[action]({ runId }));
    } catch (error) {
      const controlError = asControlError(error, `Could not ${action} the workflow`);
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });
};
