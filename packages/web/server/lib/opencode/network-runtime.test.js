import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeNetworkRuntime, detectOpenCodeProtocol } from './network-runtime.js';

const originalFetch = globalThis.fetch;

const createRuntime = (overrides = {}) => {
  const suppliedState = { ...overrides.state };
  const state = Object.assign(overrides.state ?? {}, {
    openCodePort: 4096,
    openCodeBaseUrl: null,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    openCodeProtocol: null,
  }, suppliedState);
  return createOpenCodeNetworkRuntime({
    state,
    getOpenCodeAuthHeaders: () => ({}),
    configuredOpenCodeHostname: overrides.configuredOpenCodeHostname,
  });
};

describe('OpenCode network runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('returns false when readiness fetch rejects', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    });

    const runtime = createRuntime();
    const readyPromise = runtime.waitForReady('http://127.0.0.1:4096', 1);

    await expect(readyPromise).resolves.toBe(false);
  });

  it('detects opencode2 after the legacy health endpoint is unavailable', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/api/health')) {
        return Response.json({ healthy: true, version: '0.0.0-beta-17639', pid: 123 });
      }
      return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
    });

    await expect(detectOpenCodeProtocol('http://127.0.0.1:4096')).resolves.toEqual({
      protocol: 'opencode2',
    });
  });

  it('detects opencode2 after a bounded stalled legacy probe', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((url, init) => {
      if (String(url).endsWith('/api/health')) {
        return Promise.resolve(Response.json({ healthy: true }));
      }
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });

    const detection = detectOpenCodeProtocol('http://127.0.0.1:4096', { attemptTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(detection).resolves.toEqual({ protocol: 'opencode2' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('stops protocol detection when the caller cancels', async () => {
    const caller = new AbortController();
    globalThis.fetch = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));

    const detection = detectOpenCodeProtocol('http://127.0.0.1:4096', {
      attemptTimeoutMs: 1000,
      signal: caller.signal,
    });
    caller.abort();

    await expect(detection).resolves.toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('records the detected protocol during readiness', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ healthy: true, version: '1.18.18' }));
    const state = { openCodeProtocol: null };
    const runtime = createRuntime({ state });

    await expect(runtime.waitForReady('http://127.0.0.1:4096')).resolves.toBe(true);
    expect(state.openCodeProtocol).toBe('legacy');
    expect(runtime.getOpenCodeHealthPath()).toBe('/global/health');
  });

  it('builds managed OpenCode URLs against IPv4 loopback by default', () => {
    const runtime = createRuntime();

    expect(runtime.buildOpenCodeUrl('/provider')).toBe('http://127.0.0.1:4096/provider');
  });

  it('keeps external OpenCode base URLs authoritative', () => {
    const runtime = createRuntime({
      state: { openCodeBaseUrl: 'http://remote.example:4096' },
    });

    expect(runtime.buildOpenCodeUrl('/provider')).toBe('http://remote.example:4096/provider');
  });

  it('normalizes wildcard and IPv6 OpenCode bind hosts for local connects', () => {
    expect(createRuntime({ configuredOpenCodeHostname: '0.0.0.0' }).buildOpenCodeUrl('/provider'))
      .toBe('http://127.0.0.1:4096/provider');
    expect(createRuntime({ configuredOpenCodeHostname: '::1' }).buildOpenCodeUrl('/provider'))
      .toBe('http://[::1]:4096/provider');
  });
});
