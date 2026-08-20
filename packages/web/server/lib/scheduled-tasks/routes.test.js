import { describe, expect, it, vi } from 'bun:test';

import { registerScheduledTaskRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(path, handler) {
        routes.set(`GET ${path}`, handler);
      },
      post(path, handler) {
        routes.set(`POST ${path}`, handler);
      },
      put(path, handler) {
        routes.set(`PUT ${path}`, handler);
      },
      patch(path, handler) {
        routes.set(`PATCH ${path}`, handler);
      },
      delete(path, handler) {
        routes.set(`DELETE ${path}`, handler);
      },
    },
    getRoute(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let payload;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get payload() {
      return payload;
    },
  };
};

describe('scheduled task run route', () => {
  it('carries the denied flag through to the HTTP error response', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deniedTask = { id: 'task-1', state: { lastStatus: 'denied', lastError: 'blocked by policy' } };
    const deniedError = Object.assign(new Error('blocked by policy'), {
      statusCode: 403,
      task: deniedTask,
      denied: true,
    });

    registerScheduledTaskRoutes(app, {
      scheduledTaskService: {
        run: vi.fn(async () => {
          throw deniedError;
        }),
      },
    });

    const handler = getRoute('POST', '/api/projects/:projectId/scheduled-tasks/:taskId/run');
    const res = createMockResponse();

    await handler({ params: { projectId: 'project-test', taskId: 'task-1' } }, res);

    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({
      error: 'blocked by policy',
      task: deniedTask,
      denied: true,
    });
  });

  it('omits the denied flag for a non-denial error', async () => {
    const { app, getRoute } = createRouteRegistry();
    const notFoundError = Object.assign(new Error('Task not found or disabled'), { statusCode: 404 });

    registerScheduledTaskRoutes(app, {
      scheduledTaskService: {
        run: vi.fn(async () => {
          throw notFoundError;
        }),
      },
    });

    const handler = getRoute('POST', '/api/projects/:projectId/scheduled-tasks/:taskId/run');
    const res = createMockResponse();

    await handler({ params: { projectId: 'project-test', taskId: 'task-1' } }, res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({ error: 'Task not found or disabled' });
  });
});
