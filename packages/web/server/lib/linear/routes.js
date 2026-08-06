import express from 'express';

function sendError(res, error, fallback) {
  const status = Number(error?.statusCode) || Number(error?.status) || 500;
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error?.message ?? fallback,
    ...(error?.link ? { link: error.link } : {}),
  });
}

/**
 * `/api/linear/*` routes. All handlers delegate to the Linear integration
 * runtime; responses never contain the API key (status exposes identity and
 * settings only).
 */
export function registerLinearRoutes(app, { runtime }) {
  const json = express.json({ limit: '1mb' });

  app.get('/api/linear/status', (req, res) => {
    try {
      res.json(runtime.getStatus());
    } catch (error) {
      sendError(res, error, 'Failed to read Linear status');
    }
  });

  app.post('/api/linear/connect', json, async (req, res) => {
    try {
      res.json(await runtime.connect({ apiKey: req.body?.apiKey }));
    } catch (error) {
      console.error('[Linear] Connect failed:', error?.message ?? error);
      if (!error?.statusCode && error?.authFailed) error.statusCode = 401;
      sendError(res, error, 'Failed to connect to Linear');
    }
  });

  app.post('/api/linear/disconnect', (req, res) => {
    try {
      res.json(runtime.disconnect());
    } catch (error) {
      sendError(res, error, 'Failed to disconnect from Linear');
    }
  });

  app.put('/api/linear/settings', json, (req, res) => {
    try {
      res.json({ settings: runtime.updateSettings(req.body ?? {}) });
    } catch (error) {
      sendError(res, error, 'Failed to update Linear settings');
    }
  });

  app.get('/api/linear/teams', async (req, res) => {
    try {
      res.json({ teams: await runtime.listTeams() });
    } catch (error) {
      if (!error?.statusCode && error?.authFailed) error.statusCode = 401;
      sendError(res, error, 'Failed to list Linear teams');
    }
  });

  app.get('/api/linear/links', (req, res) => {
    try {
      res.json({ links: runtime.listLinks() });
    } catch (error) {
      sendError(res, error, 'Failed to list Linear session links');
    }
  });

  app.delete('/api/linear/links/:issueId', (req, res) => {
    try {
      const removed = runtime.removeLink(req.params.issueId);
      if (!removed) {
        res.status(404).json({ error: 'Link not found' });
        return;
      }
      res.json({ removed: true });
    } catch (error) {
      sendError(res, error, 'Failed to remove Linear session link');
    }
  });

  app.post('/api/linear/issues/start', json, async (req, res) => {
    try {
      res.json(await runtime.startSessionFromIssue({
        issue: req.body?.issue,
        projectId: req.body?.projectId ?? null,
      }));
    } catch (error) {
      console.error('[Linear] Start from issue failed:', error?.message ?? error);
      if (!error?.statusCode && error?.authFailed) error.statusCode = 401;
      sendError(res, error, 'Failed to start a session from the Linear issue');
    }
  });

  app.post('/api/linear/poll', async (req, res) => {
    try {
      const result = await runtime.pollOnce();
      res.json({ started: result.started.length });
    } catch (error) {
      sendError(res, error, 'Failed to poll Linear');
    }
  });
}
