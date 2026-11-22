import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getSafeStorage } from '@/stores/utils/safeStorage';
import { applyGlobalSessionStatusSnapshot } from './global-session-status';
import {
  applyHostTurnStarts,
  applySessionActivityTimingMutations,
  needsHostTurnStarts,
  observeSessionActivityTiming,
  reconcileSessionActivityTiming,
  removeSessionActivityTiming,
  resetSessionActivityTiming,
  setHostTurnStartRequester,
  useSessionActivityTimingStore,
} from './session-activity-timing';

const STORAGE_KEY = 'oc.session-activity.v1';

const startedAt = (sessionId: string): number | undefined =>
  useSessionActivityTimingStore.getState().startedAt.get(sessionId);

const settledMs = (sessionId: string): number | undefined =>
  useSessionActivityTimingStore.getState().settledMs.get(sessionId);

type PersistedStart = { start: number; seen: number };

/** This device seeing the turn begin. */
const live = () => ({ at: Date.now(), source: 'live' as const });
/** The host's record of a start `agoMs` ago. */
const host = (agoMs: number) => ({ at: Date.now() - agoMs, source: 'host' as const });

let hostRequests = 0;

/** A host map read that went out and came back now, after every turn so far began. */
const readNow = () => ({ requestedAt: Date.now(), answeredAt: Date.now() });

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
  hostRequests = 0;
  setHostTurnStartRequester(() => { hostRequests += 1; });
});

afterEach(() => {
  getSafeStorage().removeItem(STORAGE_KEY);
  resetSessionActivityTiming();
  setHostTurnStartRequester(null);
});

