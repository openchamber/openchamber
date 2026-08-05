import { beforeEach, describe, expect, test } from 'bun:test';

import { createTrayRuntimeGenerationGuard } from './useTraySync';
import {
  applyGlobalSessionStatusSnapshot,
  markGlobalSessionStatusUnavailable,
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
// Presentation contract: while statusUnavailable === true, preserved busy/retry
// must NOT be presented as confirmed active (busy/retry spinner) and must NOT
// be presented as confirmed idle. The tray converts preserved busy/retry to
// 'reconnecting' so the user sees the session is there but not confirmed
// running — neither a busy spinner nor idle.
describe('tray status poll unavailability preserves busy state as reconnecting', () => {
  beforeEach(() => {
    resetGlobalSessionStatus();
  });

  // Mirrors the tray's resolveStatus(): a session is active if the global
  // status index says so, BUT when the index is unavailable, preserved
  // busy/retry is converted to 'reconnecting' — not reported as busy and not
  // reported as idle. Matches the tray's resolveStatus/rollupStatus logic.
  const resolveTrayStatus = (id: string): 'idle' | 'busy' | 'retry' | 'reconnecting' => {
    const state = useGlobalSessionStatusStore.getState();
    const raw = state.statusById.get(id)?.status.type ?? 'idle';
    if (state.statusUnavailable && (raw === 'busy' || raw === 'retry')) return 'reconnecting';
    return raw;
  };

  test('busy + null fetch → status preserved (busy), unavailable flag set, tray reports reconnecting', () => {
    // Seed busy via a successful snapshot (as the tray would on a prior poll).
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    expect(resolveTrayStatus('session-a')).toBe('busy');

    // Tray null-fetch path: markGlobalSessionStatusUnavailable().
    markGlobalSessionStatusUnavailable();

    // Raw data preserved internally.
    expect(useGlobalSessionStatusStore.getState().statusById.get('session-a')?.status.type).toBe('busy');
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true);
    // Tray presentation: reconnecting, NOT busy and NOT idle.
    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
  });

  test('retry + null fetch → full retry details preserved, tray reports reconnecting', () => {
    applyGlobalSessionStatusSnapshot('/repo', {
      'session-a': { type: 'retry', attempt: 2, message: 'waiting', next: 10 },
    } as Record<string, { type?: string }>, ['session-a']);

    markGlobalSessionStatusUnavailable();

    // Raw retry details preserved internally.
    expect(useGlobalSessionStatusStore.getState().statusById.get('session-a')?.status).toEqual({
      type: 'retry', attempt: 2, message: 'waiting', next: 10,
    });
    // Tray presentation: reconnecting, NOT retry and NOT idle.
    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
  });

  test('repeated null fetches → status preserved, flag stays set, tray reports reconnecting', () => {
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);

    markGlobalSessionStatusUnavailable();
    markGlobalSessionStatusUnavailable();

    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true);
  });

  test('SSE disconnect / transport switch → tray reports reconnecting (not busy, not idle)', () => {
    // Both onDisconnect and onTransportSwitch call markGlobalSessionStatusUnavailable.
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markGlobalSessionStatusUnavailable();
    expect(resolveTrayStatus('session-a')).toBe('reconnecting');
  });

  test('successful busy snapshot after reconnect → busy applied, flag cleared, tray reports busy', () => {
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markGlobalSessionStatusUnavailable();
    expect(resolveTrayStatus('session-a')).toBe('reconnecting');

    // Reconnect: tray fetch succeeds with a fresh busy snapshot.
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);

    expect(useGlobalSessionStatusStore.getState().statusById.get('session-a')?.status.type).toBe('busy');
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false);
    expect(resolveTrayStatus('session-a')).toBe('busy');
  });

  test('successful empty snapshot after reconnect → idle applied, flag cleared, tray reports idle', () => {
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markGlobalSessionStatusUnavailable();

    // Reconnect: tray fetch succeeds with an authoritative empty snapshot.
    applyGlobalSessionStatusSnapshot('/repo', {}, ['session-a']);

    expect(useGlobalSessionStatusStore.getState().statusById.has('session-a')).toBe(false);
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false);
    expect(resolveTrayStatus('session-a')).toBe('idle');
  });

  test('real runtime replacement → data cleared, tray reports idle (no reconnecting)', () => {
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markGlobalSessionStatusUnavailable();

    // Real runtime replacement destroys stale data and clears the flag.
    resetGlobalSessionStatus({ blockEventUpdates: true });

    expect(useGlobalSessionStatusStore.getState().statusById.has('session-a')).toBe(false);
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false);
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

    // Stale completion: guard rejects, so markGlobalSessionStatusUnavailable
    // is never called. Simulate the guard check the tray performs.
    if (guard.isCurrent(request)) {
      markGlobalSessionStatusUnavailable();
    }

    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false);
  });

  test('tray representation during unavailability is reconnecting, never busy or idle', () => {
    // Explicit guard: the contract is that unavailable + preserved busy is
    // 'reconnecting', not 'busy' (would show a false spinner) and not 'idle'
    // (would hide evidence of a possibly-still-running turn).
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    markGlobalSessionStatusUnavailable();

    const status = resolveTrayStatus('session-a');
    expect(status).not.toBe('busy');
    expect(status).not.toBe('idle');
    expect(status).toBe('reconnecting');
  });
});