import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import {
  applyGlobalSessionStatusEvent,
  replaceGlobalSessionStatusById,
  useGlobalSessionStatusStore,
} from './global-session-status';
import {
  HOST_STATUS_SEED_MAX_AGE_MS,
  buildHostStatusSeedEvents,
  seedGlobalSessionStatusFromHost,
} from './host-session-status-seed';
import { resetSessionOrdering } from './session-ordering';
import { resetSessionActivityTiming } from './session-activity-timing';

const NOW = 1_700_000_000_000;

const session = (id: string, directory: string): Session => ({
  id, directory, projectID: 'project', title: id,
  time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

describe('buildHostStatusSeedEvents', () => {
  test('adds busy and retry entries as busy, grouped by resolved directory', () => {
    const events = buildHostStatusSeedEvents({
      serverTime: NOW,
      sessions: {
        a: { status: 'busy', lastUpdateAt: NOW - 1_000 },
        b: { status: 'retry', lastUpdateAt: NOW - 1_000 },
        c: { status: 'idle', lastUpdateAt: NOW },
      },
    }, {
      isKnown: () => false,
      resolveDirectory: (id) => (id === 'a' ? '/repo' : id === 'b' ? '/other' : null),
    });

    expect([...events.keys()]).toEqual(['/repo', '/other']);
    expect(events.get('/repo')).toEqual([{
      type: 'session.status',
      properties: { sessionID: 'a', status: { type: 'busy' } },
    }]);
    expect(events.get('/other')?.[0]?.properties).toEqual({ sessionID: 'b', status: { type: 'busy' } });
  });

  test('skips sessions the client already observed, stale entries, and unresolved directories', () => {
    const events = buildHostStatusSeedEvents({
      serverTime: NOW,
      sessions: {
        known: { status: 'busy', lastUpdateAt: NOW },
        stale: { status: 'busy', lastUpdateAt: NOW - HOST_STATUS_SEED_MAX_AGE_MS - 1 },
        fresh: { status: 'busy', lastUpdateAt: NOW - HOST_STATUS_SEED_MAX_AGE_MS },
        unplaced: { status: 'busy', lastUpdateAt: NOW },
      },
    }, {
      isKnown: (id) => id === 'known',
      resolveDirectory: (id) => (id === 'unplaced' ? null : '/repo'),
    });

    expect([...events.keys()]).toEqual(['/repo']);
    expect(events.get('/repo')).toEqual([{
      type: 'session.status',
      properties: { sessionID: 'fresh', status: { type: 'busy' } },
    }]);
  });
});

describe('seedGlobalSessionStatusFromHost', () => {
  let originalGetSnapshot: typeof opencodeClient.getHostSessionStatusSnapshot;
  let snapshot: Awaited<ReturnType<typeof opencodeClient.getHostSessionStatusSnapshot>>;
  let requests = 0;

  beforeEach(() => {
    replaceGlobalSessionStatusById(new Map());
    resetSessionOrdering();
    resetSessionActivityTiming();
    requests = 0;
    originalGetSnapshot = opencodeClient.getHostSessionStatusSnapshot;
    opencodeClient.getHostSessionStatusSnapshot = async () => {
      requests += 1;
      return snapshot;
    };
    useGlobalSessionsStore.getState().applySnapshot([
      session('busy-elsewhere', '/unopened'),
      session('settled-here', '/repo'),
    ], [], 'ready');
  });

  afterEach(() => {
    opencodeClient.getHostSessionStatusSnapshot = originalGetSnapshot;
    replaceGlobalSessionStatusById(new Map());
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  });

  test('seeds an unopened directory session and never overrides a live observation', async () => {
    // A live idle arrived for this session before the host answered: the host
    // still lists it busy (its map lags), and the seed must not resurrect it.
    applyGlobalSessionStatusEvent('/repo', { type: 'session.idle', properties: { sessionID: 'settled-here' } });
    snapshot = {
      serverTime: NOW,
      sessions: {
        'busy-elsewhere': { status: 'busy', lastUpdateAt: NOW },
        'settled-here': { status: 'busy', lastUpdateAt: NOW },
      },
    };

    await seedGlobalSessionStatusFromHost();

    const state = useGlobalSessionStatusStore.getState();
    expect(state.statusById.get('busy-elsewhere')).toEqual({ status: { type: 'busy' }, directory: '/unopened' });
    expect(state.statusById.has('settled-here')).toBe(false);
    expect([...state.activeSessionIds]).toEqual(['busy-elsewhere']);
  });

  test('a failed fetch and an absent entry leave existing activity untouched', async () => {
    applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: 'settled-here', status: { type: 'busy' } } });
    snapshot = null;
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalSessionStatusStore.getState().statusById.has('settled-here')).toBe(true);

    snapshot = { serverTime: NOW, sessions: {} };
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalSessionStatusStore.getState().statusById.has('settled-here')).toBe(true);
  });

  test('coalesces overlapping calls into one request', async () => {
    snapshot = { serverTime: NOW, sessions: {} };
    await Promise.all([seedGlobalSessionStatusFromHost(), seedGlobalSessionStatusFromHost()]);
    expect(requests).toBe(1);
    await seedGlobalSessionStatusFromHost();
    expect(requests).toBe(2);
  });
});
