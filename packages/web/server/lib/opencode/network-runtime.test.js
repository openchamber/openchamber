import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeNetworkRuntime } from './network-runtime.js';

const createRuntime = () => createOpenCodeNetworkRuntime({
  state: {
    openCodePort: 4096,
    openCodeBaseUrl: null,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
  },
  getOpenCodeAuthHeaders: () => ({}),
});

describe('OpenCode network runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('clears the probe abort timer when readiness fetch rejects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const runtime = createRuntime();
    const readyPromise = runtime.waitForReady('http://127.0.0.1:4096', 1);

    await vi.advanceTimersByTimeAsync(100);
    await expect(readyPromise).resolves.toBe(false);

    expect(vi.getTimerCount()).toBe(0);
  });
});
