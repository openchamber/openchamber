import express from 'express';

const BROWSER_ACTION_PATHS = Object.freeze({
  '/api/browser/tab/create': 'tab.create',
  '/api/browser/tab/close': 'tab.close',
  '/api/browser/tab/select': 'tab.select',
  '/api/browser/navigate': 'navigate',
  '/api/browser/click': 'click',
  '/api/browser/move': 'move',
  '/api/browser/scroll': 'scroll',
  '/api/browser/type': 'type',
  '/api/browser/key': 'key',
  '/api/browser/evaluate': 'evaluate',
  '/api/browser/wait': 'wait',
  '/api/browser/viewport': 'viewport',
  '/api/browser/screenshot': 'screenshot',
  '/api/browser/recording/start': 'recording.start',
  '/api/browser/recording/stop': 'recording.stop',
});

// Actions that mutate state require a running browser; everything is routed
// through the runtime's single dispatch surface so validation stays in one place.
export const registerBrowserRoutes = (app, { browserRuntime }) => {
  const jsonParser = express.json({ limit: '1mb' });

  app.get('/api/browser/state', (_req, res) => {
    res.json(browserRuntime.state());
  });

  app.get('/api/browser/artifacts', async (_req, res) => {
    try {
      res.json({ artifacts: await browserRuntime.listArtifacts() });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to list browser artifacts' });
    }
  });

  app.get('/api/browser/artifacts/:id', async (req, res) => {
    const artifact = await browserRuntime.readArtifact(req.params.id);
    if (!artifact) {
      res.status(404).json({ error: 'Browser artifact not found' });
      return;
    }
    res.setHeader('content-type', artifact.contentType);
    res.setHeader('cache-control', 'private, max-age=31536000, immutable');
    res.send(artifact.buffer);
  });

  for (const [routePath, action] of Object.entries(BROWSER_ACTION_PATHS)) {
    app.post(routePath, jsonParser, async (req, res) => {
      try {
        const result = await browserRuntime.executeAction(action, req.body ?? {});
        res.json(result);
      } catch (error) {
        res.status(400).json({ error: error?.message || `Failed to execute ${action}` });
      }
    });
  }
};
