import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionStatus } from '@opencode-ai/sdk/v2/client';

import {
  applyTrayStatusFetchCompletion,
  buildSnapshot,
  createTrayRuntimeGenerationGuard,
} from './useTraySync';
import {
  applyGlobalSessionStatusSnapshot,
  markDirectoryStatusUnavailable,
  markTransportStatusUnavailable,
  resetGlobalSessionStatus,
  useGlobalSessionStatusStore,
} from '@/sync/global-session-status';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

/**
 * Tray status presentation tests (issue #2421).
 *
 * These exercise the REAL production status-resolution path: `buildSnapshot`
 * performs the same `resolveStatus`/`rollupStatus` conversion the Electron
 * tray consumes, and `applyTrayStatusFetchCompletion` is the production
 * completion commit for a per-directory status fetch. There is no in-test
 * re-implementation of either.
 *
 * Presentation contract: while a session's directory is unavailable, preserved
 * busy/retry must NOT be presented as confirmed active (busy/retry) and must
 * NOT be presented as confirmed idle. The tray converts it to 'reconnecting'.
 * Freshness is directory-scoped: a failed fetch for one directory does not
 * make another directory's status appear as reconnecting.
 */

// SAFETY: buildSnapshot only reads id/title/directory/parentID/time from a session.
const session = (id: string, directory: string, parentID?: string): Session => ({
  id,
  title: id,
  directory,
  parentID,
  projectID: 'p1',
  version: '1',
  time: { created: 1, updated: 1 },
} as Session);

const seedSessions = (sessions: Session[]): void => {
  useGlobalSessionsStore.setState({ activeSessions: sessions, archivedSessions: [] });
};

const trayStatusOf = (id: string): string | undefined => (
  buildSnapshot('Test').sessions.find((entry) => entry.id === id)?.status
);

beforeEach(() => {
  resetGlobalSessionStatus();
  useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [] });
});

describe('tray runtime generation guard (production)', () => {
  test('rejects an in-flight snapshot after the runtime changes', () => {
    let runtimeKey = 'runtime-a';
    const guard = createTrayRuntimeGenerationGuard(() => runtimeKey);
    const oldRequest = guard.capture();

    runtimeKey = 'runtime-b';
    guard.invalidate(runtimeKey);

    expect(guard.isCurrent(oldRequest)).toBe(false);
    expect(guard.isCurrent(guard.capture())).toBe(true);
  });

  test('invalidates same-key requests by generation as well as endpoint identity', () => {
    const guard = createTrayRuntimeGenerationGuard(() => 'runtime-a');
    const oldRequest = guard.capture();

    guard.invalidate('runtime-a');

    expect(guard.isCurrent(oldRequest)).toBe(false);
    expect(guard.isCurrent(guard.capture())).toBe(true);
  });

  test('stale failed completion cannot mark the new runtime directory unavailable', () => {
    let runtimeKey = 'runtime-a';
    const guard = createTrayRuntimeGenerationGuard(() => runtimeKey);
    const staleRequest = guard.capture();

    runtimeKey = 'runtime-b';
    guard.invalidate(runtimeKey);

    applyTrayStatusFetchCompletion('/repo', null, ['session-a'], staleRequest, guard);

    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has('/repo')).toBe(false);
  });

  test('stale successful completion cannot publish old-runtime status', () => {
    let runtimeKey = 'runtime-a';
    const guard = createTrayRuntimeGenerationGuard(() => runtimeKey);
    const staleRequest = guard.capture();

    runtimeKey = 'runtime-b';
    guard.invalidate(runtimeKey);

    applyTrayStatusFetchCompletion('/repo', { 'session-a': { type: 'busy' } }, ['session-a'], staleRequest, guard);

    expect(useGlobalSessionStatusStore.getState().statusById.has('session-a')).toBe(false);
  });

  test('current failed completion marks unavailable, current empty snapshot clears it', () => {
    const guard = createTrayRuntimeGenerationGuard(() => 'runtime-a');

    applyTrayStatusFetchCompletion('/repo', null, ['session-a'], guard.capture(), guard);
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has('/repo')).toBe(true);

    applyTrayStatusFetchCompletion('/repo', {}, ['session-a'], guard.capture(), guard);
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has('/repo')).toBe(false);
  });
});

