import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { Metadata, Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { isSessionPinned, isSessionPinnedInMetadata } from '@/lib/sessionPins';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import * as sessionRoutes from './session-archive-batch';
import { toggleSessionPin } from './session-pins';

const session = (id: string, metadata: Metadata = {}): Session => ({
  id, projectID: 'project', directory: '/repo', title: id, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, metadata,
});

const pinned = (sessionId: string) => isSessionPinned(useSessionPinnedStore.getState().ids, '/repo', sessionId);

// The server applies the merge patch to what it holds, as the metadata route does.
const applyPatch = (current: Metadata, patch: Metadata): Metadata => {
  const next: Metadata = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const previous = next[key];
    if (value === null) delete next[key];
    else if (value && typeof value === 'object' && !Array.isArray(value) && previous && typeof previous === 'object' && !Array.isArray(previous)) {
      next[key] = applyPatch(previous, value);
    } else next[key] = value;
  }
  return next;
};

describe('toggleSessionPin', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://session-pins.test', runtimeKey: 'session-pins-test' });
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    useGlobalSessionsStore.getState().applySnapshot([session('a')], []);
    spyOn(opencodeClient, 'getSession').mockImplementation(async (id) => {
      const item = useGlobalSessionsStore.getState().entityById.get(id);
      if (!item) throw new Error('not found');
      return item;
    });
  });
  afterEach(() => { mock.restore(); });

  test('stores the pin in the session metadata, and unpins the same way', async () => {
    spyOn(sessionRoutes, 'requestSessionMetadataUpdate').mockImplementation(async (id, patch) => ({
      outcome: 'updated',
      metadata: applyPatch(useGlobalSessionsStore.getState().entityById.get(id)?.metadata ?? {}, patch),
    }));

    const pinning = toggleSessionPin({ directory: '/repo', sessionId: 'a' });
    expect(pinned('a')).toBe(true);
    await pinning;
    expect(isSessionPinnedInMetadata(useGlobalSessionsStore.getState().entityById.get('a'))).toBe(true);
    expect(pinned('a')).toBe(true);

    await toggleSessionPin({ directory: '/repo', sessionId: 'a' });
    expect(isSessionPinnedInMetadata(useGlobalSessionsStore.getState().entityById.get('a'))).toBe(false);
    expect(pinned('a')).toBe(false);
  });

  test('flips the row back when the server cannot store the pin', async () => {
    spyOn(sessionRoutes, 'requestSessionMetadataUpdate').mockResolvedValue({ outcome: 'unavailable', reason: 'offline' });

    const pinning = toggleSessionPin({ directory: '/repo', sessionId: 'a' });
    expect(pinned('a')).toBe(true);
    await expect(pinning).rejects.toThrow();
    expect(pinned('a')).toBe(false);
  });
});
