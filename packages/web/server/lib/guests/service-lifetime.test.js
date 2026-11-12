import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createServiceLifetime } from './service-lifetime.js';

const row = (overrides = {}, service = {}) => ({
  id: 'desk',
  name: 'Desk',
  packageRoot: '/pkg',
  enabled: true,
  service: { entry: 'service/main.js', runtime: 'host', ...service },
  capabilityGrants: ['service'],
  ...overrides,
});

const harness = (guests) => {
  const state = { guests, status: 'stopped' };
  const proxyServiceRequest = vi.fn(async () => {
    state.status = 'ready';
    return { status: 200, body: '{}' };
  });
  const release = vi.fn();
  const holdService = vi.fn(() => release);
  const warn = vi.fn();
  const lifetime = createServiceLifetime({
    listGuests: async () => state.guests,
    proxyServiceRequest,
    holdService,
    serviceStatus: () => state.status,
    persistPath: '/store',
    createId: () => 'id',
    warn,
  });
  return { state, proxyServiceRequest, holdService, release, warn, lifetime };
};

describe('services that run with nobody asking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T10:00:30Z'));
  });
  afterEach(() => vi.useRealTimers());

  test('a kept service starts, stays held, and is released on a pause', async () => {
    const { state, lifetime, proxyServiceRequest, holdService, release } = harness([row({}, { keepRunning: true })]);
    await lifetime.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(holdService).toHaveBeenCalledWith('desk');
    expect(proxyServiceRequest).toHaveBeenCalledTimes(1);
    state.guests = [row({ enabled: false }, { keepRunning: true })];
    await lifetime.reconcile();
    expect(release).toHaveBeenCalledTimes(1);
    lifetime.stop();
  });

  test('a stopped service comes back, and one that keeps failing waits longer each time', async () => {
    const { state, lifetime, proxyServiceRequest } = harness([row({}, { keepRunning: true })]);
    proxyServiceRequest.mockRejectedValue(Object.assign(new Error('no'), { code: 'SERVICE_FAILED' }));
    await lifetime.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(3);
    expect(state.status).toBe('stopped');
    lifetime.stop();
  });

  test('a service that did not declare it is left alone', async () => {
    const { lifetime, proxyServiceRequest, holdService } = harness([row()]);
    await lifetime.reconcile();
    expect(holdService).not.toHaveBeenCalled();
    expect(proxyServiceRequest).not.toHaveBeenCalled();
    lifetime.stop();
  });

  test('an unapproved package does not start', async () => {
    const { lifetime, holdService } = harness([row({ capabilityGrants: [] }, { keepRunning: true })]);
    await lifetime.reconcile();
    expect(holdService).not.toHaveBeenCalled();
    lifetime.stop();
  });

  test('a schedule posts its run when due and arms the next', async () => {
    const { lifetime, proxyServiceRequest } = harness([row({}, { schedule: [{ id: 'tick', cron: '* * * * *' }] })]);
    await lifetime.reconcile();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(1);
    const params = proxyServiceRequest.mock.calls[0][0];
    expect(params).toMatchObject({ method: 'POST', path: '/schedule' });
    expect(JSON.parse(params.body)).toMatchObject({ v: 1, id: 'tick', at: Date.parse('2026-11-05T10:01:00Z') });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(2);
    lifetime.stop();
  });

  test('a pause between arming and the run stops the run', async () => {
    const { state, lifetime, proxyServiceRequest } = harness([row({}, { schedule: [{ id: 'tick', cron: '* * * * *' }] })]);
    await lifetime.reconcile();
    state.guests = [row({ enabled: false }, { schedule: [{ id: 'tick', cron: '* * * * *' }] })];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(proxyServiceRequest).not.toHaveBeenCalled();
    lifetime.stop();
  });

  test('a changed schedule is armed again, and a removed one never runs', async () => {
    const { state, lifetime, proxyServiceRequest } = harness([row({}, { schedule: [{ id: 'tick', cron: '0 12 * * *' }] })]);
    await lifetime.reconcile();
    state.guests = [row({}, { schedule: [{ id: 'tick', cron: '* * * * *' }] })];
    await lifetime.reconcile();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(1);
    state.guests = [row()];
    await lifetime.reconcile();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(1);
    lifetime.stop();
  });

  test('a schedule that does not parse is said once and runs nothing', async () => {
    const { lifetime, warn, proxyServiceRequest } = harness([row({}, { schedule: [{ id: 'bad', cron: '99 99 * * *' }] })]);
    await lifetime.reconcile();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(proxyServiceRequest).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    lifetime.stop();
  });

  test('a catalog that cannot be read changes nothing', async () => {
    const { lifetime, holdService, release } = harness([row({}, { keepRunning: true })]);
    await lifetime.reconcile();
    const failing = createServiceLifetime({
      listGuests: async () => { throw new Error('read'); },
      proxyServiceRequest: vi.fn(),
      holdService,
      serviceStatus: () => 'ready',
      persistPath: '/store',
    });
    await failing.reconcile();
    expect(release).not.toHaveBeenCalled();
    failing.stop();
    lifetime.stop();
  });

  test('stop ends the timers and lets every hold go', async () => {
    const { lifetime, release, proxyServiceRequest } = harness([row({}, { keepRunning: true, schedule: [{ id: 'tick', cron: '* * * * *' }] })]);
    await lifetime.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    const calls = proxyServiceRequest.mock.calls.length;
    lifetime.stop();
    expect(release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(calls);
  });
});

describe('a kept service whose approval went away', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('is not started again from the row it was kept with', async () => {
    const { state, lifetime, proxyServiceRequest, release } = harness([row({}, { keepRunning: true })]);
    await lifetime.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(1);
    state.status = 'stopped';
    state.guests = [row({ capabilityGrants: [] }, { keepRunning: true })];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(proxyServiceRequest).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    lifetime.stop();
  });
});
