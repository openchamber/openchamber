import { describe, expect, it, vi } from 'vitest';

import { registerNotificationRoutes } from './routes.js';

// Oracle: the lifecycle's own answer. Clients settle a session from OpenCode's
// running list only when this route says no replaced OpenCode is draining, so
// the flag must be exactly what the lifecycle reports, and false when no
// lifecycle is wired.
describe('GET /api/sessions/status', () => {
  const statusPayload = async (dependencies) => {
    const handlers = new Map();
    const app = {
      get: (routePath, handler) => handlers.set(routePath, handler),
      post: () => {},
      delete: () => {},
    };
    registerNotificationRoutes(app, {
      getSessionStateSnapshot: () => ({ 'session-a': { status: 'busy', lastUpdateAt: 1, metadata: {} } }),
      getPendingBlockingRequestsSnapshot: () => ({}),
      ...dependencies,
    });
    const res = { json: vi.fn() };
    await handlers.get('/api/sessions/status')({}, res);
    return res.json.mock.calls[0][0];
  };

  it('says whether a replaced OpenCode is still draining', async () => {
    expect((await statusPayload({ isOpenCodeDraining: () => true })).openCodeDraining).toBe(true);
    expect((await statusPayload({ isOpenCodeDraining: () => false })).openCodeDraining).toBe(false);
    expect((await statusPayload({})).openCodeDraining).toBe(false);
    expect((await statusPayload({})).sessions).toEqual({ 'session-a': { status: 'busy', lastUpdateAt: 1, metadata: {} } });
  });
});
