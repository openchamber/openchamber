import { describe, expect, it, vi } from 'vitest';

import { registerCodexImportRoutes } from './routes.js';

const createHarness = (runtime) => {
  const routes = new Map();
  const app = {
    post(path, handler) {
      routes.set(path, handler);
    },
  };
  registerCodexImportRoutes(app, { codexImportRuntime: runtime });
  return routes;
};

const createResponse = () => {
  let statusCode = 200;
  let body;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('Codex import routes', () => {
  it('forwards an explicit import selection', async () => {
    const runtime = {
      inspect: vi.fn(),
      apply: vi.fn(async (selection) => ({ selection })),
    };
    const routes = createHarness(runtime);
    const response = createResponse();

    await routes.get('/api/import/codex/apply')({
      body: { threadIds: ['thread-1'], projectPaths: ['C:\\repo'] },
    }, response);

    expect(response.body).toEqual({
      selection: { threadIds: ['thread-1'], projectPaths: ['C:\\repo'] },
    });
  });

  it('reports a missing Codex executable as unavailable', async () => {
    const error = Object.assign(new Error('Unable to start Codex app-server'), { code: 'ENOENT' });
    const routes = createHarness({
      inspect: vi.fn(async () => { throw error; }),
      apply: vi.fn(),
    });
    const response = createResponse();

    await routes.get('/api/import/codex/inspect')({}, response);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Unable to start Codex app-server' });
  });
});
