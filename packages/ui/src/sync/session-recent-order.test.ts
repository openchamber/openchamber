import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useSessionOrderingStore } from '@/sync/session-ordering';

import { getRecentParentSessions } from './session-recent-order';

const makeSession = (
  id: string,
  overrides: Partial<Session> & { parentID?: string | null } = {},
): Session => {
  const { parentID, ...rest } = overrides;
  return {
    id,
    time: { created: 1_000, updated: 1_000, ...(rest.time ?? {}) },
    ...rest,
    ...(parentID !== undefined ? { parentID } : {}),
  } as Session;
};

const setActiveSessions = (sessions: Session[]) => {
  useGlobalSessionsStore.setState({ activeSessions: sessions });
};

describe('getRecentParentSessions', () => {
  beforeEach(() => {
    useGlobalSessionsStore.setState({ activeSessions: [] });
    useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
    useSessionOrderingStore.setState({ rankById: new Map() });
  });

  test('returns an empty list when there are no sessions', () => {
    expect(getRecentParentSessions()).toEqual([]);
  });

  test('orders most-recent-first using the lifecycle rank authority', () => {
    setActiveSessions([
      makeSession('old', { time: { created: 1, updated: 1 } }),
      makeSession('mid', { time: { created: 2, updated: 2 } }),
      makeSession('new', { time: { created: 3, updated: 3 } }),
    ]);
    // Ranks are the authority and outrank raw time.updated.
    useSessionOrderingStore.setState({
      rankById: new Map([
        ['old', 30],
        ['mid', 20],
        ['new', 10],
      ]),
    });

    expect(getRecentParentSessions().map((session) => session.id)).toEqual(['old', 'mid', 'new']);
  });

  test('falls back to time when no ranks are present', () => {
    setActiveSessions([
      makeSession('a', { time: { created: 1, updated: 5 } }),
      makeSession('b', { time: { created: 1, updated: 9 } }),
      makeSession('c', { time: { created: 1, updated: 7 } }),
    ]);

    expect(getRecentParentSessions().map((session) => session.id)).toEqual(['b', 'c', 'a']);
  });

  test('excludes archived sessions and child sessions', () => {
    setActiveSessions([
      makeSession('parent', { time: { created: 1, updated: 3 } }),
      makeSession('child', { parentID: 'parent', time: { created: 1, updated: 9 } }),
      makeSession('archived', { time: { created: 1, updated: 9, archived: 9 } as Session['time'] }),
    ]);

    expect(getRecentParentSessions().map((session) => session.id)).toEqual(['parent']);
  });
});
