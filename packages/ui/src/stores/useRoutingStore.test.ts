import { beforeEach, describe, expect, test } from 'bun:test';
import { useRoutingStore, selectAutoReady } from './useRoutingStore';
import { ROUTING_UNAVAILABLE } from '@/lib/routing/routingApi';

describe('useRoutingStore', () => {
  beforeEach(() => {
    useRoutingStore.setState({ ...ROUTING_UNAVAILABLE, loaded: false, loadError: null, decisions: {}, held: {} });
  });

  test('offers Auto only when the server says routing is available and ready', () => {
    expect(selectAutoReady(useRoutingStore.getState())).toBe(false);
    useRoutingStore.getState().applyState({ ...ROUTING_UNAVAILABLE, available: true, autoReady: true, tokenPresent: true });
    expect(selectAutoReady(useRoutingStore.getState())).toBe(true);
    useRoutingStore.getState().applyState({ ...ROUTING_UNAVAILABLE, available: true, autoReady: false, tokenPresent: true });
    expect(selectAutoReady(useRoutingStore.getState())).toBe(false);
  });

  test('keeps held permissions until they are released', () => {
    const store = useRoutingStore.getState();
    store.holdPermission({ permissionId: 'p1', score: 0.9, kind: 'git_history' });
    expect(useRoutingStore.getState().held.p1?.kind).toBe('git_history');
    store.releasePermission('p1');
    expect(useRoutingStore.getState().held.p1).toBeUndefined();
    const before = useRoutingStore.getState();
    store.releasePermission('missing');
    expect(useRoutingStore.getState()).toBe(before);
  });

  test('applyState adopts the server held list, applyAvailability leaves it alone', () => {
    const store = useRoutingStore.getState();
    store.applyState({ ...ROUTING_UNAVAILABLE, available: true, autoReady: true, tokenPresent: true, heldPermissions: [{ permissionId: 'p2', score: 0.7, kind: null }] });
    expect(Object.keys(useRoutingStore.getState().held)).toEqual(['p2']);
    useRoutingStore.getState().applyAvailability({ available: false, autoReady: false, tokenPresent: false });
    expect(Object.keys(useRoutingStore.getState().held)).toEqual(['p2']);
    expect(useRoutingStore.getState().autoReady).toBe(false);
  });

  test('records the latest decision per session', () => {
    const store = useRoutingStore.getState();
    store.recordDecision({ sessionId: 's1', at: 1, category: 'hard', confidence: 0.9, reason: 'routed' });
    store.recordDecision({ sessionId: 's1', at: 2, category: null, confidence: 0.3, reason: 'low-confidence' });
    expect(useRoutingStore.getState().decisions.s1.reason).toBe('low-confidence');
  });

  test('a runtime switch drops the previous server state before the new load', () => {
    const store = useRoutingStore.getState();
    store.applyState({ ...ROUTING_UNAVAILABLE, available: true, autoReady: true, tokenPresent: true });
    store.holdPermission({ permissionId: 'p1', score: 0.9, kind: null });
    store.resetForRuntime();
    const next = useRoutingStore.getState();
    expect(selectAutoReady(next)).toBe(false);
    expect(next.held).toEqual({});
    expect(next.loaded).toBe(false);
  });
});
