import { EventEmitter } from 'events';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createTerminalRuntime } from './runtime.js';

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

describe('terminal runtime', () => {
  it('rejects regular files as terminal working directories', async () => {
    const postRoutes = new Map();
    const app = {
      post(route, ...handlers) {
        postRoutes.set(route, handlers.at(-1));
      },
      get() {},
      delete() {},
    };
    const server = new EventEmitter();
    const runtime = createTerminalRuntime({
      app,
      server,
      express: { text: () => (_req, _res, next) => next?.() },
      fs: {
        promises: {
          stat: async () => ({ isDirectory: () => false }),
          access: async () => {},
        },
      },
      path,
      uiAuthController: { enabled: false },
      buildAugmentedPath: () => '',
      searchPathFor: () => null,
      isExecutable: () => false,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade: () => {},
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 1000,
      TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1000,
      TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 3,
    });

    try {
      const createRoute = postRoutes.get('/api/terminal/create');
      const res = createResponse();

      await createRoute({ body: { cwd: '/tmp/not-a-directory' } }, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid working directory' });
    } finally {
      await runtime.shutdown();
    }
  });
});
