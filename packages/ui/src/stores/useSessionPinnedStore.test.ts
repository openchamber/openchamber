import { beforeEach, describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { getPinnedSessionKey, isSessionPinned } from '@/lib/sessionPins';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';
import { setPendingPin, useSessionPinnedStore } from './useSessionPinnedStore';

const session = (id: string, directory: string, pinned: boolean): Session => ({
  id, projectID: 'project', directory, title: id, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: pinned ? { openchamber: { pinned: { at: 1 } } } : {},
});

const pinned = (directory: string, sessionId: string) => isSessionPinned(useSessionPinnedStore.getState().ids, directory, sessionId);

describe('useSessionPinnedStore', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://pins.test', runtimeKey: 'pins-test' });
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  });

  test('reads pins from session metadata, per directory', () => {
    useGlobalSessionsStore.getState().applySnapshot([session('a', '/repo-a', true), session('b', '/repo-b', false)], []);

    expect(pinned('/repo-a/', 'a')).toBe(true);
    expect(pinned('/repo-b', 'b')).toBe(false);
    expect(pinned('/repo-b', 'a')).toBe(false);
  });

  test('follows a pin another client set', () => {
    useGlobalSessionsStore.getState().applySnapshot([session('a', '/repo', false)], []);
    expect(pinned('/repo', 'a')).toBe(false);

    useGlobalSessionsStore.getState().upsertSession(session('a', '/repo', true));
    expect(pinned('/repo', 'a')).toBe(true);
  });

  test('shows a click before the server answers, and drops it after', () => {
    useGlobalSessionsStore.getState().applySnapshot([session('a', '/repo', true), session('b', '/repo', false)], []);
    const keyA = getPinnedSessionKey(getRuntimeKey(), '/repo', 'a')!;
    const keyB = getPinnedSessionKey(getRuntimeKey(), '/repo', 'b')!;

    setPendingPin(keyA, false);
    setPendingPin(keyB, true);
    expect(pinned('/repo', 'a')).toBe(false);
    expect(pinned('/repo', 'b')).toBe(true);

    setPendingPin(keyA, null);
    setPendingPin(keyB, null);
    expect(pinned('/repo', 'a')).toBe(true);
    expect(pinned('/repo', 'b')).toBe(false);
  });

  test('keeps one server\'s pins off another', () => {
    useGlobalSessionsStore.getState().applySnapshot([session('a', '/repo', true)], []);
    expect(pinned('/repo', 'a')).toBe(true);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://other.test', runtimeKey: 'other-test' });
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    expect(pinned('/repo', 'a')).toBe(false);
  });
});
