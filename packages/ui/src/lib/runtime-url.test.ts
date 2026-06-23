import { describe, expect, test } from 'bun:test';
import {
  configureRuntimeUrlResolver,
  createRuntimeUrlResolver,
  getRuntimeUrlResolver,
  setRuntimeUrlResolver,
} from './runtime-url';
import { setRuntimeBearerToken, setRuntimeUrlAuthToken } from './runtime-auth';

describe('createRuntimeUrlResolver', () => {
  const withWindow = <T>(value: unknown, callback: () => T): T => {
    const originalWindow = globalThis.window;
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value,
      });
      return callback();
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  };

  test('preserves relative same-origin URLs by default', () => {
    const urls = createRuntimeUrlResolver({ currentHref: () => 'http://127.0.0.1:3000/app' });

    expect(urls.api('/api/config/settings')).toBe('/api/config/settings');
    expect(urls.health()).toBe('/health');
    expect(urls.rawFile('/tmp/a b.txt')).toBe('/api/fs/raw?path=%2Ftmp%2Fa+b.txt');
  });

  test('builds absolute API URLs when an API base URL is configured', () => {
    const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://server.example/base/' });

expect(urls.api('/api/config/settings')).toBe('https://server.example/api/config/settings');
    // /auth/* stays on page origin (OpenChamber-internal), not apiBase
    expect(urls.auth('/auth/device', { next: '/app' })).toBe('/auth/device?next=%2Fapp');
    expect(urls.health({ probe: true })).toBe('/health?probe=true');
  });

  test('uses realtime base URL for SSE and WebSocket URLs', () => {
    const urls = createRuntimeUrlResolver({
      apiBaseUrl: 'https://api.example',
      realtimeBaseUrl: 'https://realtime.example/root',
    });
    // OpenChamber-internal paths use page origin even if realtimeBaseUrl is set
    expect(urls.sse('/api/openchamber/events')).toBe('/api/openchamber/events');
    expect(urls.websocket('/api/global/event/ws', { lastEventId: 'evt-1' })).toBe(
      'wss://realtime.example/api/global/event/ws?lastEventId=evt-1',
    );
  });
  test('converts absolute HTTP URLs to WebSocket URLs', () => {
    const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });

    expect(urls.websocket('http://remote.example/api/terminal/ws')).toBe('ws://remote.example/api/terminal/ws');
    expect(urls.websocket('https://remote.example/api/global/event/ws', { lastEventId: '2' })).toBe(
      'wss://remote.example/api/global/event/ws?lastEventId=2',
    );
    expect(urls.websocket('wss://remote.example/api/terminal/ws')).toBe('wss://remote.example/api/terminal/ws');
  });

  test('derives WebSocket origin from the current page for default relative URLs', () => {
    const urls = createRuntimeUrlResolver({ currentHref: () => 'http://localhost:5173/mobile.html' });

    expect(urls.websocket('/api/terminal/ws')).toBe('ws://localhost:5173/api/terminal/ws');
  });

  test('uses injected desktop API base URL for packaged WebSocket URLs', () => {
    withWindow({
      location: { origin: 'openchamber-ui://app', href: 'openchamber-ui://app/index.html' },
      __OPENCHAMBER_API_BASE_URL__: 'http://127.0.0.1:57123',
    }, () => {
      const urls = createRuntimeUrlResolver({});

      expect(urls.websocket('/api/global/event/ws')).toBe('ws://127.0.0.1:57123/api/global/event/ws');
    });
  });

  test('reads injected desktop API base URL at call time', () => {
    withWindow({
      location: { origin: 'openchamber-ui://app', href: 'openchamber-ui://app/index.html' },
    }, () => {
      const urls = createRuntimeUrlResolver({});
      (window as typeof window & { __OPENCHAMBER_API_BASE_URL__?: string }).__OPENCHAMBER_API_BASE_URL__ = 'http://127.0.0.1:57123';

      expect(urls.api('/api/config/settings')).toBe('http://127.0.0.1:57123/api/config/settings');
      expect(urls.websocket('/api/global/event/ws')).toBe('ws://127.0.0.1:57123/api/global/event/ws');
    });
  });

  test('allows runtime-wide resolver configuration', () => {
    const previous = getRuntimeUrlResolver();
    try {
      const configured = configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      expect(getRuntimeUrlResolver()).toBe(configured);
      expect(getRuntimeUrlResolver().api('/api/version')).toBe('https://api.example/api/version');
    } finally {
      setRuntimeUrlResolver(previous);
    }
  });

  test('adds short-lived URL auth query to realtime and authenticated asset URLs only', () => {
    setRuntimeBearerToken('oc_client_secret');
    setRuntimeUrlAuthToken('oc_url_secret', Date.now() + 60_000);
    try {
      const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });

      // OpenCode upstream paths use the apiBase
      expect(urls.api('/api/config/settings')).toBe('https://api.example/api/config/settings');
      // OpenChamber-internal paths stay on the page origin (NOT apiBase)
      expect(urls.authenticatedAsset('/api/projects/p1/icon', { v: 123 })).toBe(
        '/api/projects/p1/icon?v=123&oc_url_token=oc_url_secret',
      );
      expect(urls.sse('/api/openchamber/events')).toBe(
        '/api/openchamber/events?oc_url_token=oc_url_secret',
      );
      expect(urls.websocket('/api/global/event/ws', { lastEventId: 'evt-1' })).toBe(
        'wss://api.example/api/global/event/ws?lastEventId=evt-1&oc_url_token=oc_url_secret',
      );
    } finally {
      setRuntimeBearerToken(null);
    }
  });

  test('replaces existing short-lived URL auth query on relative authenticated URLs', () => {
    setRuntimeUrlAuthToken('oc_url_secret', Date.now() + 60_000);
    try {
      const urls = createRuntimeUrlResolver();

      expect(urls.authenticatedAsset('/api/preview/proxy/abc/?oc_url_token=stale&x=1#top')).toBe(
        '/api/preview/proxy/abc/?oc_url_token=oc_url_secret&x=1#top',
      );
    } finally {
      setRuntimeUrlAuthToken(null, null);
    }
  });

  test('does not put the long-lived client token in URLs', () => {
    setRuntimeBearerToken('oc_client_secret');
    try {
      const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      // OpenChamber-internal paths stay on page origin
      expect(urls.sse('/api/openchamber/events')).toBe('/api/openchamber/events');
      // OpenCode upstream paths use apiBase
      expect(urls.websocket('/api/global/event/ws')).toBe('wss://api.example/api/global/event/ws');
      expect(urls.authenticatedAsset('/api/projects/p1/icon')).toBe('/api/projects/p1/icon');
    } finally {
      setRuntimeBearerToken(null);
    }
  });

  test('falls back to VITE_OPENCODE_URL build-time env when no runtime injection', () => {
    const previous = process.env.VITE_OPENCODE_URL;
    try {
      process.env.VITE_OPENCODE_URL = 'http://127.0.0.1:4096';
      const urls = createRuntimeUrlResolver({});
expect(urls.api('/api/config/settings')).toBe('http://127.0.0.1:4096/api/config/settings');
      // /health is OpenChamber's own health endpoint, stays on page origin
      expect(urls.health()).toBe('/health');
    } finally {
      if (previous === undefined) {
        delete process.env.VITE_OPENCODE_URL;
      } else {
        process.env.VITE_OPENCODE_URL = previous;
      }
    }
  });

  test('runtime injection overrides VITE_OPENCODE_URL build-time env', () => {
    withWindow({
      location: { origin: 'http://localhost:4095', href: 'http://localhost:4095/app' },
      __OPENCHAMBER_API_BASE_URL__: 'http://remote.example:9000',
    }, () => {
      const previous = process.env.VITE_OPENCODE_URL;
      try {
        process.env.VITE_OPENCODE_URL = 'http://127.0.0.1:4096';
        const urls = createRuntimeUrlResolver({});
        expect(urls.api('/api/config/settings')).toBe('http://remote.example:9000/api/config/settings');
      } finally {
        if (previous === undefined) {
          delete process.env.VITE_OPENCODE_URL;
        } else {
          process.env.VITE_OPENCODE_URL = previous;
        }
      }
    });
  });
});
