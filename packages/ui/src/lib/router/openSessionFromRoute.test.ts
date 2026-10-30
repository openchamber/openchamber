import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';

import { useBtwStore } from '@/stores/useBtwStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getRememberedSessionDirectory, useSessionUIStore } from '@/sync/session-ui-store';
import { openSessionFromToast } from '@/sync/session-navigation';

import { openSession, openSessionFromRoute, openSessionLink } from './openSessionFromRoute';

const SESSION_ID = 'ses_linear_open';
const PROJECT_DIR = '/projects/linear-from-url';
const OTHER_DIR = '/projects/linear-from-url-other';
const WORKTREE_DIR = '/projects/linear-from-url-worktrees/feature';

const BTW_PARENT_ID = 'ses_btw_parent';
const BTW_FORK_ID = 'ses_btw_fork';

const buildSession = (id: string, directory: string): Session => ({
  id,
  projectID: 'project',
  directory,
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
});

const buildBtwFork = (parentId: string, directory: string): Session => ({
  ...buildSession(BTW_FORK_ID, directory),
  parentID: parentId,
  metadata: { openchamber: { kind: 'btw', originalSessionID: parentId } },
});

const useSessions = (sessions: Session[]): void => {
  useGlobalSessionsStore.setState({
    activeSessions: sessions,
    archivedSessions: [],
    entityById: new Map(sessions.map((session) => [session.id, session])),
    hasLoaded: true,
    status: 'ready',
  });
};

describe('openSessionFromRoute', () => {
  beforeEach(() => {
    useProjectsStore.setState({ projects: [PROJECT_DIR, OTHER_DIR, WORKTREE_DIR].map((path) => ({ id: path, path })) });
    useSessionUIStore.getState().setCurrentSession(null);
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      entityById: new Map(),
      sessionsByDirectory: new Map(),
      hasLoaded: true,
      status: 'ready',
    });
    useBtwStore.setState({ byParent: {} });
  });

  test('selects the routed session once the global list knows its directory', async () => {
    useGlobalSessionsStore.setState({
      activeSessions: [buildSession(SESSION_ID, PROJECT_DIR)],
      archivedSessions: [],
      hasLoaded: true,
      status: 'ready',
    });

    await openSessionFromRoute(SESSION_ID);

    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
  });

  // Scheduled tasks' "Open session" opens a run's session by id while the
  // project root is active; a session in a linked worktree must open there.
  test('opens a worktree session in its worktree while the project root is active', async () => {
    const rootId = 'ses_linear_root';
    const worktreeId = 'ses_linear_worktree';
    useGlobalSessionsStore.setState({
      activeSessions: [buildSession(rootId, PROJECT_DIR), buildSession(worktreeId, WORKTREE_DIR)],
      archivedSessions: [],
      hasLoaded: true,
      status: 'ready',
    });
    useSessionUIStore.getState().setCurrentSession(rootId, PROJECT_DIR);

    await openSessionFromRoute(worktreeId);

    expect(useSessionUIStore.getState().currentSessionId).toBe(worktreeId);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(WORKTREE_DIR);
    expect(getRememberedSessionDirectory(worktreeId).runtime).toBe(WORKTREE_DIR);
  });

  test('replaces a guessed directory once the global list knows the owner', async () => {
    const id = 'ses_linear_guessed';
    useSessionUIStore.getState().setCurrentSession(id);
    const guessed = useSessionUIStore.getState().currentSessionDirectory;

    useGlobalSessionsStore.setState({
      activeSessions: [buildSession(id, OTHER_DIR)],
      archivedSessions: [],
      hasLoaded: true,
      status: 'ready',
    });

    await openSessionFromRoute(id);

    expect(useSessionUIStore.getState().currentSessionId).toBe(id);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(OTHER_DIR);
    expect(guessed).not.toBe(OTHER_DIR);
  });

  // A /btw fork is a side transcript inside its parent's panel: opening it by
  // id (a completion notification, a push, a toast) must land on the parent.
  test('opens a /btw fork as its parent and expands the parent panel', async () => {
    useSessions([
      buildSession(BTW_PARENT_ID, PROJECT_DIR),
      buildBtwFork(BTW_PARENT_ID, PROJECT_DIR),
    ]);
    useBtwStore.getState().setPanelState(BTW_PARENT_ID, { collapsed: true });
    useSessionUIStore.getState().setCurrentSession(SESSION_ID, OTHER_DIR);

    await openSessionFromRoute(BTW_FORK_ID);

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_PARENT_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
    expect(useBtwStore.getState().byParent[BTW_PARENT_ID]?.collapsed).toBe(false);
  });

  // A cold launch from a notification may not have the fork record yet: the
  // first selection guesses, and the global list then resolves the parent.
  test('resolves a fork once the global list arrives', async () => {
    useGlobalSessionsStore.setState({
      activeSessions: [
        buildSession(BTW_PARENT_ID, PROJECT_DIR),
        buildBtwFork(BTW_PARENT_ID, PROJECT_DIR),
      ],
      archivedSessions: [],
      entityById: new Map(),
      hasLoaded: false,
      status: 'ready',
    });

    await openSessionFromRoute(BTW_FORK_ID);

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_PARENT_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
    expect(useBtwStore.getState().byParent[BTW_PARENT_ID]?.collapsed).toBe(false);
  });

  test('opens a fork as itself when its parent is gone', async () => {
    useSessions([buildBtwFork(BTW_PARENT_ID, PROJECT_DIR)]);

    await openSessionFromRoute(BTW_FORK_ID);

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_FORK_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
  });

  // The toast's "Open session" reaches this module through the opener it
  // registers, so moving that registration out of the session store must keep
  // the toast path working.
  test('opens a toast target through the opener this module registers', async () => {
    useSessions([
      buildSession(BTW_PARENT_ID, PROJECT_DIR),
      buildBtwFork(BTW_PARENT_ID, PROJECT_DIR),
    ]);

    openSessionFromToast(BTW_FORK_ID, PROJECT_DIR);

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_PARENT_ID);
    expect(useBtwStore.getState().byParent[BTW_PARENT_ID]?.collapsed).toBe(false);
  });

  // A message link names one message inside the transcript that holds it. For
  // a `/btw` answer that transcript is the fork, so the fork opens alone.
  test('keeps a /btw fork when a message link names it', async () => {
    useSessions([
      buildSession(BTW_PARENT_ID, PROJECT_DIR),
      buildBtwFork(BTW_PARENT_ID, PROJECT_DIR),
    ]);

    await openSessionLink(BTW_FORK_ID, 'msg_btw_answer');

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_FORK_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
    expect(useBtwStore.getState().byParent[BTW_PARENT_ID]).toBeUndefined();
  });

  // A desktop notification carries the directory of the session it names, so
  // the parent is selected immediately instead of after the global list loads.
  test('opens a notification target as the parent without waiting for the list', async () => {
    useSessions([
      buildSession(BTW_PARENT_ID, PROJECT_DIR),
      buildBtwFork(BTW_PARENT_ID, PROJECT_DIR),
    ]);

    const opening = openSession(BTW_FORK_ID, { directory: PROJECT_DIR });

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_PARENT_ID);
    await opening;
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
  });
});