describe('tray snapshot status resolution (production buildSnapshot)', () => {
  test('fresh busy resolves to busy', () => {
    seedSessions([session('session-a', '/repo')]);
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);

    expect(trayStatusOf('session-a')).toBe('busy');
  });

  test('fresh retry resolves to retry', () => {
    seedSessions([session('session-a', '/repo')]);
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'retry' } }, ['session-a']);

    expect(trayStatusOf('session-a')).toBe('retry');
  });

  test('null fetch preserves last-known busy/retry and resolves to reconnecting', () => {
    seedSessions([session('session-a', '/repo')]);
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    const guard = createTrayRuntimeGenerationGuard(() => 'runtime-a');

    // Tray null-fetch completion for /repo: preserve + mark unavailable.
    applyTrayStatusFetchCompletion('/repo', null, ['session-a'], guard.capture(), guard);

    // Raw data preserved internally; presentation is reconnecting, not busy/idle.
    expect(useGlobalSessionStatusStore.getState().statusById.get('session-a')?.status.type).toBe('busy');
    expect(trayStatusOf('session-a')).toBe('reconnecting');
  });

  test('retry details stay preserved while presentation resolves to reconnecting', () => {
    seedSessions([session('session-a', '/repo')]);
    const retryStatus: SessionStatus = { type: 'retry', attempt: 2, message: 'waiting', next: 10 };
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': retryStatus }, ['session-a']);

    markDirectoryStatusUnavailable('/repo');

    expect(useGlobalSessionStatusStore.getState().statusById.get('session-a')?.status).toEqual({
      type: 'retry', attempt: 2, message: 'waiting', next: 10,
    });
    expect(trayStatusOf('session-a')).toBe('reconnecting');
  });

  test('successful snapshot after reconnect clears unavailability and resolves to busy', () => {
    seedSessions([session('session-a', '/repo')]);
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markDirectoryStatusUnavailable('/repo');
    expect(trayStatusOf('session-a')).toBe('reconnecting');

    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);

    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has('/repo')).toBe(false);
    expect(trayStatusOf('session-a')).toBe('busy');
  });

  test('authoritative empty snapshot after reconnect clears busy and resolves to idle', () => {
    seedSessions([session('session-a', '/repo')]);
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markDirectoryStatusUnavailable('/repo');

    applyGlobalSessionStatusSnapshot('/repo', {}, ['session-a']);

    expect(useGlobalSessionStatusStore.getState().statusById.has('session-a')).toBe(false);
    expect(trayStatusOf('session-a')).toBe('idle');
  });

  test('transport-wide disconnect resolves preserved busy to reconnecting', () => {
    seedSessions([session('session-a', '/repo')]);
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);

    markTransportStatusUnavailable();

    expect(trayStatusOf('session-a')).toBe('reconnecting');
  });

  test('a failed fetch for one directory does not affect another directory', () => {
    seedSessions([session('session-a', '/repo-a'), session('session-b', '/repo-b')]);
    applyGlobalSessionStatusSnapshot('/repo-a', { 'session-a': { type: 'busy' } }, ['session-a']);
    applyGlobalSessionStatusSnapshot('/repo-b', { 'session-b': { type: 'busy' } }, ['session-b']);

    markDirectoryStatusUnavailable('/repo-a');

    expect(trayStatusOf('session-a')).toBe('reconnecting');
    expect(trayStatusOf('session-b')).toBe('busy');
  });

  test('root row rolls a busy sub-session up to busy and bundled sessions to reconnecting', () => {
    seedSessions([
      session('parent', '/repo'),
      session('child', '/repo', 'parent'),
    ]);
    applyGlobalSessionStatusSnapshot('/repo', {}, ['parent']);
    applyGlobalSessionStatusSnapshot('/repo', { child: { type: 'busy' } }, ['parent', 'child']);
    expect(trayStatusOf('parent')).toBe('busy');

    markDirectoryStatusUnavailable('/repo');

    expect(trayStatusOf('parent')).toBe('reconnecting');
    expect(trayStatusOf('child')).toBeUndefined();
  });

  test('runtime reset removes preserved data so the tray resolves to idle, not reconnecting', () => {
    seedSessions([session('session-a', '/repo')]);
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markDirectoryStatusUnavailable('/repo');

    resetGlobalSessionStatus({ blockEventUpdates: true });

    expect(useGlobalSessionStatusStore.getState().statusById.has('session-a')).toBe(false);
    expect(trayStatusOf('session-a')).toBe('idle');
  });
});
