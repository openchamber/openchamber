import express from 'express';
import {
  getHostBrowserProbe,
  installManagedBrowser,
  shouldDefaultNoSandbox,
} from './install.js';
import { BROWSER_AGENT_CONTROLLING_CODE, BrowserAgentControllingError } from './control.js';

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

const isAgentControllingError = (error) => (
  error instanceof BrowserAgentControllingError
  || error?.code === BROWSER_AGENT_CONTROLLING_CODE
);

// Actions that mutate state require a running browser; everything is routed
// through the runtime's single dispatch surface so validation stays in one place.
export const registerBrowserRoutes = (app, { browserRuntime, dataDir, persistSettings }) => {
  const jsonParser = express.json({ limit: '1mb' });
  let installPromise = null;

  app.get('/api/browser/state', (_req, res) => {
    res.json(browserRuntime.state());
  });

  app.get('/api/browser/status', (_req, res) => {
    const probe = getHostBrowserProbe();
    const status = typeof browserRuntime.status === 'function' ? browserRuntime.status() : browserRuntime.state();
    res.json({
      ...status,
      ...probe,
      recommendedNoSandbox: shouldDefaultNoSandbox(),
    });
  });

  app.post('/api/browser/reload', async (_req, res) => {
    try {
      const status = typeof browserRuntime.reloadConfiguration === 'function'
        ? await browserRuntime.reloadConfiguration()
        : browserRuntime.state();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to reload browser configuration' });
    }
  });

  app.post('/api/browser/install', async (_req, res) => {
    if (installPromise) {
      res.status(409).json({ error: 'A browser install is already in progress' });
      return;
    }
    const probe = getHostBrowserProbe();
    if (!probe.installSupported) {
      res.status(400).json({
        error: `Managed browser install is not supported on ${probe.platform}/${probe.arch}`,
        ...probe,
      });
      return;
    }
    installPromise = (async () => {
      const marker = await installManagedBrowser({ dataDir });
      const noSandbox = shouldDefaultNoSandbox();
      if (typeof persistSettings === 'function') {
        await persistSettings({
          browserExecutablePath: marker.executable,
          ...(noSandbox ? { browserNoSandbox: true } : {}),
        });
      }
      if (typeof browserRuntime.reloadConfiguration === 'function') {
        await browserRuntime.reloadConfiguration();
      }
      return {
        ok: true,
        ...marker,
        noSandbox,
        status: typeof browserRuntime.status === 'function' ? browserRuntime.status() : browserRuntime.state(),
      };
    })();
    try {
      const result = await installPromise;
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Browser install failed', ...probe });
    } finally {
      installPromise = null;
    }
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

  app.post('/api/browser/takeover', jsonParser, async (_req, res) => {
    try {
      if (typeof browserRuntime.takeover !== 'function') {
        res.status(500).json({ error: 'Browser takeover is unavailable' });
        return;
      }
      res.json(browserRuntime.takeover());
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to take over the browser' });
    }
  });

  for (const [routePath, action] of Object.entries(BROWSER_ACTION_PATHS)) {
    app.post(routePath, jsonParser, async (req, res) => {
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const { takeover, ...params } = body;
        const result = await browserRuntime.executeAction(action, params, {
          actor: 'user',
          takeover: takeover === true,
        });
        res.json(result);
      } catch (error) {
        if (isAgentControllingError(error)) {
          res.status(409).json({
            error: error.message || 'An agent is controlling the browser',
            code: BROWSER_AGENT_CONTROLLING_CODE,
            sessionId: error.sessionId ?? null,
          });
          return;
        }
        res.status(400).json({ error: error?.message || `Failed to execute ${action}` });
      }
    });
  }
};
