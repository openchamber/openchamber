import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  isGlobalSessionRecencyOnlyUpdate,
  resolveGlobalSessionDirectory,
  mergeLiveSessionWithGlobalSession,
  useGlobalSessionsStore,
} from './useGlobalSessionsStore';

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
      entityById: new Map(),
      structure: {
        activeSessionIds: [],
        activeRootIds: [],
        activeChildrenByParentId: new Map(),
        activeIdsByDirectory: new Map(),
      },
      hasLoaded: false,
      status: 'idle',
    });
  });

  test('updates an existing session when the share URL changes', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a'));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b'));

    expect(useGlobalSessionsStore.getState().activeSessions[0]?.share?.url).toBe('https://share.example/b');
  });

  test('publishes an updated session when sharing is removed', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a'));
    const sharedSessions = useGlobalSessionsStore.getState().activeSessions;

    useGlobalSessionsStore.getState().upsertSession({
      ...buildSession('https://share.example/a'),
      share: undefined,
      time: { created: 1, updated: 3 },
    });

    const unsharedSessions = useGlobalSessionsStore.getState().activeSessions;
    expect(unsharedSessions).not.toBe(sharedSessions);
    expect(unsharedSessions[0]?.share).toBe(undefined);
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

  test('preserves the opposite session-list reference during an upsert', () => {
    const active = buildSession('https://share.example/active');
    const archived = buildSession('https://share.example/archived', {
      id: 'ses_archived',
      time: { created: 1, updated: 2, archived: 3 },
    });
    useGlobalSessionsStore.getState().applySnapshot([active], [archived]);

    const archivedSessions = useGlobalSessionsStore.getState().archivedSessions;
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/active-updated', {
      time: { created: 1, updated: 3 },
    }));
    expect(useGlobalSessionsStore.getState().archivedSessions).toBe(archivedSessions);

    const activeSessions = useGlobalSessionsStore.getState().activeSessions;
    const structure = useGlobalSessionsStore.getState().structure;
    useGlobalSessionsStore.getState().upsertSession({
      ...archived,
      time: { created: 1, updated: 4, archived: 3 },
    });
    expect(useGlobalSessionsStore.getState().activeSessions).toBe(activeSessions);
    expect(useGlobalSessionsStore.getState().structure).toBe(structure);
  });

  test('applies a batch of session upserts in one store publication', () => {
    let publications = 0;
    const unsubscribe = useGlobalSessionsStore.subscribe(() => {
      publications += 1;
    });

    useGlobalSessionsStore.getState().upsertSessions([
      buildSession('https://share.example/a'),
      buildSession('https://share.example/b', { id: 'ses_2' }),
    ]);

    unsubscribe();
    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['ses_2', 'ses_1']);
    expect(publications).toBe(1);
  });

  test('indexes a large batch of subagents in one store publication', () => {
    const parent = buildSession('https://share.example/parent', { id: 'ses_parent' });
    const children = Array.from({ length: 1_000 }, (_, index) => buildSession(
      `https://share.example/child-${index}`,
      { id: `ses_child_${index}`, parentID: parent.id },
    ));
    let publications = 0;
    const unsubscribe = useGlobalSessionsStore.subscribe(() => {
      publications += 1;
    });

    useGlobalSessionsStore.getState().upsertSessions([parent, ...children]);

    unsubscribe();
    const state = useGlobalSessionsStore.getState();
    expect(publications).toBe(1);
    expect(state.structure.activeRootIds).toEqual([parent.id]);
    expect(state.structure.activeChildrenByParentId.get(parent.id)?.length).toBe(1_000);
  });

  test('preserves hierarchy references for entity-only updates', () => {
    const parent = buildSession('https://share.example/parent', { id: 'ses_parent', directory: '/repo' });
    const child = buildSession('https://share.example/child', {
      id: 'ses_child',
      directory: '/repo',
      parentID: parent.id,
    });
    useGlobalSessionsStore.getState().upsertSessions([parent, child]);
    const previous = useGlobalSessionsStore.getState();
    const previousChildren = previous.structure.activeChildrenByParentId.get(parent.id);

    useGlobalSessionsStore.getState().upsertSession({
      ...child,
      title: 'Renamed child',
      time: { ...child.time, updated: 3 },
    });

    const next = useGlobalSessionsStore.getState();
    expect(next.structure).toBe(previous.structure);
    expect(next.structure.activeChildrenByParentId.get(parent.id)).toBe(previousChildren);
    expect(next.entityById.get(child.id)?.title).toBe('Renamed child');
  });

  test('updates only affected hierarchy buckets when a session is reparented', () => {
    const parentA = buildSession('https://share.example/a', { id: 'ses_parent_a' });
    const parentB = buildSession('https://share.example/b', { id: 'ses_parent_b' });
    const parentC = buildSession('https://share.example/c', { id: 'ses_parent_c' });
    const child = buildSession('https://share.example/child', { id: 'ses_child', parentID: parentA.id });
    const unrelatedChild = buildSession('https://share.example/other', { id: 'ses_other', parentID: parentC.id });
    useGlobalSessionsStore.getState().upsertSessions([parentA, parentB, parentC, child, unrelatedChild]);
    const previous = useGlobalSessionsStore.getState().structure;
    const unrelatedBucket = previous.activeChildrenByParentId.get(parentC.id);

    useGlobalSessionsStore.getState().upsertSession({ ...child, parentID: parentB.id });

    const next = useGlobalSessionsStore.getState().structure;
    expect(next).not.toBe(previous);
    expect(next.activeChildrenByParentId.get(parentA.id)).toBe(undefined);
    expect([...next.activeChildrenByParentId.get(parentB.id) ?? []]).toEqual([child.id]);
    expect(next.activeChildrenByParentId.get(parentC.id)).toBe(unrelatedBucket);
  });

  test('applies ordered mixed mutations in one publication', () => {
    const original = buildSession('https://share.example/original', { id: 'ses_original' });
    useGlobalSessionsStore.getState().upsertSession(original);
    let publications = 0;
    const unsubscribe = useGlobalSessionsStore.subscribe(() => {
      publications += 1;
    });

    useGlobalSessionsStore.getState().applySessionMutations([
      { type: 'upsert', session: buildSession('https://share.example/temporary', { id: 'ses_temporary' }) },
      { type: 'remove', sessionId: original.id },
      { type: 'remove', sessionId: 'ses_temporary' },
      { type: 'upsert', session: buildSession('https://share.example/final', { id: 'ses_final' }) },
    ]);

    unsubscribe();
    const state = useGlobalSessionsStore.getState();
    expect(publications).toBe(1);
    expect(state.activeSessions.map((session) => session.id)).toEqual(['ses_final']);
    expect(state.structure.activeRootIds).toEqual(['ses_final']);
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

describe('isGlobalSessionRecencyOnlyUpdate', () => {
  test('accepts an updated timestamp while preserving omitted directory metadata', () => {
    const existing = buildSession('https://share.example/s', {
      directory: '/repo/app',
      time: { created: 1, updated: 2 },
    });
    const incoming = buildSession('https://share.example/s', {
      time: { created: 1, updated: 3 },
    });

    expect(isGlobalSessionRecencyOnlyUpdate(existing, incoming)).toBe(true);
  });

  test('rejects title and archive changes as structural updates', () => {
    const existing = buildSession('https://share.example/s', { time: { created: 1, updated: 2 } });
    const renamed = buildSession('https://share.example/s', {
      title: 'Renamed',
      time: { created: 1, updated: 3 },
    });
    const archived = buildSession('https://share.example/s', {
      time: { created: 1, updated: 3, archived: 4 },
    });

    expect(isGlobalSessionRecencyOnlyUpdate(existing, renamed)).toBe(false);
    expect(isGlobalSessionRecencyOnlyUpdate(existing, archived)).toBe(false);
  });

  test('rejects parent and slug changes as structural updates', () => {
    const existing = buildSession('https://share.example/s', {
      parentID: 'parent-a',
      slug: 'slug-a',
      time: { created: 1, updated: 2 },
    });
    const reparented = buildSession('https://share.example/s', {
      parentID: 'parent-b',
      slug: 'slug-a',
      time: { created: 1, updated: 3 },
    });
    const reslugged = buildSession('https://share.example/s', {
      parentID: 'parent-a',
      slug: 'slug-b',
      time: { created: 1, updated: 3 },
    });

    expect(isGlobalSessionRecencyOnlyUpdate(existing, reparented)).toBe(false);
    expect(isGlobalSessionRecencyOnlyUpdate(existing, reslugged)).toBe(false);
  });
});
