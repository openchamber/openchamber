/**
 * `/api/routing` — configuration and the Jev key. Normal authenticated
 * OpenChamber routes: do not add them to browser URL-token allowlists.
 *
 * `/api/session/:id/{prompt_async,prompt,command}` — the rewrite that turns
 * `openchamber/auto` into a real model before the generic OpenCode proxy
 * forwards the request. Registered ahead of the proxy; it parses the JSON body
 * only while Auto can actually be selected, so a build without the flag pays
 * nothing on the send path.
 */
import express from 'express';
import { isRoutingFeatureAvailable } from './feature-flag.js';

const AUTO_SESSION_PATHS = [
  '/api/session/:sessionId/prompt_async',
  '/api/session/:sessionId/prompt',
  '/api/session/:sessionId/command',
];

const sendError = (res, error) => {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  res.status(status).json({ error: error?.message ?? 'Routing request failed' });
};

export function registerRoutingRoutes(app, runtime) {
  const unavailable = (res) => res.status(404).json({ error: 'Routing is not available in this build' });

  app.get('/api/routing', async (_req, res) => {
    try {
      const state = await runtime.describe();
      if (!state.available) return unavailable(res);
      res.json({ ...state, heldPermissions: runtime.heldPermissions() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/routing', express.json({ limit: '256kb' }), async (req, res) => {
    if (!isRoutingFeatureAvailable()) return unavailable(res);
    try {
      res.json(await runtime.updateConfig(req.body?.config));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/routing/token', express.json({ limit: '16kb' }), async (req, res) => {
    if (!isRoutingFeatureAvailable()) return unavailable(res);
    try {
      res.json(await runtime.setToken(req.body?.token));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/routing/token', async (_req, res) => {
    if (!isRoutingFeatureAvailable()) return unavailable(res);
    try {
      res.json(await runtime.clearToken());
    } catch (error) {
      sendError(res, error);
    }
  });
}

export function registerRoutingPromptRewrite(app, runtime) {
  const parseJson = express.json({ limit: '50mb' });
  app.post(AUTO_SESSION_PATHS, (req, res, next) => {
    if (!isRoutingFeatureAvailable()) return next();
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.includes('application/json')) return next();
    parseJson(req, res, (parseError) => {
      if (parseError) return next(parseError);
      const url = new URL(req.url, 'http://localhost');
      const directory = url.searchParams.get('directory') || req.get('x-opencode-directory') || undefined;
      runtime.resolvePromptBody(req.body, { sessionId: req.params.sessionId, directory })
        .then(() => next())
        .catch((error) => sendError(res, error));
    });
  });
}
