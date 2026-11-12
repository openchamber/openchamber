import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionWarmingStore } from '@/stores/useSessionWarmingStore';
import { resetSessionOrdering } from '@/sync/session-ordering';
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context';
import { installHookTestDom } from '../test-utils/testDom';
import { useSessionProjectCollection } from './sessionCollection';

const CURRENT_DIRECTORY = '/workspace';
const DIRECTORY = '/project';
const KNOWN_DIRECTORIES = new Set([DIRECTORY]);
const ARCHIVED_ID = 'ses_archived';
const ACTIVE_ID = 'ses_active';
const UNKNOWN_ID = 'ses_unknown';

const createSdk = () => OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: CURRENT_DIRECTORY, project: { id: 'project', directory: CURRENT_DIRECTORY, canonical: CURRENT_DIRECTORY } }
      : path.endsWith('/session/active') ? {}
        : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

const session = (id: string, updated: number, archived = false, directory = DIRECTORY): Session => ({
  id,
  projectID: 'project',
  directory,
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: archived ? { created: 1, updated, archived: updated } : { created: 1, updated },
  model: { providerID: 'anthropic', id: 'claude', variant: 'high' },
  agent: 'build',
});

type Collection = ReturnType<typeof useSessionProjectCollection>;

let directoryStore: ReturnType<typeof useDirectoryStore> | null = null;
let collection: Collection | null = null;

const Probe = () => {
  directoryStore = useDirectoryStore(DIRECTORY, { bootstrap: false });
  collection = useSessionProjectCollection({ knownDirectories: KNOWN_DIRECTORIES, isVSCode: false, isVisible: false });
  return null;
};

const collectionIds = (key: 'sessions' | 'rootSessions' | 'orderedSessions'): string[] => (
  collection?.[key].map((entry) => entry.id) ?? []
);

describe('useSessionProjectCollection archive coverage', () => {
  let dom: ReturnType<typeof installHookTestDom>;
  let root: Root;
  let restoreSpies: Array<() => void>;
  let restoreWarmingRefresh: () => void;
  let initialGlobalState: ReturnType<typeof useGlobalSessionsStore.getState>;
  let previousSurface: typeof window.__OPENCHAMBER_SURFACE__;

  const render = async () => {
    await act(async () => root.render(
      <SyncProvider sdk={createSdk()} directory="">
        <Probe />
      </SyncProvider>,
    ));
  };

  const seedDirectory = async (sessions: Session[]) => {
    await act(async () => directoryStore!.setState({ session: sessions }));
  };

  const seedGlobal = async (activeSessions: Session[], archivedSessions: Session[]) => {
    await act(async () => useGlobalSessionsStore.getState().applySnapshot(activeSessions, archivedSessions));
  };

  beforeEach(() => {
    dom = installHookTestDom();
    previousSurface = window.__OPENCHAMBER_SURFACE__;
    window.__OPENCHAMBER_SURFACE__ = 'desktop';
    initialGlobalState = useGlobalSessionsStore.getState();
    resetSessionOrdering();
    const spies = [
      spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' }),
      spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home'),
      spyOn(opencodeClient, 'getLocation').mockResolvedValue({
        directory: CURRENT_DIRECTORY,
        project: { id: 'project', directory: CURRENT_DIRECTORY, canonical: CURRENT_DIRECTORY },
      }),
      spyOn(opencodeClient, 'getConfig').mockResolvedValue({}),
      spyOn(opencodeClient, 'listProjects').mockResolvedValue([]),
    ];
    restoreSpies = spies.map((spy) => () => spy.mockRestore());
    const warmingRefresh = spyOn(useSessionWarmingStore.getState(), 'refresh').mockResolvedValue();
    restoreWarmingRefresh = () => warmingRefresh.mockRestore();
    root = createRoot(dom.container);
    directoryStore = null;
    collection = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useGlobalSessionsStore.setState(initialGlobalState, true);
    resetSessionOrdering();
    restoreSpies.forEach((restore) => restore());
    restoreWarmingRefresh();
    window.__OPENCHAMBER_SURFACE__ = previousSurface;
    dom.restore();
  });

  test('omits an archived global session when a directory store retains its active copy', async () => {
    await render();
    await seedGlobal([session(ACTIVE_ID, 20)], [session(ARCHIVED_ID, 30, true)]);
    await seedDirectory([session(ARCHIVED_ID, 30), session(UNKNOWN_ID, 40)]);

    for (const key of ['sessions', 'rootSessions', 'orderedSessions'] as const) {
      expect(collectionIds(key)).not.toContain(ARCHIVED_ID);
      expect(collectionIds(key)).toContain(ACTIVE_ID);
      expect(collectionIds(key)).toContain(UNKNOWN_ID);
      expect(collectionIds(key)).toHaveLength(2);
    }
  });

  test('uses raw archive membership when the archived display excludes a deleted worktree', async () => {
    await render();
    await seedGlobal(
      [session(ACTIVE_ID, 20)],
      [session(ARCHIVED_ID, 30, true, '/fixture/deleted-worktree')],
    );
    await seedDirectory([session(ARCHIVED_ID, 30), session(UNKNOWN_ID, 40)]);

    expect(useGlobalSessionsStore.getState().archivedSessions.map((entry) => entry.id)).toContain(ARCHIVED_ID);
    expect(collection?.archivedSessions).toEqual([]);
    for (const key of ['sessions', 'rootSessions', 'orderedSessions'] as const) {
      expect(collectionIds(key)).not.toContain(ARCHIVED_ID);
      expect(collectionIds(key)).toContain(UNKNOWN_ID);
    }
  });

  test('updates the live gap when archive membership arrives and restores one authoritative row', async () => {
    await render();
    await seedGlobal([session(ACTIVE_ID, 20)], []);
    await seedDirectory([session(ARCHIVED_ID, 30), session(UNKNOWN_ID, 40)]);
    expect(collectionIds('sessions')).toContain(ARCHIVED_ID);

    await seedGlobal([session(ACTIVE_ID, 20)], [session(ARCHIVED_ID, 30, true)]);
    expect(collectionIds('sessions')).not.toContain(ARCHIVED_ID);

    await seedGlobal([session(ACTIVE_ID, 20), session(ARCHIVED_ID, 50)], []);
    expect(collectionIds('sessions').filter((id) => id === ARCHIVED_ID)).toHaveLength(1);
  });

  test('keeps the collection stable for time-only updates to a globally covered directory record', async () => {
    await render();
    await seedGlobal([session(ACTIVE_ID, 20)], []);
    await seedDirectory([session(ACTIVE_ID, 20), session(UNKNOWN_ID, 40)]);
    const sessions = collection?.sessions;
    const rootSessions = collection?.rootSessions;
    const orderedSessions = collection?.orderedSessions;

    await seedDirectory([session(ACTIVE_ID, 21), session(UNKNOWN_ID, 40)]);

    expect(collection?.sessions).toBe(sessions);
    expect(collection?.rootSessions).toBe(rootSessions);
    expect(collection?.orderedSessions).toBe(orderedSessions);
  });
});
