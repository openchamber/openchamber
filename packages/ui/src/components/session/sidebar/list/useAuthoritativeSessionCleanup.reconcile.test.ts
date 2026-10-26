import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '@/lib/opencode/model';
import { installHookTestDom } from '../test-utils/testDom';
import { ChildStoreManager } from '@/sync/child-store';
import { setActionRefs } from '@/sync/session-actions';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
const { useAuthoritativeSessionCleanup } = await import('./useAuthoritativeSessionCleanup');

// SAFETY: the cleanup identity path reads only `id` and `directory`; the rest
// of the record is filled to satisfy the SDK session shape.
const session = (id: string, directory = '/repo'): Session => ({
  id, directory, projectID: 'project', title: id,
  time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
} as Session);

const CleanupProbe: React.FC<{ sessions: Session[]; revision: number }> = ({ sessions, revision }) => {
  useAuthoritativeSessionCleanup({ enabled: true, hasAuthoritativeGlobalSessions: true, sessions });
  return React.createElement('span', null, revision);
};

describe('authoritative session cleanup reconciles the deletion', () => {
  let root: Root;
  let dom: ReturnType<typeof installHookTestDom>;
  let childStores: ChildStoreManager;

  beforeEach(() => {
    dom = installHookTestDom();
    root = createRoot(dom.container);
    childStores = new ChildStoreManager();
    setActionRefs(childStores, () => '/repo');
    const store = childStores.ensureChild('/repo', { bootstrap: false });
    store.setState({ session: [session('deleted'), session('retained')] });
    useGlobalSessionsStore.getState().applySnapshot([session('deleted'), session('retained')], [], 'ready');
    useSessionUIStore.getState().setCurrentSession('deleted', '/repo');
    useSpacesStore.getState().resetForRuntimeSwitch();
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.restore();
    childStores.disposeAll();
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    useSessionUIStore.getState().setCurrentSession(null);
  });

  test('a session omitted from a later complete snapshot leaves every live store and the active chat', () => {
    act(() => root.render(React.createElement(CleanupProbe, { sessions: [session('deleted'), session('retained')], revision: 0 })));
    act(() => root.render(React.createElement(CleanupProbe, { sessions: [session('retained')], revision: 1 })));

    const live = childStores.getChild('/repo')!.getState().session.map((item) => item.id);
    const global = useGlobalSessionsStore.getState();
    const ui = useSessionUIStore.getState();

    expect(live).toEqual(['retained']);
    expect(global.entityById.has('deleted')).toBe(false);
    expect(global.activeSessions.some((item) => item.id === 'deleted')).toBe(false);
    expect(ui.currentSessionId).toBe(null);
  });
});
