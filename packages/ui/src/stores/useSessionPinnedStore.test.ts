import { beforeEach, describe, expect, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { getPinnedSessionKey, isSessionPinned, useSessionPinnedStore } from './useSessionPinnedStore';

describe('useSessionPinnedStore', () => {
  beforeEach(() => {
    useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
  });

  test('isolates identical session IDs by directory', () => {
    const store = useSessionPinnedStore.getState();
    store.toggle({ directory: '/repo-a', sessionId: 'session-1' });
    store.toggle({ directory: '/repo-b', sessionId: 'session-1' });

    expect(isSessionPinned(useSessionPinnedStore.getState().ids, '/repo-a/', 'session-1')).toBe(true);
    expect(isSessionPinned(useSessionPinnedStore.getState().ids, '/repo-b', 'session-1')).toBe(true);
    store.toggle({ directory: '/repo-a', sessionId: 'session-1' });
    expect(isSessionPinned(useSessionPinnedStore.getState().ids, '/repo-a', 'session-1')).toBe(false);
    expect(isSessionPinned(useSessionPinnedStore.getState().ids, '/repo-b', 'session-1')).toBe(true);
  });

  test('explicit deletion clears only the matching runtime and directory', () => {
    const runtimeKey = getRuntimeKey();
    const activeKey = getPinnedSessionKey(runtimeKey, '/repo', 'session-1')!;
    const otherRuntimeKey = getPinnedSessionKey('other-runtime', '/repo', 'session-1')!;
    useSessionPinnedStore.setState({
      ids: new Set([activeKey, otherRuntimeKey]),
      touchedAt: { [activeKey]: 1, [otherRuntimeKey]: 2 },
    });

    useSessionPinnedStore.getState().clearPinnedSession(runtimeKey, '/repo/', 'session-1');

    expect(useSessionPinnedStore.getState().ids.has(activeKey)).toBe(false);
    expect(useSessionPinnedStore.getState().ids.has(otherRuntimeKey)).toBe(true);
  });
});
