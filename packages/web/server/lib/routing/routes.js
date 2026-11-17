import express from 'express';
import { isAutoModel } from './defaults.js';

const CREATE_PATH = '/api/session';
const MODEL_PATH = '/api/session/:sessionId/model';
const SEND_PATHS = [
  '/api/session/:sessionId/prompt',
  '/api/session/:sessionId/command',
  '/api/session/:sessionId/form/:formId/reply',
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

  app.put('/api/routing/classifier', express.json({ limit: '4kb' }), async (req, res) => {
    try {
      res.json(await runtime.setClassifierSource(req.body?.source));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/routing/classifier/gemini', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      res.json(await runtime.setGeminiKey(req.body?.key));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/routing/classifier/gemini', async (_req, res) => {
    try {
      res.json(await runtime.clearGeminiKey());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/routing/classifier/custom', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      res.json(await runtime.setCustomEndpoint({ url: req.body?.url, model: req.body?.model, key: req.body?.key }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/routing/classifier/test', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const custom = req.body?.custom;
      res.json(await runtime.testClassifier(custom === undefined || custom === null
        ? undefined
        : { url: custom.url, model: custom.model, key: custom.key }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/routing/classifier/custom', async (_req, res) => {
    try {
      res.json(await runtime.clearCustomEndpoint());
    } catch (error) {
      sendError(res, error);
    }
  });
}

export function registerRoutingPromptRewrite(app, runtime) {
  const parseJson = express.json({ limit: '50mb' });

  const withParsedBody = (handler) => (req, res, next) => {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.includes('application/json')) return next();
    parseJson(req, res, (parseError) => {
      if (parseError) return next(parseError);
      handler(req, res, next);
    });
  };

  const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;
  const safeDecode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const directoryOf = (req) => {
    const url = new URL(req.url, 'http://localhost');
    const query = url.searchParams.get('directory');
    if (query) return query;
    const header = req.get('x-opencode-directory');
    if (!header) return undefined;
    const encoded = req.get('x-opencode-directory-encoding') === 'uri' || PERCENT_ESCAPE.test(header);
    return encoded ? safeDecode(header) : header;
  };

  app.post(CREATE_PATH, withParsedBody((req, _res, next) => {
    if (!isAutoModel(req.body?.model)) return next();
    delete req.body.model;
    next();
  }));

  app.post(MODEL_PATH, withParsedBody((req, res, next) => {
    const directory = directoryOf(req);
    if (runtime.noteModelSelection(req.params.sessionId, req.body?.model, directory)) return res.status(204).end();
    next();
  }));

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
