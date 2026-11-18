import { describe, expect, it, vi } from 'vitest';

import { registerNotificationChannelRoutes } from './channel-routes.js';

const setup = () => {
  const handlers = new Map();
  const app = {
    get: (route, ...chain) => handlers.set(`GET ${route}`, chain.at(-1)),
    put: (route, ...chain) => handlers.set(`PUT ${route}`, chain.at(-1)),
    delete: (route, ...chain) => handlers.set(`DELETE ${route}`, chain.at(-1)),
  };
  const channels = {
    list: vi.fn(async () => []),
    connect: vi.fn(async () => ({ instance: 'https://example.org' })),
    disconnect: vi.fn(async () => ({ removed: false })),
  };
  const response = {
    status: vi.fn(function () { return this; }),
    json: vi.fn(),
  };
  registerNotificationChannelRoutes(app, { channels });
  return { handlers, channels, response };
};

describe('notification channel routes', () => {
  it.each([undefined, null, false, 42, 'token'])('passes missing fields for a non-object body %s', async (body) => {
    const { handlers, channels, response } = setup();
    await handlers.get('PUT /api/notifications/channels/:providerId/account')({
      params: { providerId: 'ext-test' }, body,
    }, response);
    expect(channels.connect).toHaveBeenCalledWith({
      providerId: 'ext-test', instance: undefined, token: undefined, username: undefined,
    });
    expect(response.json).toHaveBeenCalledWith({ channel: { instance: 'https://example.org' } });
  });

  it('passes unchecked object fields to the channel owner, including inherited fields', async () => {
    const { handlers, channels, response } = setup();
    const body = Object.assign(Object.create({ token: 'inherited' }), {
      instance: ['unchecked'], username: 7,
    });
    await handlers.get('PUT /api/notifications/channels/:providerId/account')({
      params: { providerId: 'ext-test' }, body,
    }, response);
    expect(channels.connect).toHaveBeenCalledWith({
      providerId: 'ext-test', instance: ['unchecked'], token: 'inherited', username: 7,
    });
  });

  it.each([
    [{ status: 401, message: 'Refused', code: 'TOKEN_REFUSED' }, 401, 'Refused', 'TOKEN_REFUSED'],
    [{ status: '401', message: '', code: false }, 500, '', false],
    [{ status: 400.5 }, 500, 'Request failed', 'INTERNAL_ERROR'],
    [{ status: 600 }, 500, 'Request failed', 'INTERNAL_ERROR'],
    [null, 500, 'Request failed', 'INTERNAL_ERROR'],
    ['failure', 500, 'Request failed', 'INTERNAL_ERROR'],
  ])('keeps failure status and fallback rules for %s', async (error, status, message, code) => {
    const { handlers, channels, response } = setup();
    channels.list.mockRejectedValue(error);
    await handlers.get('GET /api/notifications/channels')({}, response);
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith({ error: message, code });
  });
});
