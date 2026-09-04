import { describe, expect, it, vi } from 'vitest';
import { registerPwaManifestRoute } from './pwa-manifest-routes.js';

const createResponse = () => ({
  headers: new Map(),
  contentType: '',
  body: '',
  setHeader(name, value) {
    this.headers.set(name, value);
    return this;
  },
  type(value) {
    this.contentType = value;
    return this;
  },
  send(value) {
    this.body = value;
    return this;
  },
});

describe('PWA manifest route', () => {
  it('does not fall back to unrelated global session shortcuts for scoped manifests', async () => {
    const routes = new Map();
    const app = {
      get(route, handler) {
        routes.set(route, handler);
      },
    };
    const listSessions = vi.fn(async (input) => ({
      sessions: input.directory
        ? []
        : [
            {
              id: 'other-session',
              title: 'Other project',
              directory: '/workspace/other',
              time: { updated: 2 },
            },
          ],
    }));

    registerPwaManifestRoute(app, {
      resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
      openCodeApi: { listSessions },
      readSettingsFromDiskMigrated: async () => ({}),
      normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    });

    const handler = routes.get('/manifest.webmanifest');
    const res = createResponse();
    await handler({ query: {} }, res);

    const manifest = JSON.parse(res.body);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenNthCalledWith(1, expect.objectContaining({
      directory: '/workspace/app',
      roots: false,
    }), { timeoutMs: 2500 });
    expect(listSessions).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ directory: expect.anything() }), { timeoutMs: 2500 });
    expect(manifest.shortcuts).toEqual([
      {
        name: 'Appearance Settings',
        short_name: 'Settings',
        description: 'Open appearance settings',
        url: '/?settings=appearance',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      },
    ]);
  });

  it('includes child session shortcuts for root-scoped manifests', async () => {
    const routes = new Map();
    const app = {
      get(route, handler) {
        routes.set(route, handler);
      },
    };
    const listSessions = vi.fn(async () => ({
      sessions: [
          {
            id: 'root-child',
            title: 'Root child',
            directory: '/workspace/app',
            time: { updated: 2 },
          },
        ],
    }));

    registerPwaManifestRoute(app, {
      resolveProjectDirectory: async () => ({ directory: '/' }),
      openCodeApi: { listSessions },
      readSettingsFromDiskMigrated: async () => ({}),
      normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    });

    const handler = routes.get('/manifest.webmanifest');
    const res = createResponse();
    await handler({ query: {} }, res);

    const manifest = JSON.parse(res.body);
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/',
      roots: false,
    }), { timeoutMs: 2500 });
    expect(manifest.shortcuts).toContainEqual({
      name: 'Root child',
      short_name: 'Root child',
      description: 'Open recent session',
      url: '/?session=root-child',
      icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
    });
  });

  it('keeps cached shortcuts when a refresh fails', async () => {
    const routes = new Map();
    const app = {
      get(route, handler) {
        routes.set(route, handler);
      },
    };
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const listSessions = vi.fn()
      .mockResolvedValueOnce({
        sessions: [{
          id: 'cached-session',
          title: 'Cached session',
          directory: '/workspace/app',
          time: { updated: 2 },
        }],
      })
      .mockRejectedValueOnce(new Error('OpenCode unavailable'));

    registerPwaManifestRoute(app, {
      resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
      openCodeApi: { listSessions },
      readSettingsFromDiskMigrated: async () => ({}),
      normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    });

    try {
      const handler = routes.get('/manifest.webmanifest');
      const first = createResponse();
      await handler({ query: {} }, first);
      now += 6_000;
      const second = createResponse();
      await handler({ query: {} }, second);

      expect(JSON.parse(second.body).shortcuts).toEqual(JSON.parse(first.body).shortcuts);
      expect(listSessions).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
