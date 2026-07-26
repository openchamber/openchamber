import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  compareSessionsByLifecycleOrder,
  observeSessionActivityEvent,
  orderSessionsByLifecycleScopes,
  reconcileSessionActivitySnapshot,
  removeSessionOrdering,
  resetSessionOrdering,
  useSessionOrderingStore,
} from './session-ordering';

const session = (
  id: string,
  updated: number,
  parentID?: string,
): Session => ({
  id,
  parentID,
  time: { created: updated - 1, updated },
} as Session);

beforeEach(() => resetSessionOrdering());

describe('session lifecycle ordering', () => {
  test('promotes only meaningful event transitions', () => {
    observeSessionActivityEvent('session-a', 'settled');
    expect(useSessionOrderingStore.getState().rankById.has('session-a')).toBe(false);

    observeSessionActivityEvent('session-a', 'active');
    const activeRank = useSessionOrderingStore.getState().rankById.get('session-a');
    expect(typeof activeRank).toBe('number');

    observeSessionActivityEvent('session-a', 'active');
    expect(useSessionOrderingStore.getState().rankById.get('session-a')).toBe(activeRank);

    observeSessionActivityEvent('session-a', 'settled');
    expect(useSessionOrderingStore.getState().rankById.get('session-a')).toBeGreaterThan(activeRank ?? 0);
  });

  test('treats an active event without a snapshot baseline as a real transition', () => {
    observeSessionActivityEvent('session-a', 'active');

    expect(useSessionOrderingStore.getState().rankById.has('session-a')).toBe(true);
  });

  test('seeds the first authoritative snapshot without synthetic promotions', () => {
    reconcileSessionActivitySnapshot(['session-a'], ['session-a', 'session-b']);
    expect(useSessionOrderingStore.getState().rankById.size).toBe(0);

    reconcileSessionActivitySnapshot([], ['session-a', 'session-b']);
    expect(useSessionOrderingStore.getState().rankById.has('session-a')).toBe(true);
    expect(useSessionOrderingStore.getState().rankById.has('session-b')).toBe(false);
  });

  test('uses lifecycle rank only within the same parent scope', () => {
    const rootOlder = session('root-older', 10);
    const rootNewer = session('root-newer', 20);
    const childOlder = session('child-older', 10, 'root-older');
    const childNewer = session('child-newer', 20, 'root-older');
    const otherParentChild = session('other-parent-child', 20, 'root-newer');
    const rankById = new Map([
      ['child-older', 100],
      ['root-older', 90],
    ]);

    expect(compareSessionsByLifecycleOrder(rootOlder, rootNewer, new Set(), rankById)).toBeLessThan(0);
    expect(compareSessionsByLifecycleOrder(childOlder, childNewer, new Set(), rankById)).toBeLessThan(0);
    expect(compareSessionsByLifecycleOrder(childOlder, otherParentChild, new Set(), rankById)).toBeGreaterThan(0);
    expect(compareSessionsByLifecycleOrder(childOlder, rootNewer, new Set(), rankById)).toBeGreaterThan(0);
  });

  test('freezes timestamp fallback until a lifecycle transition', () => {
    const older = session('older', 10);
    const newer = session('newer', 20);
    expect(compareSessionsByLifecycleOrder(older, newer, new Set(), new Map())).toBeGreaterThan(0);

    const metadataOnlyUpdate = session('older', 30);
    expect(compareSessionsByLifecycleOrder(metadataOnlyUpdate, newer, new Set(), new Map())).toBeGreaterThan(0);

    expect(compareSessionsByLifecycleOrder(
      metadataOnlyUpdate,
      newer,
      new Set(),
      new Map([['older', 40]]),
    )).toBeLessThan(0);
  });

  test('clears lifecycle state when a session is deleted', () => {
    observeSessionActivityEvent('session-a', 'active');
    removeSessionOrdering('session-a');
    expect(useSessionOrderingStore.getState().rankById.has('session-a')).toBe(false);

    observeSessionActivityEvent('session-a', 'settled');
    expect(useSessionOrderingStore.getState().rankById.has('session-a')).toBe(false);
  });

  test('sorts each forest scope before flattening parent-first', () => {
    const rootOlder = session('root-older', 10);
    const rootNewer = session('root-newer', 20);
    const childOlder = session('child-older', 5, 'root-older');
    const childNewer = session('child-newer', 6, 'root-older');

    const ordered = orderSessionsByLifecycleScopes(
      [rootNewer, childOlder, rootOlder, childNewer],
      new Set(),
      new Map([
        ['root-older', 100],
        ['child-older', 90],
      ]),
    );

    expect(ordered.map((item) => item.id)).toEqual([
      'root-older',
      'child-older',
      'child-newer',
      'root-newer',
    ]);
  });

  test('does not promote a root when only its child has lifecycle activity', () => {
    const rootOlder = session('root-older', 10);
    const rootNewer = session('root-newer', 20);
    const activeChild = session('active-child', 5, 'root-older');

    const ordered = orderSessionsByLifecycleScopes(
      [rootOlder, activeChild, rootNewer],
      new Set(),
      new Map([['active-child', 100]]),
    );

    expect(ordered.map((item) => item.id)).toEqual([
      'root-newer',
      'root-older',
      'active-child',
    ]);
  });
});
