import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionActivityV1Snapshot,
  deleteSessionActivityEntry,
  getSessionActivitySnapshot,
  pruneStaleSessionActivity,
  pruneStaleSessionActivityEntries,
  SESSION_ACTIVITY_IDLE_TTL_MS,
  SESSION_ACTIVITY_PRUNE_INTERVAL_MS,
} from './sessionActivityWatcher';

describe('session-activity v1 envelope (design #612, #621)', () => {
  test('the bridge snapshot carries the v1 top-level keys and starts not ready', () => {
    const snapshot = getSessionActivitySnapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ['serverTime', 'sessions', 'version', 'watcherReady']);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.watcherReady, false);
    assert.equal(Number.isFinite(snapshot.serverTime), true);
    assert.deepEqual(snapshot.sessions, {});
  });

  test('each session entry carries the v1 keys, with host-unsourced fields as null', () => {
    const phases = new Map([['session-1', { phase: 'busy' as const, updatedAt: 1234 }]]);
    const snapshot = buildSessionActivityV1Snapshot(phases, true, 5678);
    assert.deepEqual(snapshot, {
      version: 1,
      serverTime: 5678,
      watcherReady: true,
      sessions: {
        'session-1': {
          type: 'busy',
          lastActivityAt: 1234,
          status: null,
          model: null,
          toolInFlight: null,
        },
      },
    });
    assert.deepEqual(Object.keys(snapshot.sessions['session-1']).sort(), [
      'lastActivityAt',
      'model',
      'status',
      'toolInFlight',
      'type',
    ]);
  });

  test('a session deleted after going busy disappears from the snapshot; a live idle session remains (#999)', () => {
    const phases = new Map([
      ['deleted-session', { phase: 'busy' as const, updatedAt: 1000 }],
      ['live-session', { phase: 'idle' as const, updatedAt: 2000 }],
    ]);
    assert.equal(deleteSessionActivityEntry(phases, 'deleted-session'), true);
    assert.equal(deleteSessionActivityEntry(phases, 'deleted-session'), false);
    const snapshot = buildSessionActivityV1Snapshot(phases, true, 5678);
    assert.deepEqual(Object.keys(snapshot.sessions), ['live-session']);
    assert.equal(snapshot.sessions['live-session'].type, 'idle');
  });

  test('the periodic prune removes a stale idle entry and clears its cooldown while the stream stays connected (#999)', () => {
    // Regression for the Codex finding on PR #1010: the TTL prune must not
    // depend on a reconnect. pruneStaleSessionActivity is the exact helper
    // the watcher's interval timer runs, so an entry that crosses the TTL
    // mid-connection is removed (with its cooldown timer) on the next tick.
    assert.equal(SESSION_ACTIVITY_PRUNE_INTERVAL_MS > 0, true);
    assert.equal(SESSION_ACTIVITY_PRUNE_INTERVAL_MS < SESSION_ACTIVITY_IDLE_TTL_MS, true);
    const now = SESSION_ACTIVITY_IDLE_TTL_MS * 4;
    const phases = new Map([
      ['stale-idle', { phase: 'idle' as const, updatedAt: 0 }],
      ['fresh-idle', { phase: 'idle' as const, updatedAt: now }],
    ]);
    const staleTimer = setTimeout(() => {}, 60_000);
    const cooldowns = new Map<string, NodeJS.Timeout>([['stale-idle', staleTimer]]);
    assert.deepEqual(pruneStaleSessionActivity(phases, cooldowns, now), ['stale-idle']);
    assert.deepEqual(Array.from(phases.keys()), ['fresh-idle']);
    // The pruned entry's cooldown timer is dropped from the map (and cleared
    // by the helper), so it cannot resurrect the entry later.
    assert.equal(cooldowns.size, 0);
  });

  test('the stale prune removes only entries idle past the TTL (#999)', () => {
    const now = SESSION_ACTIVITY_IDLE_TTL_MS * 4;
    const phases = new Map([
      ['stale-idle', { phase: 'idle' as const, updatedAt: 0 }],
      ['long-busy', { phase: 'busy' as const, updatedAt: 0 }],
      ['fresh-idle', { phase: 'idle' as const, updatedAt: now }],
    ]);
    assert.deepEqual(pruneStaleSessionActivityEntries(phases, now), ['stale-idle']);
    assert.deepEqual(Array.from(phases.keys()).sort(), ['fresh-idle', 'long-busy']);
  });
});
