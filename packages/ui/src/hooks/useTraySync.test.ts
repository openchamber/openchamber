import { beforeEach, describe, expect, test } from 'bun:test';

import { createTrayRuntimeGenerationGuard } from './useTraySync';
import {
  applyGlobalSessionStatusSnapshot,
  isSessionStatusFresh,
  markDirectoryStatusUnavailable,
  markTransportStatusUnavailable,
  resetGlobalSessionStatus,
  useGlobalSessionStatusStore,
} from '@/sync/global-session-status';

describe('tray runtime generation', () => {
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
});

// Regression tests for issue #2421 / PR #2485: the tray's null status fetch
// must preserve last known busy/retry status (mark unavailable), not destroy
// it or flip to idle. Mirrors the tray's refreshGlobalStatus call sequence.
//
// Presentation contract: while a session's directory is unavailable, preserved
// busy/retry must NOT be presented as confirmed active (busy/retry spinner) and
// must NOT be presented as confirmed idle. The tray converts preserved
// busy/retry to 'reconnecting' so the user sees the session is there but not
// confirmed running — neither a busy spinner nor idle.
//
// Freshness is directory-scoped: a failed fetch for one directory does not make
// another directory's status appear as reconnecting. A transport-wide
// disconnect/switch marks every directory stale.
describe('tray status poll unavailability preserves busy state as reconnecting', () => {
  beforeEach(() => {
    resetGlobalSessionStatus();
  });

  // Mirrors the tray's resolveStatus(): a session is active if the global
  // status index says so, BUT when the session's directory is unavailable,
  // preserved busy/retry is converted to 'reconnecting' — not reported as busy
  // and not reported as idle. Matches the tray's resolveStatus/rollupStatus
  // logic in useTraySync.ts.
  const resolveTrayStatus = (id: string): 'idle' | 'busy' | 'retry' | 'reconnecting' => {
    const state = useGlobalSessionStatusStore.getState();
    const globalEntry = state.statusById.get(id);
    const raw = globalEntry?.status.type ?? 'idle';
    // Directory-scoped: a failed fetch for one directory does not make another
    // directory's status appear as reconnecting. A transport-wide event marks
    // all directories stale.
    const unavailable = state.transportUnavailable
      || (globalEntry ? state.unavailableDirectories.has(globalEntry.directory) : false);
    if (unavailable && (raw === 'busy' || raw === 'retry')) return 'reconnecting';
    return raw;
  };

  test('busy + null fetch → status preserved (busy), directory unavailable, tray reports reconnecting', () => {
    // Seed busy via a successful snapshot (as the tray would on a prior poll).
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    expect(resolveTrayStatus('session-a')).toBe('busy');

    // Tray null-fetch path: markDirectoryStatusUnavailable(directory).
    markDirectoryStatusUnavailable('/repo');

    // Raw data preserved internally.
    expect(useGlobalSessionStatusStore.getState().statusById.get('session-a')?.status.type).toBe('busy');
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has('/repo')).toBe(true);
    expect(isSessionStatusFresh('session-a')).toBe(false);
    // Tray presentation: reconnecting, NOT busy and NOT idle.
    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
  });

  test('retry + null fetch → full retry details preserved, tray reports reconnecting', () => {
    applyGlobalSessionStatusSnapshot('/repo', {
      'session-a': { type: 'retry', attempt: 2, message: 'waiting', next: 10 },
    } as Record<string, { type?: string }>, ['session-a']);

    markDirectoryStatusUnavailable('/repo');

    // Raw retry details preserved internally.
    expect(useGlobalSessionStatusStore.getState().statusById.get('session-a')?.status).toEqual({
      type: 'retry', attempt: 2, message: 'waiting', next: 10,
    });
    // Tray presentation: reconnecting, NOT retry and NOT idle.
    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
  });

  test('repeated null fetches → status preserved, flag stays set, tray reports reconnecting', () => {
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);

    markDirectoryStatusUnavailable('/repo');
    markDirectoryStatusUnavailable('/repo');

    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has('/repo')).toBe(true);
  });

  test('SSE disconnect (transport-wide) → tray reports reconnecting (not busy, not idle)', () => {
    // onDisconnect calls markTransportStatusUnavailable.
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markTransportStatusUnavailable();
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(true);
    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
  });

  test('transport switch (transport-wide) → tray reports reconnecting (not busy, not idle)', () => {
    // onTransportSwitch calls markTransportStatusUnavailable.
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markTransportStatusUnavailable();
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(true);
    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
  });

  test('successful busy snapshot after reconnect → busy applied, flag cleared, tray reports busy', () => {
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markDirectoryStatusUnavailable('/repo');
    expect(resolveTrayStatus('session-a')).toBe('reconnecting');

    // Reconnect: tray fetch succeeds with a fresh busy snapshot.
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);

    expect(useGlobalSessionStatusStore.getState().statusById.get('session-a')?.status.type).toBe('busy');
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has('/repo')).toBe(false);
    expect(isSessionStatusFresh('session-a')).toBe(true);
    expect(resolveTrayStatus('session-a')).toBe('busy');
  });

  test('successful empty snapshot after reconnect → idle applied, flag cleared, tray reports idle', () => {
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markDirectoryStatusUnavailable('/repo');

    // Reconnect: tray fetch succeeds with an authoritative empty snapshot.
    applyGlobalSessionStatusSnapshot('/repo', {}, ['session-a']);

    expect(useGlobalSessionStatusStore.getState().statusById.has('session-a')).toBe(false);
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has('/repo')).toBe(false);
    expect(resolveTrayStatus('session-a')).toBe('idle');
  });

  test('real runtime replacement → data cleared, tray reports idle (no reconnecting)', () => {
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markDirectoryStatusUnavailable('/repo');

    // Real runtime replacement destroys stale data and clears both flags.
    resetGlobalSessionStatus({ blockEventUpdates: true });

    expect(useGlobalSessionStatusStore.getState().statusById.has('session-a')).toBe(false);
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(0);
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(false);
    // No preserved data → idle, not reconnecting.
    expect(resolveTrayStatus('session-a')).toBe('idle');
  });

  test('stale async completion from previous runtime generation → rejected before unavailable mark', () => {
    // The tray captures a generation token before the fetch and rechecks it
    // before writing. A runtime switch between capture and completion must
    // skip the unavailable mark entirely (the new runtime owns the store).
    let runtimeKey = 'runtime-a';
    const guard = createTrayRuntimeGenerationGuard(() => runtimeKey);
    const request = guard.capture();

    runtimeKey = 'runtime-b';
    guard.invalidate(runtimeKey);

    // Stale completion: guard rejects, so markDirectoryStatusUnavailable
    // is never called. Simulate the guard check the tray performs.
    if (guard.isCurrent(request)) {
      markDirectoryStatusUnavailable('/repo');
    }

    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has('/repo')).toBe(false);
  });

  test('tray representation during unavailability is reconnecting, never busy or idle', () => {
    // Explicit guard: the contract is that unavailable + preserved busy is
    // 'reconnecting', not 'busy' (would show a false spinner) and not 'idle'
    // (would hide evidence of a possibly-still-running turn).
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markDirectoryStatusUnavailable('/repo');

    const status = resolveTrayStatus('session-a');
    expect(status).not.toBe('busy');
    expect(status).not.toBe('idle');
    expect(status).toBe('reconnecting');
  });

  // Multi-directory: a failed fetch for one directory must not make another
  // directory's session appear as reconnecting. Freshness is directory-scoped.
  test('a failed fetch for /repo-a does not make a /repo-b session report reconnecting', () => {
    applyGlobalSessionStatusSnapshot('/repo-a', { 'session-a': { type: 'busy' } }, ['session-a']);
    applyGlobalSessionStatusSnapshot('/repo-b', { 'session-b': { type: 'busy' } }, ['session-b']);

    markDirectoryStatusUnavailable('/repo-a');

    // /repo-a: unavailable + preserved busy → reconnecting.
    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
    expect(isSessionStatusFresh('session-a')).toBe(false);
    // /repo-b: still fresh → busy, NOT reconnecting.
    expect(resolveTrayStatus('session-b')).toBe('busy');
    expect(isSessionStatusFresh('session-b')).toBe(true);
  });

  // Multi-directory race: completion order must not matter. Whether A fails
  // first or B succeeds first, A is reconnecting and B is fresh.
  test('multi-directory race: A fails, B succeeds → A reconnecting, B fresh', () => {
    applyGlobalSessionStatusSnapshot('/repo-a', { 'session-a': { type: 'busy' } }, ['session-a']);
    applyGlobalSessionStatusSnapshot('/repo-b', { 'session-b': { type: 'busy' } }, ['session-b']);

    // A's fetch fails first, then B's fetch succeeds with an empty snapshot.
    markDirectoryStatusUnavailable('/repo-a');
    applyGlobalSessionStatusSnapshot('/repo-b', {}, ['session-b']);

    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
    expect(resolveTrayStatus('session-b')).toBe('idle');
    expect(isSessionStatusFresh('session-a')).toBe(false);
    expect(isSessionStatusFresh('session-b')).toBe(true);
  });

  test('multi-directory race: B succeeds, A fails → same result (A reconnecting, B fresh)', () => {
    applyGlobalSessionStatusSnapshot('/repo-a', { 'session-a': { type: 'busy' } }, ['session-a']);
    applyGlobalSessionStatusSnapshot('/repo-b', { 'session-b': { type: 'busy' } }, ['session-b']);

    // B's fetch succeeds first, then A's fetch fails.
    applyGlobalSessionStatusSnapshot('/repo-b', {}, ['session-b']);
    markDirectoryStatusUnavailable('/repo-a');

    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
    expect(resolveTrayStatus('session-b')).toBe('idle');
    expect(isSessionStatusFresh('session-a')).toBe(false);
    expect(isSessionStatusFresh('session-b')).toBe(true);
  });

  test('both unavailable, then a successful snapshot for A → A fresh, B still unavailable', () => {
    applyGlobalSessionStatusSnapshot('/repo-a', { 'session-a': { type: 'busy' } }, ['session-a']);
    applyGlobalSessionStatusSnapshot('/repo-b', { 'session-b': { type: 'busy' } }, ['session-b']);
    markDirectoryStatusUnavailable('/repo-a');
    markDirectoryStatusUnavailable('/repo-b');

    // A's reconnect succeeds with a busy snapshot; B is still down.
    applyGlobalSessionStatusSnapshot('/repo-a', { 'session-a': { type: 'busy' } }, ['session-a']);

    // A: freshened by its own snapshot → busy.
    expect(resolveTrayStatus('session-a')).toBe('busy');
    expect(isSessionStatusFresh('session-a')).toBe(true);
    // B: still unavailable — A's success did not freshen B → reconnecting.
    expect(resolveTrayStatus('session-b')).toBe('reconnecting');
    expect(isSessionStatusFresh('session-b')).toBe(false);
  });
});