import express from 'express';
import { isAutoModel } from './defaults.js';
import type { Application, Request, RequestHandler, Response } from '../shared/http-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createRoutingRuntime } from './runtime.js';

type RoutingRuntime = ReturnType<typeof createRoutingRuntime>;
type JsonHandler = RequestHandler<JsonValue | undefined, { sessionId: string }>;

const hasJsonFields = (value: JsonValue | undefined): value is JsonObject => value !== null
  && typeof value === 'object' && !Array.isArray(value);

const hasErrorFields = (cause: unknown): cause is { status?: unknown; message?: unknown } => cause !== null
  && (typeof cause === 'object' || typeof cause === 'function');

const hasIntegerStatus = (cause: unknown): cause is { status: number } => hasErrorFields(cause)
  && typeof cause.status === 'number' && Number.isInteger(cause.status);

const CREATE_PATH = '/api/session';
const MODEL_PATH = '/api/session/:sessionId/model';
const SEND_PATHS = [
  '/api/session/:sessionId/prompt',
  '/api/session/:sessionId/command',
  '/api/session/:sessionId/form/:formId/reply',
];

const sendError = (res: Response, cause: unknown) => {
  const error = hasErrorFields(cause) ? cause : undefined;
  const status = hasIntegerStatus(cause) ? cause.status : 500;
  res.status(status).json({ error: error?.message ?? 'Routing request failed' });
};

export function registerRoutingRoutes(app: Application, runtime: RoutingRuntime) {
  app.get('/api/routing', async (_req, res) => {
    try {
      const state = await runtime.describe();
      res.json({ ...state, heldPermissions: runtime.heldPermissions() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put<JsonValue | undefined>('/api/routing', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      res.json(await runtime.updateConfig(hasJsonFields(req.body) ? req.body.config : undefined));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put<JsonValue | undefined>('/api/routing/token', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      res.json(await runtime.setToken(hasJsonFields(req.body) ? req.body.token : undefined));
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

  app.put<JsonValue | undefined>('/api/routing/classifier', express.json({ limit: '4kb' }), async (req, res) => {
    try {
      res.json(await runtime.setClassifierSource(hasJsonFields(req.body) ? req.body.source : undefined));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put<JsonValue | undefined>('/api/routing/classifier/gemini', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      res.json(await runtime.setGeminiKey(hasJsonFields(req.body) ? req.body.key : undefined));
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

  app.put<JsonValue | undefined>('/api/routing/classifier/custom', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const body = hasJsonFields(req.body) ? req.body : undefined;
      res.json(await runtime.setCustomEndpoint({ url: body?.url, model: body?.model, key: body?.key }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post<JsonValue | undefined>('/api/routing/classifier/test', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const custom = hasJsonFields(req.body) ? req.body.custom : undefined;
      const fields = hasJsonFields(custom) ? custom : undefined;
      res.json(await runtime.testClassifier(custom === undefined || custom === null
        ? undefined
        : { url: fields?.url, model: fields?.model, key: fields?.key }));
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

export function registerRoutingPromptRewrite(app: Application, runtime: RoutingRuntime) {
  const parseJson = express.json({ limit: '50mb' });

  const withParsedBody = (handler: JsonHandler): JsonHandler => (req, res, next) => {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.includes('application/json')) return next();
    parseJson(req, res, (parseError) => {
      if (parseError) return next(parseError);
      handler(req, res, next);
    });
  };

  const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;
  const safeDecode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const directoryOf = (req: Request<JsonValue | undefined>) => {
    const url = new URL(req.url, 'http://localhost');
    const query = url.searchParams.get('directory');
    if (query) return query;
    const header = req.get('x-opencode-directory');
    if (!header) return undefined;
    const encoded = req.get('x-opencode-directory-encoding') === 'uri' || PERCENT_ESCAPE.test(header);
    return encoded ? safeDecode(header) : header;
  };

  app.post(CREATE_PATH, withParsedBody((req, _res, next) => {
    if (!hasJsonFields(req.body) || !isAutoModel(req.body.model)) return next();
    delete req.body.model;
    next();
  }));

  app.post(MODEL_PATH, withParsedBody((req, res, next) => {
    const directory = directoryOf(req);
    if (runtime.noteModelSelection(req.params.sessionId, hasJsonFields(req.body) ? req.body.model : undefined, directory)) return res.status(204).end();
    next();
  }));

  const routedSendsOnly = (handler: JsonHandler): JsonHandler => {
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