describe('session activity timing', () => {
  test('starts a turn this device saw begin and keeps it stable', () => {
    observeSessionActivityTiming('ses_a', 'active', live());
    const first = startedAt('ses_a');
    expect(first).toBeGreaterThan(0);

    // Repeated busy/retry status events must not restart the counter.
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'active', live());
    expect(startedAt('ses_a')).toBe(first);
  });

  // Regression (#5259): a phone opening a turn that had run for 20 minutes on
  // the desktop counted from the moment it looked.
  test('a session seen running without a start shows no duration and asks the host once', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'active');
    snapshot(['ses_a']);

    expect(startedAt('ses_a')).toBe(undefined);
    expect(needsHostTurnStarts()).toBe(true);
    expect(hostRequests).toBe(1);

    const start = Date.now() - 20 * 60_000;
    applyHostTurnStarts(new Map([['ses_a', { at: start, source: 'host' }]]), new Set(), readNow());
    expect(startedAt('ses_a')).toBe(start);
    expect(needsHostTurnStarts()).toBe(false);
    expect(readPersisted()?.ses_a.start).toBe(start);
  });

  test('a host start replaces the start this device stood in with', () => {
    observeSessionActivityTiming('ses_a', 'active', live());
    expect(hostRequests).toBe(1);

    const hostStart = host(150);
    observeSessionActivityTiming('ses_a', 'active', hostStart);
    expect(startedAt('ses_a')).toBe(hostStart.at);

    // The same start arriving again with a different network delay is no news.
    observeSessionActivityTiming('ses_a', 'active', host(400));
    expect(startedAt('ses_a')).toBe(hostStart.at);
    // A start this device sees never replaces the host's.
    observeSessionActivityTiming('ses_a', 'active', live());
    expect(startedAt('ses_a')).toBe(hostStart.at);
  });

  test('a turn the host reports first counts from the host and asks nothing', () => {
    const hostStart = host(60_000);
    observeSessionActivityTiming('ses_a', 'active', hostStart);

    expect(startedAt('ses_a')).toBe(hostStart.at);
    expect(hostRequests).toBe(0);
  });

  // A parent idles while its background subagent works and runs again on the
  // result; the turn this device counts began before that second run.
  test('a later host start keeps a turn held open here, a clearly earlier one corrects it', () => {
    const first = host(5 * 60_000);
    observeSessionActivityTiming('ses_parent', 'active', first);
    applySessionActivityTimingMutations([{ type: 'hold', sessionId: 'ses_parent' }]);
    observeSessionActivityTiming('ses_parent', 'active', host(10_000));
    expect(startedAt('ses_parent')).toBe(first.at);

    const earlier = host(6 * 60_000);
    applyHostTurnStarts(new Map([['ses_parent', earlier]]), new Set(), readNow());
    expect(startedAt('ses_parent')).toBe(earlier.at);
  });

  // The phone slept through the end of one turn and the start of the next.
  test('a different host start for a turn not held open here means a missed turn change', () => {
    observeSessionActivityTiming('ses_a', 'active', host(30 * 60_000));
    const next = host(60_000);
    observeSessionActivityTiming('ses_a', 'active', next);
    expect(startedAt('ses_a')).toBe(next.at);
  });

  test('a host map read while a turn began here describes the turn before it', () => {
    const requestedAt = Date.now() - 50;
    observeSessionActivityTiming('ses_a', 'active', host(100));
    const current = startedAt('ses_a');

    applyHostTurnStarts(new Map([['ses_a', host(30 * 60_000)]]), new Set(), { requestedAt, answeredAt: Date.now() + 1 });
    expect(startedAt('ses_a')).toBe(current);
  });

  // The map read was already in flight when this device joined the running
  // turn. A join is not a new turn, so the read still carries this turn's
  // start and has to be applied; ignoring it here is what reset a late client
  // to the moment it attached.
  test('a host map read starts a turn this device only joined during the read', () => {
    const requestedAt = Date.now() - 50;
    snapshot(['ses_a']);
    expect(startedAt('ses_a')).toBe(undefined);

    const start = host(20 * 60_000);
    applyHostTurnStarts(new Map([['ses_a', start]]), new Set(), { requestedAt, answeredAt: Date.now() + 1 });
    expect(startedAt('ses_a')).toBe(start.at);
  });

  // A parent idling while its background subagent works: this device sees the
  // subagent, the host knows when the parent's turn began.
  test('a host start begins the turn of a session held open here', () => {
    const start = host(4 * 60_000);
    applyHostTurnStarts(new Map([['ses_parent', start]]), new Set(['ses_parent']), readNow());

    expect(startedAt('ses_parent')).toBe(start.at);
    expect(hostRequests).toBe(0);
    observeSessionActivityTiming('ses_parent', 'settled');
    expect(settledMs('ses_parent')).toBeGreaterThanOrEqual(4 * 60_000);
  });

  test('host starts for sessions not in a turn here are ignored', () => {
    applyHostTurnStarts(new Map([['ses_a', host(60_000)]]), new Set(), readNow());
    expect(startedAt('ses_a')).toBe(undefined);

    observeSessionActivityTiming('ses_b', 'active');
    snapshot([], ['ses_b']);
    applyHostTurnStarts(new Map([['ses_b', host(60_000)]]), new Set(), readNow());
    expect(startedAt('ses_b')).toBe(undefined);
    expect(needsHostTurnStarts()).toBe(false);
  });

  test('settling converts the start into a duration', () => {
    observeSessionActivityTiming('ses_a', 'active', live());
    observeSessionActivityTiming('ses_a', 'settled');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_a')).toBeGreaterThanOrEqual(0);
  });

  test('a new turn clears the previous settled duration', () => {
    observeSessionActivityTiming('ses_a', 'active', live());
    observeSessionActivityTiming('ses_a', 'settled');
    expect(settledMs('ses_a')).toBeDefined();

    observeSessionActivityTiming('ses_a', 'active', live());
    expect(settledMs('ses_a')).toBe(undefined);
    expect(startedAt('ses_a')).toBeDefined();
  });

  test('settling a session that was never observed active yields no duration', () => {
    observeSessionActivityTiming('ses_a', 'settled');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_a')).toBe(undefined);
  });

  test('snapshot reconciliation keeps covered actives and settles the rest', () => {
    observeSessionActivityTiming('ses_a', 'active', live());
    observeSessionActivityTiming('ses_b', 'active', live());

    snapshot(['ses_a'], ['ses_a', 'ses_b', 'ses_c']);

    expect(startedAt('ses_a')).toBeDefined();
    expect(startedAt('ses_b')).toBe(undefined);
    expect(settledMs('ses_b')).toBeGreaterThanOrEqual(0);
    // Never active, never covered by a start: nothing to report.
    expect(settledMs('ses_c')).toBe(undefined);
  });

  test('a session outside the snapshot scope keeps running', () => {
    observeSessionActivityTiming('ses_other_directory', 'active', live());
    const start = startedAt('ses_other_directory');
    expect(start).toBeDefined();

    snapshot([], ['ses_a']);

    expect(startedAt('ses_other_directory')).toBe(start);
  });

  test('persists the start and a liveness stamp for a running turn', () => {
    observeSessionActivityTiming('ses_a', 'active', live());

    const persisted = readPersisted();
    expect(persisted?.ses_a.start).toBe(startedAt('ses_a') as number);
    expect(persisted?.ses_a.seen).toBeGreaterThanOrEqual(persisted?.ses_a.start as number);
  });

  test('clears the persisted record when the turn ends', () => {
    observeSessionActivityTiming('ses_a', 'active', live());
    observeSessionActivityTiming('ses_a', 'settled');

    expect(readPersisted()).toBeNull();
  });

  test('resumes a persisted start when a status snapshot reports the session active', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBe(record.start);
    // Until the host confirms it.
    expect(hostRequests).toBe(1);
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
    observeSessionActivityTiming('ses_a', 'active', live());

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('a live idle event retires the persisted record', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    // The turn ended while the tab was gone; the event arrives on reconnect.
    observeSessionActivityTiming('ses_a', 'settled');
    // A later snapshot must not resurrect the retired start.
    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBe(undefined);
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

    // A turn seen this long after load is a new turn, not the one that was
    // running before the reload.
    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBe(undefined);
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

    expect(startedAt('ses_a')).toBe(undefined);
  });

  test('does not resume a turn older than the maximum turn age', () => {
    const before = Date.now();
    seedReload({ ses_a: { start: before - 48 * 60 * 60 * 1000, seen: before - 1_000 } });

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBe(undefined);
  });

  test('ignores malformed persisted payloads', () => {
    getSafeStorage().setItem(STORAGE_KEY, 'not json');
    resetSessionActivityTiming();

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBe(undefined);
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
      expect(startedAt(sessionId)).toBe(undefined);
    }
  });

  test('a quiet record ages out of storage on the next write', () => {
    const before = Date.now();
    seedReload({ ses_quiet: { start: before - 300_000, seen: before - 240_000 } });

    observeSessionActivityTiming('ses_a', 'active', live());

    expect(readPersisted()?.ses_quiet).toBe(undefined);
    expect(readPersisted()?.ses_a.start).toBeDefined();
  });

  test('deleting a session clears live, settled, and persisted timing', () => {
    observeSessionActivityTiming('ses_a', 'active', live());
    observeSessionActivityTiming('ses_b', 'active', live());
    observeSessionActivityTiming('ses_b', 'settled');

    removeSessionActivityTiming('ses_a');
    removeSessionActivityTiming('ses_b');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_b')).toBe(undefined);
    expect(readPersisted()).toBeNull();
  });

  test('unrelated sessions keep their map references across a no-op update', () => {
    observeSessionActivityTiming('ses_a', 'active', live());
    const before = useSessionActivityTimingStore.getState();

    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_unknown', 'settled');

    const after = useSessionActivityTimingStore.getState();
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.settledMs).toBe(before.settledMs);
  });
});
