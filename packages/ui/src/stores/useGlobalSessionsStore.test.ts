import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { useGlobalSessionsStore } from './useGlobalSessionsStore';

const buildSession = (shareUrl: string): Session => ({
  id: 'ses_1',
  title: 'Shared session',
  time: { created: 1, updated: 2 },
  share: { url: shareUrl },
} as Session);

const buildTitledSession = (title: string, updated: number, archived?: number): Session => ({
  id: 'ses_1',
  title,
  time: { created: 1, updated, archived },
} as Session);

describe('useGlobalSessionsStore', () => {
  beforeEach(() => {
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      hasLoaded: false,
      status: 'idle',
    });
  });

  test('updates an existing session when the share URL changes', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a'));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b'));

    expect(useGlobalSessionsStore.getState().activeSessions[0]?.share?.url).toBe('https://share.example/b');
  });

  test('preserves a resolved title when passive upsert carries a default title', () => {
    useGlobalSessionsStore.getState().upsertSession(buildTitledSession('Investigate startup failure', 2));
    useGlobalSessionsStore.getState().upsertSession(buildTitledSession('New session - 2026-06-02', 3));

    const session = useGlobalSessionsStore.getState().activeSessions[0];
    expect(session?.title).toBe('Investigate startup failure');
    expect(session?.time.updated).toBe(3);
  });

  test('preserves a resolved title when an archived upsert carries a default title', () => {
    useGlobalSessionsStore.getState().upsertSession(buildTitledSession('Investigate startup failure', 2));
    useGlobalSessionsStore.getState().upsertSession(buildTitledSession('New session - 2026-06-02', 3, 4));

    expect(useGlobalSessionsStore.getState().activeSessions).toHaveLength(0);
    const session = useGlobalSessionsStore.getState().archivedSessions[0];
    expect(session?.title).toBe('Investigate startup failure');
    expect(session?.time.updated).toBe(3);
    expect(session?.time.archived).toBe(4);
  });

  test('preserves a resolved title when snapshot moves a session to archived with a default title', () => {
    useGlobalSessionsStore.getState().upsertSession(buildTitledSession('Investigate startup failure', 2));

    useGlobalSessionsStore.getState().applySnapshot(
      [],
      [buildTitledSession('New session - 2026-06-02', 3, 4)],
    );

    expect(useGlobalSessionsStore.getState().activeSessions).toHaveLength(0);
    const session = useGlobalSessionsStore.getState().archivedSessions[0];
    expect(session?.title).toBe('Investigate startup failure');
    expect(session?.time.updated).toBe(3);
    expect(session?.time.archived).toBe(4);
  });

});
