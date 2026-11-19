import { describe, expect, it, vi } from 'vitest';

import { registerNotificationRoutes } from './routes.js';

const setup = ({ cleared = [] } = {}) => {
  const handlers = new Map();
  const app = {
    get: (route, handler) => handlers.set(`GET ${route}`, handler),
    post: (route, handler) => handlers.set(`POST ${route}`, handler),
    delete: (route, handler) => handlers.set(`DELETE ${route}`, handler),
  };
  const clearSessionPushNotifications = vi.fn(async () => cleared);
  const response = { status: vi.fn(function () { return this; }), json: vi.fn() };
  registerNotificationRoutes(app, { clearSessionPushNotifications });
  return { handlers, clearSessionPushNotifications, response };
};

describe('the session view route', () => {
  it('answers the subagent sessions the view cleared', async () => {
    const { handlers, clearSessionPushNotifications, response } = setup({ cleared: ['ses_child', 'ses_grandchild'] });

    await handlers.get('POST /api/sessions/:id/view')({ params: { id: 'ses_parent' } }, response);

    expect(clearSessionPushNotifications).toHaveBeenCalledWith('ses_parent', { withSubagents: true });
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      sessionId: 'ses_parent',
      viewed: true,
      clearedSessionIds: ['ses_child', 'ses_grandchild'],
    });
  });

  it('answers an empty list when nothing was cleared', async () => {
    const { handlers, response } = setup();

    await handlers.get('POST /api/sessions/:id/view')({ params: { id: 'ses_parent' } }, response);

    expect(response.json).toHaveBeenCalledWith({
      success: true,
      sessionId: 'ses_parent',
      viewed: true,
      clearedSessionIds: [],
    });
  });

  it('still answers the view when the clear fails', async () => {
    const handlers = new Map();
    const app = {
      get: (route, handler) => handlers.set(`GET ${route}`, handler),
      post: (route, handler) => handlers.set(`POST ${route}`, handler),
      delete: (route, handler) => handlers.set(`DELETE ${route}`, handler),
    };
    const response = { status: vi.fn(function () { return this; }), json: vi.fn() };
    registerNotificationRoutes(app, { clearSessionPushNotifications: async () => { throw new Error('offline'); } });

    await handlers.get('POST /api/sessions/:id/view')({ params: { id: 'ses_parent' } }, response);

    expect(response.json).toHaveBeenCalledWith({
      success: true,
      sessionId: 'ses_parent',
      viewed: true,
      clearedSessionIds: [],
    });
  });
});
