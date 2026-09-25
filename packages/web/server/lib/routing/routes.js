/**
 * `/api/routing` — configuration and the Jev key. Normal authenticated
 * OpenChamber routes: do not add them to browser URL-token allowlists.
 *
 * The send-path rewrite, registered ahead of the generic OpenCode proxy. In
 * OpenCode 2.x a prompt body carries no model: the client switches the session
 * first (`POST /session/:id/model`) and sends afterwards. So the rewrite is in
 * two halves:
 *
 * - `POST /session/:id/model` with `openchamber/auto` never reaches OpenCode,
 *   which has no such provider. It marks the session as routed and answers as
 *   a switch would.
 * - `POST /session/:id/{prompt,command}` in a routed session asks Jev on the
 *   request text and switches the session onto the chosen model and agent
 *   before the prompt is forwarded.
 *
 * Both parse the JSON body only for JSON requests, so a streamed or non-JSON
 * upload reaches the proxy untouched.
 */
import express from 'express';
import { isAutoModel } from './defaults.js';

const CREATE_PATH = '/api/session';
const MODEL_PATH = '/api/session/:sessionId/model';
const SEND_PATHS = [
  '/api/session/:sessionId/prompt',
  '/api/session/:sessionId/command',
];

const sendError = (res, error) => {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  res.status(status).json({ error: error?.message ?? 'Routing request failed' });
};

export function registerRoutingRoutes(app, runtime) {
  app.get('/api/routing', async (_req, res) => {
    try {
      const state = await runtime.describe();
      res.json({ ...state, heldPermissions: runtime.heldPermissions() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/routing', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      res.json(await runtime.updateConfig(req.body?.config));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/routing/token', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      res.json(await runtime.setToken(req.body?.token));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/routing/token', async (_req, res) => {
    try {
      res.json(await runtime.clearToken());
    } catch (error) {
      sendError(res, error);
    }
  });
}

export function registerRoutingPromptRewrite(app, runtime) {
  const parseJson = express.json({ limit: '50mb' });

  /** Parses the body only for JSON requests; anything else stays a stream. */
  const withParsedBody = (handler) => (req, res, next) => {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.includes('application/json')) return next();
    parseJson(req, res, (parseError) => {
      if (parseError) return next(parseError);
      handler(req, res, next);
    });
  };

  const directoryOf = (req) => {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('directory') || req.get('x-opencode-directory') || undefined;
  };

  // Session creation is the other v2 request that carries a model: flows that
  // know their first turn's selection create the session on it (btw forks,
  // auto review, fusion, extension starts). OpenCode accepts the sentinel at
  // creation and only fails the first prompt with "provider.no-route", so the
  // model is dropped here and the session starts on OpenCode's default. No
  // session id exists yet to mark; the first send resends the sentinel through
  // the model switch below because the session's record never matches Auto.
  app.post(CREATE_PATH, withParsedBody((req, _res, next) => {
    if (!isAutoModel(req.body?.model)) return next();
    delete req.body.model;
    next();
  }));

  app.post(MODEL_PATH, withParsedBody((req, res, next) => {
    const directory = directoryOf(req);
    // Swallowed, not forwarded: OpenCode has no `openchamber` provider, and the
    // real model is only known once the request text arrives.
    if (runtime.noteModelSelection(req.params.sessionId, req.body?.model, directory)) return res.status(204).end();
    next();
  }));

  // Whether the session is routed is known from the URL alone, so an ordinary
  // send is never read: it reaches the proxy as the stream it arrived as, the
  // way it did before routing existed.
  const routedSendsOnly = (handler) => {
    const parsed = withParsedBody(handler);
    return (req, res, next) => (runtime.isAutoSession(req.params.sessionId) ? parsed(req, res, next) : next());
  };

  app.post(SEND_PATHS, routedSendsOnly((req, res, next) => {
    const sessionId = req.params.sessionId;
    const directory = directoryOf(req);
    runtime.routeSend({ sessionId, directory, body: req.body })
      .then(() => next())
      .catch((error) => sendError(res, error));
  }));
}
