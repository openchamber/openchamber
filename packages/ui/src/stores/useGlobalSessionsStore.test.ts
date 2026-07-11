import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { resolveGlobalSessionDirectory, mergeLiveSessionWithGlobalSession, useGlobalSessionsStore } from './useGlobalSessionsStore';

type SessionExtra = Partial<Session> & {
  directory?: string | null;
  project?: { worktree?: string | null } | null;
};

const buildSession = (shareUrl: string, extra: SessionExtra = {}): Session => ({
  id: 'ses_1',
  title: 'Shared session',
  time: { created: 1, updated: 2 },
  share: { url: shareUrl },
  ...extra,
} as Session);

describe('useGlobalSessionsStore', () => {
  beforeEach(() => {
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      loadedDirectories: new Set(),
      loadingDirectories: new Set(),
      hasLoaded: false,
      status: 'idle',
    });
  });

  test('updates an existing session when the share URL changes', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a'));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b'));

    expect(useGlobalSessionsStore.getState().activeSessions[0]?.share?.url).toBe('https://share.example/b');
  });

  test('preserves directory metadata when a live update omits it', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      time: { created: 1, updated: 3 },
    }));

    const session = useGlobalSessionsStore.getState().activeSessions[0];
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/app');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.[0]?.id).toBe('ses_1');
  });

  test('preserves raw directory metadata when a live update only has project worktree', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      project: { worktree: '/repo/app' },
      time: { created: 1, updated: 3 },
    }));

    const session = useGlobalSessionsStore.getState().activeSessions[0] as Session & { directory?: string | null };
    expect(session.directory).toBe('/repo/app');
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/app');
  });

  test('trusts explicit incoming raw directory metadata', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      directory: '/repo/app-worktree',
      time: { created: 1, updated: 3 },
    }));

    expect(resolveGlobalSessionDirectory(useGlobalSessionsStore.getState().activeSessions[0])).toBe('/repo/app-worktree');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')).toBe(undefined);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app-worktree')?.[0]?.id).toBe('ses_1');
  });

  test('preserves directory metadata when moving a session to archived', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      time: { created: 1, updated: 3, archived: 4 },
    }));

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(resolveGlobalSessionDirectory(useGlobalSessionsStore.getState().archivedSessions[0])).toBe('/repo/app');
  });
});

describe('mergeLiveSessionWithGlobalSession', () => {
  test('preserves global share over live share', () => {
    const live = buildSession('https://live.example/s', { time: { created: 1, updated: 5 } });
    const global = buildSession('https://global.example/s', { time: { created: 1, updated: 3 } });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(merged.share?.url).toBe('https://global.example/s');
    expect(merged.time?.updated).toBe(5);
  });

  test('preserves directory from global when live omits it', () => {
    const live = buildSession('https://live.example/s', { time: { created: 1, updated: 5 } });
    const global = buildSession('https://global.example/s', { directory: '/repo/app' });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(resolveGlobalSessionDirectory(merged)).toBe('/repo/app');
  });

  test('live directory takes precedence over global when present', () => {
    const live = buildSession('https://live.example/s', { directory: '/repo/worktree' });
    const global = buildSession('https://global.example/s', { directory: '/repo/app' });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(resolveGlobalSessionDirectory(merged)).toBe('/repo/worktree');
  });
});
