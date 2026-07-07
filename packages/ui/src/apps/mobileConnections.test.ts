import { describe, expect, mock, test } from 'bun:test';

import { validateMobileConnectionSession } from './mobileConnections';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

const installTestWindow = () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      location: { protocol: 'https:' },
    },
  });
};

const restoreGlobals = () => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
};

describe('validateMobileConnectionSession', () => {
  test('accepts a reachable authenticated runtime', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) return Response.json({ ok: true });
      if (url.endsWith('/auth/session')) return Response.json({ authenticated: true, scope: 'client' });
      return new Response(null, { status: 404 });
    });
    try {
      installTestWindow();
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await validateMobileConnectionSession({ url: 'https://runtime.example', clientToken: 'token' });
      expect(result).toBe(true);
    } finally {
      restoreGlobals();
    }
  });

  test('rejects unreachable runtimes', async () => {
    try {
      installTestWindow();
      globalThis.fetch = mock(async () => new Response(null, { status: 503 })) as typeof fetch;

      const result = await validateMobileConnectionSession({ url: 'https://runtime.example', clientToken: 'token' });
      expect(result).toBe(false);
    } finally {
      restoreGlobals();
    }
  });

  test('rejects invalid or unauthenticated sessions', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) return Response.json({ ok: true });
      return Response.json({ authenticated: false }, { status: 401 });
    });
    try {
      installTestWindow();
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await validateMobileConnectionSession({ url: 'https://runtime.example', clientToken: 'expired' });
      expect(result).toBe(false);
    } finally {
      restoreGlobals();
    }
  });
});
