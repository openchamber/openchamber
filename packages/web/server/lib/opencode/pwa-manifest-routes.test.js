import { describe, expect, it } from 'vitest';
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
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      const sessions = String(url).includes('?directory=')
        ? []
        : [
            {
              id: 'other-session',
              title: 'Other project',
              directory: '/workspace/other',
              time: { updated: 2 },
            },
          ];
      // v2 pages the session list as `{ data, cursor }`.
      return new Response(JSON.stringify({ data: sessions, cursor: {} }));
    };

    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });

      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: {} }, res);

      const manifest = JSON.parse(res.body);
      expect(fetchCalls).toHaveLength(2);
      expect(manifest.shortcuts).toEqual([
        {
          name: 'Appearance Settings',
          short_name: 'Settings',
          description: 'Open appearance settings',
          url: '/?settings=appearance',
          icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes child session shortcuts for root-scoped manifests', async () => {
    const routes = new Map();
    const app = {
      get(route, handler) {
        routes.set(route, handler);
      },
    };
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify([
        {
          id: 'root-child',
          title: 'Root child',
          directory: '/workspace/app',
          time: { updated: 2 },
        },
      ]));
    };

    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });

      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: {} }, res);

      const manifest = JSON.parse(res.body);
      expect(fetchCalls).toEqual(['/api/session?directory=%2F']);
      expect(manifest.shortcuts).toContainEqual({
        name: 'Root child',
        short_name: 'Root child',
        description: 'Open recent session',
        url: '/?session=root-child',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to no shortcuts for an over-cap session list, cancelling the stream', async () => {
    const routes = new Map();
    const app = { get(route, handler) { routes.set(route, handler); } };
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    const chunk = new TextEncoder().encode('x'.repeat(9 * 1024 * 1024));
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        // Never closed: only the reader cancelling can end this body.
      },
      cancel() { cancelled = true; },
    }));
    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });
      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: {} }, res);
      const manifest = JSON.parse(res.body);
      expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual(['/?settings=appearance']);
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses a session list at the exact 16 MiB cap, envelope included', async () => {
    const routes = new Map();
    const app = { get(route, handler) { routes.set(route, handler); } };
    const originalFetch = globalThis.fetch;
    const cap = 16 * 1024 * 1024;
    const session = { id: 'capped', title: 'Capped session', directory: '/workspace/app', time: { updated: 2 } };
    const build = (pad) => JSON.stringify({ data: [{ ...session, pad: 'x'.repeat(pad) }], cursor: {} });
    const text = build(cap - Buffer.byteLength(build(0)));
    expect(Buffer.byteLength(text)).toBe(cap);
    globalThis.fetch = async () => new Response(text);
    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });
      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: {} }, res);
      const manifest = JSON.parse(res.body);
      expect(manifest.shortcuts).toContainEqual(expect.objectContaining({ url: '/?session=capped' }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('leaves session titles out for a caller without credentials and ignores its directory', async () => {
    const routes = new Map();
    const app = {
      get(route, handler) {
        routes.set(route, handler);
      },
    };
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: true, json: async () => [{ id: 'secret', title: 'Private', directory: '/workspace/app', time: { updated: 1 } }] };
    };
    const resolvedFrom = [];

    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async (req) => {
          resolvedFrom.push(req);
          return { directory: '/workspace/app' };
        },
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => false,
      });

      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: { directory: '/etc' } }, res);

      const manifest = JSON.parse(res.body);
      expect(fetchCalls).toEqual([]);
      expect(resolvedFrom).toEqual([]);
      expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual(['/?settings=appearance']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never splits a surrogate pair at the manifest clamps (oracle: astral char straddling offsets 48, 32 and 30 encodes with no U+FFFD, ASCII controls cut at exactly the limit)', async () => {
    const routes = new Map();
    const app = { get(route, handler) { routes.set(route, handler); } };
    const originalFetch = globalThis.fetch;
    const emoji = '\uD83D\uDE00';
    globalThis.fetch = async () => new Response(JSON.stringify([
      { id: 'straddle-48', title: 'a'.repeat(47) + emoji + 't'.repeat(10), directory: '/workspace/app', time: { updated: 3 } },
      { id: 'straddle-32', title: 'b'.repeat(31) + emoji + 'x'.repeat(20), directory: '/workspace/app', time: { updated: 2 } },
      { id: 'ascii-long', title: 'c'.repeat(60), directory: '/workspace/app', time: { updated: 1 } },
    ]));
    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });
      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: { pwa_name: 'd'.repeat(29) + emoji + 'eeee' } }, res);
      const manifest = JSON.parse(res.body);
      const encoded = new TextDecoder().decode(new TextEncoder().encode(JSON.stringify(manifest)));
      expect(encoded).not.toContain('\uFFFD');
      // 30 cut: pair straddling offset 30 drops back to the pair boundary.
      expect(manifest.short_name).toBe('d'.repeat(29));
      const byUrl = new Map(manifest.shortcuts.map((shortcut) => [shortcut.url, shortcut]));
      // 48 cut: pair straddling offset 48 drops back to the pair boundary.
      expect(byUrl.get('/?session=straddle-48').name).toBe('a'.repeat(47));
      // 32 cut: the 48 name is pair-intact, but short_name straddles 32.
      expect(byUrl.get('/?session=straddle-32').name).toBe('b'.repeat(31) + emoji + 'x'.repeat(15));
      expect(byUrl.get('/?session=straddle-32').short_name).toBe('b'.repeat(31));
      // ASCII controls still cut at exactly the limit.
      expect(byUrl.get('/?session=ascii-long').name).toBe('c'.repeat(48));
      expect(byUrl.get('/?session=ascii-long').short_name).toBe('c'.repeat(32));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cuts an ASCII manifest short_name at exactly 30 (oracle: exact-limit ASCII control)', async () => {
    const routes = new Map();
    const app = { get(route, handler) { routes.set(route, handler); } };
    registerPwaManifestRoute(app, {
      process: { platform: 'darwin' },
      resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
      buildOpenCodeUrl: (route) => route,
      getOpenCodeAuthHeaders: () => ({}),
      readSettingsFromDiskMigrated: async () => ({}),
      normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      isRequestAuthorized: async () => false,
    });
    const handler = routes.get('/manifest.webmanifest');
    const res = createResponse();
    await handler({ query: { pwa_name: 'e'.repeat(35) } }, res);
    const manifest = JSON.parse(res.body);
    expect(manifest.short_name).toBe('e'.repeat(30));
  });
  it('never splits a grapheme cluster at the shortcut clamps (oracle: UAX #29 extended grapheme clusters — a combining cluster is dropped whole or kept on an exact fit at 48/32, never left as a bare base char)', async () => {
    const routes = new Map();
    const app = { get(route, handler) { routes.set(route, handler); } };
    const originalFetch = globalThis.fetch;
    const accented = 'e\u0301';
    globalThis.fetch = async () => new Response(JSON.stringify([
      { id: 'combining-straddle-48', title: 'a'.repeat(47) + accented + 't'.repeat(10), directory: '/workspace/app', time: { updated: 3 } },
      { id: 'combining-exact-32', title: 'b'.repeat(30) + accented + 'x'.repeat(20), directory: '/workspace/app', time: { updated: 2 } },
      { id: 'combining-straddle-32', title: 'c'.repeat(31) + accented + 'y'.repeat(20), directory: '/workspace/app', time: { updated: 1 } },
    ]));
    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });
      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: {} }, res);
      const manifest = JSON.parse(res.body);
      const byUrl = new Map(manifest.shortcuts.map((shortcut) => [shortcut.url, shortcut]));
      // 48 cut: the combining cluster straddles the cap and drops whole.
      expect(byUrl.get('/?session=combining-straddle-48').name).toBe('a'.repeat(47));
      expect(byUrl.get('/?session=combining-straddle-48').short_name).toBe('a'.repeat(32));
      // Exact fit at 32: 30 + 2 keeps the complete accented cluster.
      expect(byUrl.get('/?session=combining-exact-32').short_name).toBe('b'.repeat(30) + accented);
      // Straddle at 32: 31 + 2 drops the cluster whole; the 48 name keeps
      // the same cluster mid-string (31 + 2 + 15 = 48).
      expect(byUrl.get('/?session=combining-straddle-32').short_name).toBe('c'.repeat(31));
      expect(byUrl.get('/?session=combining-straddle-32').name).toBe('c'.repeat(31) + accented + 'y'.repeat(15));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never leaves a dangling ZWJ at the shortcut name clamp (oracle: UAX #29 extended grapheme clusters — a joined emoji sequence that straddles 48 drops whole)', async () => {
    const routes = new Map();
    const app = { get(route, handler) { routes.set(route, handler); } };
    const originalFetch = globalThis.fetch;
    const family = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
    globalThis.fetch = async () => new Response(JSON.stringify([
      { id: 'family-straddle-48', title: 'd'.repeat(45) + family + 'z'.repeat(5), directory: '/workspace/app', time: { updated: 1 } },
    ]));
    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });
      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: {} }, res);
      const manifest = JSON.parse(res.body);
      const byUrl = new Map(manifest.shortcuts.map((shortcut) => [shortcut.url, shortcut]));
      const name = byUrl.get('/?session=family-straddle-48').name;
      expect(name).toBe('d'.repeat(45));
      expect(name.endsWith('\u200D')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

