// Per-user concurrent-request governor (plan section 11.2: per-user counting,
// atomic acquire, release on finish/timeout).
//
// In-process Map of userId -> {count, leaseExpiresAt}. Every successful
// acquire refreshes a TTL lease; a holder that crashes or hangs without
// releasing frees its slots when the lease expires, so a leaked slot can
// never wedge a user forever. Release is idempotent (releasing with nothing
// held is a no-op, never negative).
//
// MVP scope: single web process. A multi-process deployment would replace
// this with a shared store; the acquire/release contract would stay the
// same.

export function createConcurrencyGovernor({
  maxPerUser = 2,
  leaseTtlMs = 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (!Number.isInteger(maxPerUser) || maxPerUser < 1) {
    throw new Error('createConcurrencyGovernor requires maxPerUser >= 1');
  }
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error('createConcurrencyGovernor requires leaseTtlMs > 0');
  }

  // userId -> { count, leaseExpiresAt }
  const slots = new Map();

  // Lazily drop a lease that expired without release (crash-safety path).
  const expireIfDue = (userId) => {
    const slot = slots.get(userId);
    if (slot && slot.leaseExpiresAt <= now()) {
      slots.delete(userId);
    }
  };

  const acquire = (userId) => {
    if (typeof userId !== 'string' || userId === '') {
      throw new Error('governor.acquire requires a userId');
    }
    expireIfDue(userId);
    const slot = slots.get(userId);
    if (slot && slot.count >= maxPerUser) {
      return { ok: false, code: 'concurrency_limited' };
    }
    const next = slot ? slot.count + 1 : 1;
    slots.set(userId, { count: next, leaseExpiresAt: now() + leaseTtlMs });
    return { ok: true };
  };

  // Idempotent: releasing with nothing held is a no-op success, and a count
  // never goes below zero.
  const release = (userId) => {
    if (typeof userId !== 'string' || userId === '') {
      throw new Error('governor.release requires a userId');
    }
    expireIfDue(userId);
    const slot = slots.get(userId);
    if (!slot) {
      return { ok: true, count: 0 };
    }
    if (slot.count <= 1) {
      slots.delete(userId);
      return { ok: true, count: 0 };
    }
    const next = slot.count - 1;
    slots.set(userId, { count: next, leaseExpiresAt: now() + leaseTtlMs });
    return { ok: true, count: next };
  };

  const count = (userId) => {
    expireIfDue(userId);
    return slots.get(userId)?.count ?? 0;
  };

  return Object.freeze({ acquire, release, count, maxPerUser, leaseTtlMs });
}
