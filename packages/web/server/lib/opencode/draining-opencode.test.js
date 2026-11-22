import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPENCODE_DRAIN_GRACE_MS,
  createDrainingOpenCodeRegistry,
  resolveOpenCodeDrainGraceMs,
} from './draining-opencode.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const createFixture = ({ graceMs = 10_000 } = {}) => {
  const clock = { now: 0 };
  const timer = { tick: null };
  const requests = new Map();
  const busy = { ids: [] };
  const changes = [];
  const registry = createDrainingOpenCodeRegistry({
    graceMs,
    countRequests: (port) => requests.get(port) ?? 0,
    listBusySessionIds: () => busy.ids,
    onChange: (records) => changes.push(records),
    now: () => clock.now,
    setIntervalImpl: (fn) => {
      timer.tick = fn;
      return { unref() {} };
    },
    clearIntervalImpl: () => {
      timer.tick = null;
    },
  });
  const advance = async (ms) => {
    clock.now += ms;
    timer.tick?.();
    await flush();
  };
  const addEntry = (overrides = {}) => {
    const closed = [];
    registry.add({
      pid: 100,
      port: 4001,
      binary: '/usr/bin/opencode',
      drainStartedAt: clock.now,
      busySessionIds: [],
      close: async () => {
        closed.push(true);
      },
      ...overrides,
    });
    return closed;
  };
  return { registry, advance, addEntry, requests, busy, changes };
};

describe('draining OpenCode registry', () => {
  it('closes a replaced process once no session it was running is busy and no request still uses it', async () => {
    const fixture = createFixture();
    const closed = fixture.addEntry({ busySessionIds: ['ses_a'] });
    fixture.busy.ids = ['ses_a'];

    await fixture.advance(1000);
    expect(closed).toEqual([]);

    fixture.busy.ids = [];
    await fixture.advance(1000);
    expect(closed).toEqual([true]);
    expect(fixture.registry.has(100)).toBe(false);
  });

  it('keeps the process while a proxied request still answers from its port', async () => {
    const fixture = createFixture();
    const closed = fixture.addEntry({ busySessionIds: [] });
    fixture.requests.set(4001, 1);

    await fixture.advance(5000);
    expect(closed).toEqual([]);

    fixture.requests.set(4001, 0);
    await fixture.advance(1000);
    expect(closed).toEqual([true]);
  });

  it('never releases a busy session before the grace period ends, then closes it', async () => {
    const fixture = createFixture({ graceMs: 10_000 });
    const closed = fixture.addEntry({ busySessionIds: ['ses_a'] });
    fixture.busy.ids = ['ses_a'];

    await fixture.advance(9000);
    expect(closed).toEqual([]);

    await fixture.advance(2000);
    expect(closed).toEqual([true]);
  });

  it('waits for the grace period when the busy sessions at replacement are unknown', async () => {
    const fixture = createFixture({ graceMs: 10_000 });
    const closed = fixture.addEntry({ busySessionIds: null });

    await fixture.advance(5000);
    expect(closed).toEqual([]);

    await fixture.advance(5000);
    expect(closed).toEqual([true]);
  });

  it('records each replaced process once and reports the set for persistence', () => {
    const fixture = createFixture();
    fixture.addEntry({ pid: 100, port: 4001 });
    fixture.addEntry({ pid: 100, port: 4001 });
    fixture.addEntry({ pid: 101, port: 4002 });

    expect(fixture.registry.snapshot().map((record) => record.pid)).toEqual([100, 101]);
    expect(fixture.changes.at(-1).map((record) => record.pid)).toEqual([100, 101]);
  });

  it('closes every replaced process on a full stop', async () => {
    const fixture = createFixture();
    const first = fixture.addEntry({ pid: 100, port: 4001, busySessionIds: ['ses_a'] });
    const second = fixture.addEntry({ pid: 101, port: 4002, busySessionIds: null });
    fixture.busy.ids = ['ses_a'];

    await fixture.registry.closeAll('openchamber-stop');
    expect(first).toEqual([true]);
    expect(second).toEqual([true]);
    expect(fixture.registry.snapshot()).toEqual([]);
  });
});

describe('resolveOpenCodeDrainGraceMs', () => {
  it('defaults to thirty minutes', () => {
    expect(DEFAULT_OPENCODE_DRAIN_GRACE_MS).toBe(30 * 60 * 1000);
    expect(resolveOpenCodeDrainGraceMs({})).toBe(DEFAULT_OPENCODE_DRAIN_GRACE_MS);
  });

  it('reads the configured grace and ignores invalid values', () => {
    expect(resolveOpenCodeDrainGraceMs({ OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS: '5000' })).toBe(5000);
    expect(resolveOpenCodeDrainGraceMs({ OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS: '0' })).toBe(0);
    expect(resolveOpenCodeDrainGraceMs({ OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS: 'soon' })).toBe(DEFAULT_OPENCODE_DRAIN_GRACE_MS);
    expect(resolveOpenCodeDrainGraceMs({ OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS: '-1' })).toBe(DEFAULT_OPENCODE_DRAIN_GRACE_MS);
  });

  it('falls back to the default for non-decimal spellings a bare Number() would honour', () => {
    for (const raw of ['1e3', '0x10', '5.9', ' ', '+5000', '5000.0', '99999999999999999999999999']) {
      expect(resolveOpenCodeDrainGraceMs({ OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS: raw })).toBe(DEFAULT_OPENCODE_DRAIN_GRACE_MS);
    }
    // A plain decimal spelling still counts after trimming.
    expect(resolveOpenCodeDrainGraceMs({ OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS: ' 5000 ' })).toBe(5000);
  });
});
