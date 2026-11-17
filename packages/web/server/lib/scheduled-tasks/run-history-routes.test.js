import { describe, expect, it, vi } from 'vitest';
import { registerScheduledTaskRoutes } from './routes.js';

// Route-level tests for the run-history time filters (#2155): a supplied
// malformed since/until used to reach listRuns as undefined, silently
// widening a filtered history request into an unfiltered one. The reader
// must not be called for an invalid request; valid epoch-millisecond and
// date-string filters must keep working.
const createResponse = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const captureRunHistoryHandler = (listRuns) => {
  const handlers = new Map();
  const app = {
    get: vi.fn((route, handler) => handlers.set(`GET ${route}`, handler)),
    put: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  registerScheduledTaskRoutes(app, {
    scheduledTaskService: {},
    scheduledTaskRunHistory: { listRuns },
    readSettingsFromDiskMigrated: vi.fn(),
    sanitizeProjects: vi.fn(),
    projectConfigRuntime: {},
    scheduledTasksRuntime: {},
    getOpenChamberEventClients: () => new Set(),
    writeSseEvent: vi.fn(),
  });
  return handlers.get('GET /api/projects/:projectId/scheduled-tasks/run-history');
};

const request = (query) => ({ params: { projectId: 'code' }, query });

describe('scheduled-task run-history route time filters', () => {
  it('rejects a malformed since with 400 and never calls the reader', async () => {
    const listRuns = vi.fn(() => []);
    const handler = captureRunHistoryHandler(listRuns);
    const res = createResponse();

    await handler(request({ since: 'not-a-date' }), res);

    expect(res.statusCode).toBe(400);
    expect(res.payload.error).toContain('since');
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('rejects a malformed until with 400 and never calls the reader', async () => {
    const listRuns = vi.fn(() => []);
    const handler = captureRunHistoryHandler(listRuns);
    const res = createResponse();

    await handler(request({ until: 'not-a-date' }), res);

    expect(res.statusCode).toBe(400);
    expect(res.payload.error).toContain('until');
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('passes valid epoch-millisecond and date-string filters through', async () => {
    const runs = [{ id: 'run-1' }];
    const listRuns = vi.fn(() => runs);
    const handler = captureRunHistoryHandler(listRuns);
    const res = createResponse();

    await handler(request({ since: '100', until: '1970-01-01T00:00:00.300Z' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ runs });
    expect(listRuns).toHaveBeenCalledWith(
      expect.objectContaining({ projectID: 'code', since: 100, until: 300 }),
    );
  });

  it('treats absent bounds as no filter', async () => {
    const listRuns = vi.fn(() => []);
    const handler = captureRunHistoryHandler(listRuns);
    const res = createResponse();

    await handler(request({}), res);

    expect(res.statusCode).toBe(200);
    expect(listRuns).toHaveBeenCalledWith(
      expect.objectContaining({ projectID: 'code', since: undefined, until: undefined }),
    );
  });
});
