import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { resetSessionOrdering } from '@/sync/session-ordering';
import { readOrderedActiveSessions, stepSession } from './sessionListOrder';

// SAFETY: the fixture supplies every session field read by ordering and filtering.
const session = (id: string, updated: number, extras: Partial<Session> = {}): Session => ({
  id,
  directory: `/projects/${id}`,
  time: { created: updated - 1, updated },
  ...extras,
} as Session);

beforeEach(() => {
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  useSessionPinnedStore.setState({ ids: new Set() });
  resetSessionOrdering();
});

describe('session list stepping', () => {
  test('steps in both directions and wraps at both ends', () => {
    const sessions = [session('first', 30), session('middle', 20), session('last', 10)];
    expect(stepSession(sessions, 'first', 1)?.id).toBe('middle');
    expect(stepSession(sessions, 'middle', -1)?.id).toBe('first');
    expect(stepSession(sessions, 'last', 1)?.id).toBe('first');
    expect(stepSession(sessions, 'first', -1)?.id).toBe('last');
  });

  test('starts at the appropriate end if the selected session is absent', () => {
    const sessions = [session('first', 20), session('last', 10)];
    expect(stepSession(sessions, 'other', 1)?.id).toBe('first');
    expect(stepSession(sessions, 'other', -1)?.id).toBe('last');
  });

  test('does nothing when there are no sessions', () => {
    expect(stepSession([], 'other', 1)).toBeUndefined();
    expect(stepSession([], null, -1)).toBeUndefined();
  });

  test('reads globally visible sessions, excluding btw forks and subagents', () => {
    const visible = session('visible', 30);
    const elsewhere = session('elsewhere', 20);
    const btw = session('btw', 40, {
      metadata: { openchamber: { kind: 'btw', originalSessionID: 'visible' } },
    });
    const subagent = session('child', 50, { parentID: 'visible' });
    useGlobalSessionsStore.getState().applySnapshot([visible, elsewhere, btw, subagent], []);

    expect(readOrderedActiveSessions().map(({ id }) => id)).toEqual(['visible', 'elsewhere']);
  });
});
