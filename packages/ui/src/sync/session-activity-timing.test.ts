import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getSafeStorage } from '@/stores/utils/safeStorage';
import { applyGlobalSessionStatusSnapshot } from './global-session-status';
import {
  observeSessionActivityTiming,
  reconcileSessionActivityTiming,
  removeSessionActivityTiming,
  resetSessionActivityTiming,
  useSessionActivityTimingStore,
} from './session-activity-timing';

const STORAGE_KEY = 'oc.session-activity.v1';

const startedAt = (sessionId: string): number | undefined =>
  useSessionActivityTimingStore.getState().startedAt.get(sessionId);

const settledMs = (sessionId: string): number | undefined =>
  useSessionActivityTimingStore.getState().settledMs.get(sessionId);

type PersistedStart = { start: number; seen: number };

const readPersisted = (): Record<string, PersistedStart> | null => {
  const raw = getSafeStorage().getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, PersistedStart>) : null;
};

/**
 * Seed a previous page session's record, then simulate the reload.
 * `loadedAgoMs` places this page's navigation start in the past, which is how a
 * slow bootstrap or an expired adoption window is expressed.
 */
const seedReload = (payload: unknown, loadedAgoMs = 0): void => {
  getSafeStorage().setItem(STORAGE_KEY, JSON.stringify(payload));
  resetSessionActivityTiming({ pageLoadAt: Date.now() - loadedAgoMs });
};

/** A status snapshot: which sessions it reports busy, and which it covers. */
const snapshot = (activeIds: string[], coveredIds: string[] = activeIds): void => {
  const covered = new Set(coveredIds);
  reconcileSessionActivityTiming(new Set(activeIds), (sessionId) => covered.has(sessionId));
};

/** A record for a turn that began `ageMs` ago and was alive until the reload. */
const runningUntilReload = (ageMs: number, loadedAgoMs = 0, quietFor = 1_000): PersistedStart => ({
  start: Date.now() - ageMs,
  seen: Date.now() - loadedAgoMs - quietFor,
});

beforeEach(() => {
  getSafeStorage().removeItem(STORAGE_KEY);
  resetSessionActivityTiming();
});

afterEach(() => {
  getSafeStorage().removeItem(STORAGE_KEY);
  resetSessionActivityTiming();
});

