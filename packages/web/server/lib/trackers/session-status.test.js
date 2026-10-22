import { describe, expect, it, vi } from 'vitest';
import { createTrackerSessionStatus } from './session-status.js';

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** A registry whose `linear` load fails `failures` times before it succeeds, beside a tracker without comments. */
const registryWith = ({ failures = 0 } = {}) => {
  const runtime = { processPayload: vi.fn() };
  let left = failures;
  const implementation = vi.fn(async (id) => {
    if (id === 'plain') return {};
    if (left > 0) {
      left -= 1;
      throw new Error('import failed');
    }
    return { sessionStatus: { createRuntime: () => runtime } };
  });
  return { registry: { list: () => ['linear', 'plain'], implementation }, runtime, implementation };
};

describe('tracker session status', () => {
  it('starts a tracker\'s runtime on the first event and hands it the events that came while it loaded', async () => {
    const { registry, runtime, implementation } = registryWith();
    const status = createTrackerSessionStatus({ registry });

    status.processPayload({ n: 1 });
    status.processPayload({ n: 2 });
    await settle();
    status.processPayload({ n: 3 });

    expect(runtime.processPayload.mock.calls.map(([payload]) => payload.n)).toEqual([1, 2, 3]);
    expect(implementation.mock.calls.filter(([id]) => id === 'linear')).toHaveLength(1);
  });

  it('retries a failed load on a later event instead of staying silent', async () => {
    let time = 0;
    const { registry, runtime, implementation } = registryWith({ failures: 1 });
    const warn = vi.fn();
    const status = createTrackerSessionStatus({ registry, now: () => time, retryAfterMs: 1_000, warn });

    status.processPayload({ n: 1 });
    await settle();
    expect(warn).toHaveBeenCalledOnce();
    // Too soon: the failing tracker is not imported again on every event.
    time = 500;
    status.processPayload({ n: 2 });
    expect(implementation.mock.calls.filter(([id]) => id === 'linear')).toHaveLength(1);

    time = 1_500;
    status.processPayload({ n: 3 });
    await settle();
    status.processPayload({ n: 4 });

    expect(runtime.processPayload.mock.calls.map(([payload]) => payload.n)).toEqual([3, 4]);
  });
});
