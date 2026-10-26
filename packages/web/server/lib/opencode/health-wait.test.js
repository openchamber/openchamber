import { describe, it, expect } from 'vitest';
import { HEALTH_WAIT_MAX_MS, createSharedHealthProbe, parseHealthWaitMs, waitForOpenCodeHealth } from './health-wait.js';

const unhealthy = { healthy: false, status: 503, body: { healthy: false } };
const healthy = { healthy: true, status: 200, body: { healthy: true } };

// A clock that only moves when the wait sleeps, so the tests count probes
// instead of racing real timers.
const createClock = () => {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => { time += ms; },
  };
};

describe('parseHealthWaitMs', () => {
  it('reads whole milliseconds and caps them', () => {
    expect(parseHealthWaitMs('1500')).toBe(1500);
    expect(parseHealthWaitMs('999999')).toBe(HEALTH_WAIT_MAX_MS);
  });

  it('treats a missing or malformed value as no wait', () => {
    expect(parseHealthWaitMs(undefined)).toBe(0);
    expect(parseHealthWaitMs('')).toBe(0);
    expect(parseHealthWaitMs('-5')).toBe(0);
    expect(parseHealthWaitMs('1e9')).toBe(0);
    expect(parseHealthWaitMs(['100'])).toBe(0);
  });
});

describe('waitForOpenCodeHealth', () => {
  it('answers a healthy OpenCode with a single probe', async () => {
    let probes = 0;
    const result = await waitForOpenCodeHealth({ probe: async () => { probes += 1; return healthy; }, waitMs: 5000, ...createClock() });
    expect(result).toBe(healthy);
    expect(probes).toBe(1);
  });

  it('without a wait answers the first unhealthy probe', async () => {
    let probes = 0;
    const result = await waitForOpenCodeHealth({ probe: async () => { probes += 1; return unhealthy; }, waitMs: 0, ...createClock() });
    expect(result).toBe(unhealthy);
    expect(probes).toBe(1);
  });

  it('answers within one interval of OpenCode becoming ready', async () => {
    const clock = createClock();
    const result = await waitForOpenCodeHealth({
      probe: async () => (clock.now() >= 1250 ? healthy : unhealthy),
      waitMs: 5000,
      intervalMs: 100,
      ...clock,
    });
    expect(result).toBe(healthy);
    expect(clock.now()).toBe(1300);
  });

  it('gives up with the last unhealthy probe when the wait runs out', async () => {
    const clock = createClock();
    let probes = 0;
    const result = await waitForOpenCodeHealth({
      probe: async () => { probes += 1; return unhealthy; },
      waitMs: 1000,
      intervalMs: 100,
      ...clock,
    });
    expect(result).toBe(unhealthy);
    expect(clock.now()).toBe(1000);
    expect(probes).toBe(11);
  });

  it('stops probing once the client has gone away', async () => {
    const clock = createClock();
    let probes = 0;
    await waitForOpenCodeHealth({
      probe: async () => { probes += 1; return unhealthy; },
      waitMs: 5000,
      intervalMs: 100,
      isAborted: () => probes >= 3,
      ...clock,
    });
    expect(probes).toBe(3);
  });
});

describe('waitForOpenCodeHealth with an unsupported OpenCode', () => {
  it('answers at once instead of waiting out the wait', async () => {
    const clock = createClock();
    const unsupported = { healthy: false, final: true, status: 200, body: { healthy: false } };
    let probes = 0;
    const result = await waitForOpenCodeHealth({
      probe: async () => { probes += 1; return unsupported; },
      waitMs: 5000,
      intervalMs: 100,
      ...clock,
    });
    expect(result).toBe(unsupported);
    expect(probes).toBe(1);
    expect(clock.now()).toBe(0);
  });
});

describe('createSharedHealthProbe', () => {
  it('gives concurrent waiters one probe per interval', async () => {
    const clock = createClock();
    let probes = 0;
    const shared = createSharedHealthProbe({
      probe: async () => { probes += 1; return clock.now() >= 1000 ? healthy : unhealthy; },
      intervalMs: 100,
      now: clock.now,
    });
    const waiters = Array.from({ length: 5 }, () => waitForOpenCodeHealth({
      probe: shared,
      waitMs: 5000,
      intervalMs: 100,
      now: clock.now,
      // Each waiter advances the shared clock by its own sleep, so offset
      // waiters probe at different moments, as real concurrent requests do.
      sleep: async (ms) => { await clock.sleep(ms / 5); },
    }));
    const results = await Promise.all(waiters);
    expect(results.every((result) => result === healthy)).toBe(true);
    // Without sharing, five waiters probing every 100 ms would make five times as many.
    expect(probes).toBeLessThanOrEqual(12);
  });

  it('probes again once the interval has passed', async () => {
    const clock = createClock();
    let probes = 0;
    const shared = createSharedHealthProbe({ probe: async () => { probes += 1; return unhealthy; }, intervalMs: 100, now: clock.now });
    await shared();
    await shared();
    expect(probes).toBe(1);
    await clock.sleep(100);
    await shared();
    expect(probes).toBe(2);
  });

  it('does not reuse a probe that failed', async () => {
    const clock = createClock();
    let probes = 0;
    const shared = createSharedHealthProbe({
      probe: async () => { probes += 1; if (probes === 1) throw new Error('boom'); return healthy; },
      intervalMs: 100,
      now: clock.now,
    });
    await expect(shared()).rejects.toThrow('boom');
    expect(await shared()).toBe(healthy);
    expect(probes).toBe(2);
  });
});
