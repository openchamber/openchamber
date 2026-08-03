import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeNetworkRuntime } from './network-runtime.js';

const originalFetch = globalThis.fetch;

const createRuntime = (overrides = {}) => createOpenCodeNetworkRuntime({
  state: {
    openCodePort: 4096,
    openCodeBaseUrl: null,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    ...overrides.state,
  },
  getOpenCodeAuthHeaders: () => ({}),
  configuredOpenCodeHostname: overrides.configuredOpenCodeHostname,
});

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

  it('does not probe a guardian-managed child or attach generic auth', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const authHeaders = vi.fn(() => ({ Authorization: 'Basic should-not-send' }));
    const runtime = createOpenCodeNetworkRuntime({
      state: {
        openCodePort: 4096,
        openCodeProcess: { isGuardianManaged: true },
      },
      getOpenCodeAuthHeaders: authHeaders,
    });

    await expect(runtime.waitForReady('http://127.0.0.1:4096', 100)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(authHeaders).not.toHaveBeenCalled();
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

  it('keeps an adopted IPv6 origin authoritative when configured host changed', () => {
    const runtime = createRuntime({
      configuredOpenCodeHostname: '10.0.0.9',
      state: { openCodeBaseUrl: 'http://[::1]:4123' },
    });

    expect(runtime.buildOpenCodeUrl('/event')).toBe('http://[::1]:4123/event');
  });

  it('normalizes wildcard and IPv6 OpenCode bind hosts for local connects', () => {
    expect(createRuntime({ configuredOpenCodeHostname: '0.0.0.0' }).buildOpenCodeUrl('/provider'))
      .toBe('http://127.0.0.1:4096/provider');
    expect(createRuntime({ configuredOpenCodeHostname: '::' }).buildOpenCodeUrl('/provider'))
      .toBe('http://[::1]:4096/provider');
    expect(createRuntime({ configuredOpenCodeHostname: '[::]' }).buildOpenCodeUrl('/provider'))
      .toBe('http://[::1]:4096/provider');
    expect(createRuntime({ configuredOpenCodeHostname: '::1' }).buildOpenCodeUrl('/provider'))
      .toBe('http://[::1]:4096/provider');
    expect(createRuntime({ configuredOpenCodeHostname: '[2001:db8::1]' }).buildOpenCodeUrl('/provider'))
      .toBe('http://[2001:db8::1]:4096/provider');
  });
});
