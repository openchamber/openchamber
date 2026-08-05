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
describe('tray status poll unavailability preserves busy state', () => {
  beforeEach(() => {
    resetGlobalSessionStatus();
  });

  // Mirrors the tray's resolveStatus(): a session is active if the global
  // status index says so. When the index preserves busy data through a
  // transient outage, the tray must still report busy — not idle.
  const resolveTrayStatus = (id: string): 'idle' | 'busy' | 'retry' =>
    useGlobalSessionStatusStore.getState().statusById.get(id)?.status.type ?? 'idle';

  test('busy + null fetch → status preserved (busy), unavailable flag set, tray still reports busy', () => {
    // Seed busy via a successful snapshot (as the tray would on a prior poll).
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);
    expect(resolveTrayStatus('session-a')).toBe('busy');

    // Tray null-fetch path: markGlobalSessionStatusUnavailable().
    markGlobalSessionStatusUnavailable();

    expect(useGlobalSessionStatusStore.getState().statusById.get('session-a')?.status.type).toBe('busy');
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true);
    // The tray's status resolution still reports busy, NOT idle.
    expect(resolveTrayStatus('session-a')).toBe('busy');
  });

  test('retry + null fetch → full retry details preserved, tray still reports retry', () => {
    applyGlobalSessionStatusSnapshot('/repo', {
      'session-a': { type: 'retry', attempt: 2, message: 'waiting', next: 10 },
    } as Record<string, { type?: string }>, ['session-a']);

    markGlobalSessionStatusUnavailable();

    expect(useGlobalSessionStatusStore.getState().statusById.get('session-a')?.status).toEqual({
      type: 'retry', attempt: 2, message: 'waiting', next: 10,
    });
    expect(resolveTrayStatus('session-a')).toBe('retry');
  });

  test('repeated null fetches → status preserved, flag stays set', () => {
    applyGlobalSessionStatusSnapshot('/repo', { 'session-a': { type: 'busy' } }, ['session-a']);

    markGlobalSessionStatusUnavailable();
    markGlobalSessionStatusUnavailable();

    expect(resolveTrayStatus('session-a')).toBe('busy');
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true);
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

  test('runtime generation guard still rejects a stale completion before the unavailable mark', () => {
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
});