describe('session activity timing', () => {
  test('starts a turn on the first active observation and keeps it stable', () => {
    observeSessionActivityTiming('ses_a', 'active');
    const first = startedAt('ses_a');
    expect(first).toBeGreaterThan(0);

    // Repeated busy/retry status events must not restart the counter.
    observeSessionActivityTiming('ses_a', 'active');
    expect(startedAt('ses_a')).toBe(first);
  });

  test('settling converts the start into a duration', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'settled');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_a')).toBeGreaterThanOrEqual(0);
  });

  test('a new turn clears the previous settled duration', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'settled');
    expect(settledMs('ses_a')).toBeDefined();

    observeSessionActivityTiming('ses_a', 'active');
    expect(settledMs('ses_a')).toBe(undefined);
    expect(startedAt('ses_a')).toBeDefined();
  });

  test('settling a session that was never observed active yields no duration', () => {
    observeSessionActivityTiming('ses_a', 'settled');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_a')).toBe(undefined);
  });

  test('snapshot reconciliation starts covered actives and settles the rest', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_b', 'active');

    snapshot(['ses_a'], ['ses_a', 'ses_b', 'ses_c']);

    expect(startedAt('ses_a')).toBeDefined();
    expect(startedAt('ses_b')).toBe(undefined);
    expect(settledMs('ses_b')).toBeGreaterThanOrEqual(0);
    // Never active, never covered by a start: nothing to report.
    expect(settledMs('ses_c')).toBe(undefined);
  });

  test('a session outside the snapshot scope keeps running', () => {
    observeSessionActivityTiming('ses_other_directory', 'active');
    const start = startedAt('ses_other_directory');

    snapshot([], ['ses_a']);

    expect(startedAt('ses_other_directory')).toBe(start);
  });

  test('persists the start and a liveness stamp for a running turn', () => {
    observeSessionActivityTiming('ses_a', 'active');

    const persisted = readPersisted();
    expect(persisted?.ses_a.start).toBe(startedAt('ses_a') as number);
    expect(persisted?.ses_a.seen).toBeGreaterThanOrEqual(persisted?.ses_a.start as number);
  });

  test('clears the persisted record when the turn ends', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'settled');

    expect(readPersisted()).toBeNull();
  });

  test('resumes a persisted start when a status snapshot reports the session active', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBe(record.start);
  });

  // Regression: the server re-publishes `session.status: busy` at every step of
  // the agent loop, so after a reload one of those repeats normally arrives
  // before the first status snapshot. Reading a busy event as "a turn just
  // started" therefore reset the counter on almost every refresh.
  test('resumes when a repeated busy event arrives before the first snapshot', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBe(record.start);
  });

  test('the turn after a resumed one still counts from zero', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    // Reload lands mid-turn: the snapshot resumes it…
    snapshot(['ses_a'], ['ses_a']);
    expect(startedAt('ses_a')).toBe(record.start);

    // …it finishes, which retires the record, so the next turn starts fresh.
    observeSessionActivityTiming('ses_a', 'settled');
    const before = Date.now();
    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('a live idle event retires the persisted record', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    // The turn ended while the tab was gone; the event arrives on reconnect.
    observeSessionActivityTiming('ses_a', 'settled');
    // A later snapshot must not resurrect the retired start.
    const before = Date.now();
    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  // The absence is measured from navigation start, not from "now", so a slow
  // bootstrap on a slow machine cannot spend the whole allowance before the
  // first status snapshot arrives.
  test('resumes even when bootstrap takes most of a minute', () => {
    const loadedAgoMs = 45_000;
    const record = runningUntilReload(300_000, loadedAgoMs);
    seedReload({ ses_a: record }, loadedAgoMs);

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBe(record.start);
  });

  test('does not adopt a record once the adoption window has passed', () => {
    const loadedAgoMs = 5 * 60_000;
    const record = runningUntilReload(300_000, loadedAgoMs);
    seedReload({ ses_a: record }, loadedAgoMs);

    // A turn starting this long after load is a new turn, not the one that was
    // running before the reload.
    const before = Date.now();
    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  // Regression: bootstrap fetches status and sessions in parallel, so a
  // snapshot can legitimately cover a session before it can see it busy.
  // Treating that as "the turn ended" used to destroy the persisted start
  // moments before the real busy snapshot arrived, resetting the counter to 0s.
  test('an early snapshot that cannot see the session busy does not lose the start', () => {
    const record = runningUntilReload(120_000);
    seedReload({ ses_a: record });

    applyGlobalSessionStatusSnapshot('/repo', {}, ['ses_a']);
    applyGlobalSessionStatusSnapshot('/repo', { ses_a: { type: 'busy' } }, ['ses_a']);

    expect(startedAt('ses_a')).toBe(record.start);
  });

  test('resumes through a snapshot that arrives before the session list loads', () => {
    const record = runningUntilReload(120_000);
    seedReload({ ses_a: record });

    applyGlobalSessionStatusSnapshot('/repo', { ses_a: { type: 'busy' } }, []);

    expect(startedAt('ses_a')).toBe(record.start);
  });

  test('does not resume a record whose liveness stamp has gone quiet', () => {
    const before = Date.now();
    seedReload({ ses_a: { start: before - 300_000, seen: before - 240_000 } });

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('does not resume a turn older than the maximum turn age', () => {
    const before = Date.now();
    seedReload({ ses_a: { start: before - 48 * 60 * 60 * 1000, seen: before - 1_000 } });

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('ignores malformed persisted payloads', () => {
    getSafeStorage().setItem(STORAGE_KEY, 'not json');
    resetSessionActivityTiming();

    const before = Date.now();
    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('ignores entries of the wrong shape or dated in the future', () => {
    const before = Date.now();
    seedReload({
      ses_a: before - 5_000,
      ses_b: { start: 'nope', seen: before },
      ses_c: { start: before + 60_000, seen: before },
      ses_d: { start: before - 5_000, seen: before + 60_000 },
    });

    for (const sessionId of ['ses_a', 'ses_b', 'ses_c', 'ses_d']) {
      snapshot([sessionId]);
      expect(startedAt(sessionId)).toBeGreaterThanOrEqual(before);
    }
  });

  test('a quiet record ages out of storage on the next write', () => {
    const before = Date.now();
    seedReload({ ses_quiet: { start: before - 300_000, seen: before - 240_000 } });

    observeSessionActivityTiming('ses_a', 'active');

    expect(readPersisted()?.ses_quiet).toBe(undefined);
    expect(readPersisted()?.ses_a.start).toBeDefined();
  });

  test('deleting a session clears live, settled, and persisted timing', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_b', 'active');
    observeSessionActivityTiming('ses_b', 'settled');

    removeSessionActivityTiming('ses_a');
    removeSessionActivityTiming('ses_b');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_b')).toBe(undefined);
    expect(readPersisted()).toBeNull();
  });

  test('unrelated sessions keep their map references across a no-op update', () => {
    observeSessionActivityTiming('ses_a', 'active');
    const before = useSessionActivityTimingStore.getState();

    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_unknown', 'settled');

    const after = useSessionActivityTimingStore.getState();
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.settledMs).toBe(before.settledMs);
  });
});
