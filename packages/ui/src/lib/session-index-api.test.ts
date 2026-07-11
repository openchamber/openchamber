import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  pollSessionIndexChanges,
  startSessionIndexBackgroundSync,
} from './session-index-api';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

const payload = {
  revision: 1,
  sync: {
    active: true,
    completed: 0,
    total: 2,
    pendingDirectories: ['/repo/a', '/repo/b'],
    completedDirectories: [],
    failedDirectories: [],
  },
  directories: [],
};

describe('session index background transport', () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let previousResolver: ReturnType<typeof getRuntimeUrlResolver>;
  let requests: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    previousResolver = getRuntimeUrlResolver();
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:57123' });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'openchamber-ui://app', href: 'openchamber-ui://app/' } },
    });
    requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), init });
      return new Response(JSON.stringify(payload), {
        status: input.toString().includes('/sync') ? 202 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });

  afterEach(() => {
    setRuntimeUrlResolver(previousResolver);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    globalThis.fetch = originalFetch;
  });

  test('starts one server job and observes it with one low-frequency long poll', async () => {
    await startSessionIndexBackgroundSync(['/repo/a', '/repo/b']);
    const controller = new AbortController();
    await pollSessionIndexChanges(1, controller.signal);

    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]?.url ?? '').pathname).toBe('/api/openchamber/session-index/sync');
    expect(requests[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ directories: ['/repo/a', '/repo/b'] });
    const pollUrl = new URL(requests[1]?.url ?? '');
    expect(pollUrl.pathname).toBe('/api/openchamber/session-index/changes');
    expect(pollUrl.searchParams.get('since')).toBe('1');
    expect(pollUrl.searchParams.get('timeout')).toBe('25000');
  });
});
