import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerMessageSearchRoutes } from './routes.js';

describe('message search routes', () => {
  const createApp = (runtime) => {
    const app = express();
    registerMessageSearchRoutes(app, { messageSearchRuntime: runtime });
    return app;
  };

  it('judges the limit strictly, so malformed spellings fall back to the default page size', async () => {
    const runtime = {
      search: vi.fn(() => ({ status: 'ok', hits: [], next: null, index: null })),
      status: vi.fn(async () => ({ state: 'on', sizeBytes: 0, index: null })),
      deleteIndex: vi.fn(async () => {}),
    };
    const app = createApp(runtime);
    // The runtime clamps a plain integer itself (1..200); the route only
    // decides which spellings are integers at all.
    const cases = [['1e3', 20], ['0x10', 20], ['2.0', 20], ['', 20], ['-5', 20], ['0', 0], ['7', 7], ['500', 500]];
    for (const [limit, expected] of cases) {
      runtime.search.mockClear();
      await request(app).get(`/api/openchamber/message-search?limit=${limit}`).expect(200);
      expect(runtime.search).toHaveBeenCalledWith(expect.objectContaining({ limit: expected }));
    }
    runtime.search.mockClear();
    await request(app).get('/api/openchamber/message-search').expect(200);
    expect(runtime.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });
});
