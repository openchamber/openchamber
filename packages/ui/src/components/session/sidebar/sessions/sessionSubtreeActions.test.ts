import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { I18nKey } from '@/lib/i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { collectSessionSubtreeIds, runSessionSubtreeAction, type SessionSubtreeStore } from './sessionSubtreeActions';

const session = (id: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: id,
  version: '1',
  directory: '/workspace',
  time: { created: 1, updated: 1 },
});

const t = (key: I18nKey) => key;

type Call = { method: keyof SessionSubtreeStore; ids: string[] };

const createStore = (failing: string[] = []) => {
  const calls: Call[] = [];
  const store: SessionSubtreeStore = {
    archiveSession: async (id) => {
      calls.push({ method: 'archiveSession', ids: [id] });
      return !failing.includes(id);
    },
    archiveSessions: async (ids) => {
      calls.push({ method: 'archiveSessions', ids });
      return {
        archivedIds: ids.filter((id) => !failing.includes(id)),
        failedIds: ids.filter((id) => failing.includes(id)),
      };
    },
    deleteSession: async (id) => {
      calls.push({ method: 'deleteSession', ids: [id] });
      return !failing.includes(id);
    },
    deleteSessions: async (ids) => {
      calls.push({ method: 'deleteSessions', ids });
      return {
        deletedIds: ids.filter((id) => !failing.includes(id)),
        failedIds: ids.filter((id) => failing.includes(id)),
      };
    },
  };
  return { calls, store };
};

describe('runSessionSubtreeAction', () => {
  test('archives a childless session through the single-session action', async () => {
    const { calls, store } = createStore();

    const outcome = await runSessionSubtreeAction('archive', session('root'), [], store, t);

    expect(calls).toEqual([{ method: 'archiveSession', ids: ['root'] }]);
    expect(outcome).toEqual({ succeededIds: ['root'], failedIds: [] });
  });

  test('reports a childless session the server refused to archive', async () => {
    const { store } = createStore(['root']);

    const outcome = await runSessionSubtreeAction('archive', session('root'), [], store, t);

    expect(outcome).toEqual({ succeededIds: [], failedIds: ['root'] });
  });

  test('archives the root together with every descendant in one batch', async () => {
    const { calls, store } = createStore();

    const outcome = await runSessionSubtreeAction('archive', session('root'), ['child', 'grandchild'], store, t);

    expect(calls).toEqual([{ method: 'archiveSessions', ids: ['root', 'child', 'grandchild'] }]);
    expect(outcome).toEqual({ succeededIds: ['root', 'child', 'grandchild'], failedIds: [] });
  });

  test('keeps the archived part of a subtree when one descendant fails', async () => {
    const { store } = createStore(['grandchild']);

    const outcome = await runSessionSubtreeAction('archive', session('root'), ['child', 'grandchild'], store, t);

    expect(outcome).toEqual({ succeededIds: ['root', 'child'], failedIds: ['grandchild'] });
  });

  test('deletes a childless session through the single-session action', async () => {
    const { calls, store } = createStore();

    const outcome = await runSessionSubtreeAction('delete', session('root'), [], store, t);

    expect(calls).toEqual([{ method: 'deleteSession', ids: ['root'] }]);
    expect(outcome).toEqual({ succeededIds: ['root'], failedIds: [] });
  });

  test('deletes the root together with every descendant in one batch', async () => {
    const { calls, store } = createStore();

    const outcome = await runSessionSubtreeAction('delete', session('root'), ['child', 'grandchild'], store, t);

    expect(calls).toEqual([{ method: 'deleteSessions', ids: ['root', 'child', 'grandchild'] }]);
    expect(outcome).toEqual({ succeededIds: ['root', 'child', 'grandchild'], failedIds: [] });
  });

  test('reports the descendant a subtree delete could not remove', async () => {
    const { store } = createStore(['grandchild']);

    const outcome = await runSessionSubtreeAction('delete', session('root'), ['child', 'grandchild'], store, t);

    expect(outcome).toEqual({ succeededIds: ['root', 'child'], failedIds: ['grandchild'] });
  });
});

describe('collectSessionSubtreeIds', () => {
  const linked = (id: string, parentID: string | null, archived?: number): Session => {
    // SAFETY: the subtree walk reads only id, parentID, and time.archived.
    return { ...session(id), parentID, time: { created: 1, updated: 1, ...(archived ? { archived } : {}) } } as Session;
  };

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

  test('reaches an active session below an archived intermediate and skips the intermediate for archive', () => {
    useGlobalSessionsStore.getState().upsertSessions([
      linked('root', null),
      linked('archived-child', 'root', 5),
      linked('leaf', 'archived-child'),
    ]);

    expect(collectSessionSubtreeIds('root', [], false)).toEqual(['leaf']);
  });

  test('includes archived descendants for delete', () => {
    useGlobalSessionsStore.getState().upsertSessions([
      linked('root', null),
      linked('archived-child', 'root', 5),
      linked('leaf', 'archived-child'),
    ]);

    expect(collectSessionSubtreeIds('root', [], true)).toEqual(['archived-child', 'leaf']);
  });

  test('keeps descendants the surface already knows that the global cache has not seen', () => {
    useGlobalSessionsStore.getState().upsertSessions([linked('root', null), linked('cached-child', 'root')]);

    expect(collectSessionSubtreeIds('root', ['live-child', 'cached-child'], false)).toEqual(['live-child', 'cached-child']);
  });
});

