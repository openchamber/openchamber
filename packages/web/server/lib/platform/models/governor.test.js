// Per-user concurrency governor (plan section 11.2): independent users,
// limit enforcement, idempotent release, TTL-lease crash safety.

import { describe, expect, it } from 'vitest';

import { createConcurrencyGovernor } from './governor.js';

describe('createConcurrencyGovernor', () => {
  it('enforces the per-user limit with a 429-shaped rejection signal', () => {
    const governor = createConcurrencyGovernor({ maxPerUser: 2 });
    expect(governor.acquire('u1')).toEqual({ ok: true });
    expect(governor.acquire('u1')).toEqual({ ok: true });
    expect(governor.acquire('u1')).toEqual({ ok: false, code: 'concurrency_limited' });
    expect(governor.count('u1')).toBe(2);
  });

  it('tracks users independently', () => {
    const governor = createConcurrencyGovernor({ maxPerUser: 1 });
    expect(governor.acquire('u1')).toEqual({ ok: true });
    // u2 is unaffected by u1 holding the only-per-user slot.
    expect(governor.acquire('u2')).toEqual({ ok: true });
    expect(governor.acquire('u2')).toEqual({ ok: false, code: 'concurrency_limited' });
    expect(governor.count('u1')).toBe(1);
    expect(governor.count('u2')).toBe(1);
  });

  it('release frees a slot and is idempotent (never negative)', () => {
    const governor = createConcurrencyGovernor({ maxPerUser: 1 });
    governor.acquire('u1');
    expect(governor.release('u1')).toEqual({ ok: true, count: 0 });
    expect(governor.count('u1')).toBe(0);
    // Releasing with nothing held is a no-op success.
    expect(governor.release('u1')).toEqual({ ok: true, count: 0 });
    expect(governor.count('u1')).toBe(0);
    expect(governor.acquire('u1')).toEqual({ ok: true });
  });

  it('decrements stacked acquires one at a time', () => {
    const governor = createConcurrencyGovernor({ maxPerUser: 3 });
    governor.acquire('u1');
    governor.acquire('u1');
    expect(governor.count('u1')).toBe(2);
    expect(governor.release('u1')).toEqual({ ok: true, count: 1 });
    expect(governor.count('u1')).toBe(1);
  });

  it('frees slots via the TTL lease when a holder crashes without releasing', () => {
    let current = 1000;
    const governor = createConcurrencyGovernor({
      maxPerUser: 1,
      leaseTtlMs: 500,
      now: () => current,
    });
    expect(governor.acquire('u1')).toEqual({ ok: true });
    expect(governor.acquire('u1')).toEqual({ ok: false, code: 'concurrency_limited' });
    // The holder never released: after the lease expires the slot is freed.
    current += 501;
    expect(governor.count('u1')).toBe(0);
    expect(governor.acquire('u1')).toEqual({ ok: true });
  });

  it('a release arriving after the lease expiry is a no-op, not a negative count', () => {
    let current = 0;
    const governor = createConcurrencyGovernor({ maxPerUser: 2, leaseTtlMs: 100, now: () => current });
    governor.acquire('u1');
    governor.acquire('u1');
    current += 101;
    expect(governor.release('u1')).toEqual({ ok: true, count: 0 });
    expect(governor.count('u1')).toBe(0);
  });

  it('a fresh acquire refreshes the lease', () => {
    let current = 0;
    const governor = createConcurrencyGovernor({ maxPerUser: 2, leaseTtlMs: 100, now: () => current });
    governor.acquire('u1');
    current += 90;
    governor.acquire('u1');
    current += 90; // 180 since the first acquire, 90 since the second.
    expect(governor.count('u1')).toBe(2);
    current += 20; // lease from the second acquire now expired.
    expect(governor.count('u1')).toBe(0);
  });

  it('validates its configuration and arguments', () => {
    expect(() => createConcurrencyGovernor({ maxPerUser: 0 })).toThrow(/maxPerUser/);
    expect(() => createConcurrencyGovernor({ leaseTtlMs: 0 })).toThrow(/leaseTtlMs/);
    const governor = createConcurrencyGovernor();
    expect(() => governor.acquire('')).toThrow(/userId/);
    expect(() => governor.release('')).toThrow(/userId/);
  });
});
