import { afterEach, describe, expect, test } from 'bun:test';
import { browserDebugPortSchema, parseBrowserDebugPortInput, readBrowserRuntimeStatus } from './browserRuntimeStatus';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';
import { setRuntimeBearerToken } from './runtime-auth';

const originalFetch = globalThis.fetch;
const originalResolver = getRuntimeUrlResolver();
afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeUrlResolver(originalResolver);
  setRuntimeBearerToken(null);
});

describe('browser debug ports', () => {
  test('accepts automatic or fixed persisted ports without coercion', () => {
    for (const value of [0, 1, 9222, 65535]) expect(browserDebugPortSchema.parse(value)).toBe(value);
    for (const value of [-1, 65536, 1.5, '9222', null, undefined]) {
      expect(browserDebugPortSchema.safeParse(value).success).toBe(false);
    }
  });

  test('accepts whole fixed ports and rejects empty, fractional and scientific input', () => {
    for (const value of ['1', '9222', ' 65535 ']) expect(parseBrowserDebugPortInput(value)).toBe(Number(value));
    for (const value of ['', ' ', '0', '-1', '65536', '1.5', '9e3', 'abc']) {
      expect(parseBrowserDebugPortInput(value)).toBeNull();
    }
  });

  test('queries the active authenticated runtime without starting Chrome', async () => {
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://cdp-runtime.example' });
    setRuntimeBearerToken('fixture-client-token');
    const urls: string[] = [];
    const controller = new AbortController();
    globalThis.fetch = async (input, init) => {
      urls.push(String(input));
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-client-token');
      expect(init?.signal).toBe(controller.signal);
      expect(init?.cache).toBe('no-store');
      return Response.json({ configuredPort: 9222, running: false, activePort: null, restartRequired: false });
    };
    expect(await readBrowserRuntimeStatus(controller.signal)).toEqual({ configuredPort: 9222, running: false, activePort: null, restartRequired: false });
    expect(urls).toEqual(['https://cdp-runtime.example/api/browser/runtime-status']);
  });

  test('keeps status failure distinct from a stopped browser', async () => {
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await expect(readBrowserRuntimeStatus(new AbortController().signal)).rejects.toThrow();
  });

  test('rejects malformed active ports and inconsistent running state', async () => {
    for (const payload of [
      { configuredPort: 0, running: true, activePort: null, restartRequired: false },
      { configuredPort: 0, running: true, activePort: 65536, restartRequired: false },
      { configuredPort: 0, running: false, activePort: 9222, restartRequired: false },
    ]) {
      globalThis.fetch = async () => Response.json(payload);
      await expect(readBrowserRuntimeStatus(new AbortController().signal)).rejects.toThrow();
    }
  });

  test('retains a pending change made while Chrome is starting', async () => {
    globalThis.fetch = async () => Response.json({ configuredPort: 9223, running: false, activePort: null, restartRequired: true });
    const status = await readBrowserRuntimeStatus(new AbortController().signal);
    expect(status.restartRequired).toBe(true);
    expect(status.activePort).toBeNull();
  });
});
