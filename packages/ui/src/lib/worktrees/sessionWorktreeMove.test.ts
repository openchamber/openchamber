import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session, SessionStatus } from '@opencode-ai/sdk/v2';
import type { State } from '@/sync/types';
import type { WorktreeMetadata } from '@/types/worktree';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';

const moveCalls: Array<{
  sessionId: string;
  sourceDirectory: string;
  destinationDirectory: string;
  moveChanges: boolean;
}> = [];
const refreshCalls: string[][] = [];
type RemoveProjectWorktreeCall = {
  projectDirectory: string;
  directory: string;
  deleteLocalBranch: boolean;
};
type MoveSessionImplementation = (
  session: Session,
  sourceDirectory: string,
  destinationDirectory: string,
  moveChanges: boolean,
) => Promise<void>;
type RefreshImplementation = (directories: string[]) => Promise<void>;
type CreateQuickWorktreeOptions = { preferredName?: string; startRef?: string };
type CreateQuickWorktreeImplementation = (
  project: ProjectRef,
  options: CreateQuickWorktreeOptions,
) => Promise<WorktreeMetadata>;
type ResolveProjectRefImplementation = (directory: string) => ProjectRef | null;
type WaitForWorktreeGitReadyImplementation = (directory: string) => Promise<void>;
type DirectoryState = Pick<State, 'session_status'>;
type DeferredVoid = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};
type IncompleteRollbackCause = {
  moveError: Error;
  rollbackFailures: Array<{ sessionId: string; error: Error }>;
};

const removeWorktreeCalls: RemoveProjectWorktreeCall[] = [];
const metadataWrites: Array<{ sessionId: string; metadata: WorktreeMetadata | null }> = [];
const toastSuccesses: string[] = [];
const toastErrors: Array<{ title: string; description?: string }> = [];
const directoryStates = new Map<string, DirectoryState>();
const storedMetadata = new Map<string, WorktreeMetadata | null>();
const originalConsoleWarn = console.warn;
type SessionUIState = {
  availableWorktrees: WorktreeMetadata[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  worktreeMetadata: Map<string, WorktreeMetadata | null>;
  getWorktreeMetadata: (sessionId: string) => WorktreeMetadata | null;
  setWorktreeMetadata: (sessionId: string, metadata: WorktreeMetadata | null) => void;
};

type SessionUIStatePatch = Partial<SessionUIState> | ((state: SessionUIState) => Partial<SessionUIState>);

const sessionUIState: SessionUIState = {
  availableWorktrees: [],
  availableWorktreesByProject: new Map<string, WorktreeMetadata[]>(),
  worktreeMetadata: new Map<string, WorktreeMetadata | null>(),
  getWorktreeMetadata: (sessionId: string) => storedMetadata.get(sessionId) ?? null,
  setWorktreeMetadata: (sessionId: string, metadata: WorktreeMetadata | null) => {
    storedMetadata.set(sessionId, metadata);
    metadataWrites.push({ sessionId, metadata });
  },
};

let moveSessionImplementation: MoveSessionImplementation = async () => {};
let refreshImplementation: RefreshImplementation = async () => {};
let latestMetadataResult: WorktreeMetadata;
let createQuickWorktreeImplementation: CreateQuickWorktreeImplementation = async () => ({
  path: '/created-worktree',
  projectDirectory: '/repo',
  branch: 'feature',
  label: 'Created worktree',
  worktreeStatus: 'ready',
  worktreeSource: 'created-for-session',
});
let resolveProjectRefImplementation: ResolveProjectRefImplementation = () => ({ id: 'project-1', path: '/repo' });
let waitForWorktreeGitReadyImplementation: WaitForWorktreeGitReadyImplementation = async () => {};

mock.module('@/components/ui', () => ({
  toast: {
    success: (message: string) => {
      toastSuccesses.push(message);
    },
    error: (title: string, options?: { description?: string }) => {
      toastErrors.push({ title, description: options?.description });
    },
  },
}));

mock.module('@/lib/gitApi', () => ({
  getGitStatus: mock(() => Promise.resolve({ current: 'feature' })),
  deleteRemoteBranch: mock(),
  git: {
    worktree: {
      list: mock(() => Promise.resolve([])),
      create: mock(() => Promise.resolve(null)),
      validate: mock(() => Promise.resolve({ ok: true, errors: [] })),
      remove: mock((projectDirectory: string, options: { directory: string; deleteLocalBranch?: boolean }) => {
        removeWorktreeCalls.push({
          projectDirectory,
          directory: options.directory,
          deleteLocalBranch: options.deleteLocalBranch === true,
        });
        return Promise.resolve({ success: true });
      }),
    },
  },
}));

mock.module('@/lib/openchamberConfig', () => ({
  substituteCommandVariables: (command: string) => command,
}));

mock.module('@/lib/worktreeSessionCreator', () => ({
  createQuickWorktree: mock((project: ProjectRef, options: CreateQuickWorktreeOptions) => createQuickWorktreeImplementation(project, options)),
  resolveProjectRef: mock((directory: string) => resolveProjectRefImplementation(directory)),
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  waitForWorktreeGitReady: mock((directory: string) => waitForWorktreeGitReadyImplementation(directory)),
  clearWorktreeBootstrapState: mock(),
  markWorktreeBootstrapPending: mock(),
  setWorktreeBootstrapState: mock(),
  startWorktreeBootstrapWatcher: mock(),
}));

mock.module('@/lib/worktrees/worktreeStatus', () => ({
  invalidateResolvedProjectRootCache: mock(),
  resolveProjectRoot: (directory: string) => Promise.resolve(directory),
}));

mock.module('@/stores/useGlobalSessionsStore', () => ({
  resolveGlobalSessionDirectory: (session: Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  }) => session.directory ?? session.project?.worktree ?? null,
  refreshGlobalSessionsForDirectories: (directories: string[]) => {
    refreshCalls.push(directories);
    return refreshImplementation(directories);
  },
}));

mock.module('@/sync/session-actions', () => ({
  moveSessionToDirectory: (session: Session, sourceDirectory: string, destinationDirectory: string, moveChanges = true) => {
    moveCalls.push({ sessionId: session.id, sourceDirectory, destinationDirectory, moveChanges });
    return moveSessionImplementation(session, sourceDirectory, destinationDirectory, moveChanges);
  },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => sessionUIState,
    setState: (patch: SessionUIStatePatch) => {
      const next = patch instanceof Function ? patch(sessionUIState) : patch;
      Object.assign(sessionUIState, next);
    },
  },
}));

mock.module('@/sync/session-worktree-store', () => ({
  useSessionWorktreeStore: {
    setState: mock(),
  },
}));

mock.module('@/sync/sync-refs', () => ({
  getDirectoryState: (directory: string) => directoryStates.get(directory),
}));

const {
  moveSessionTreeToExistingWorktree,
  startSessionTreeWorktreeMove,
} = await import('./sessionWorktreeMove');

const makeSession = (id: string, directory = '/source'): Session => ({
  id,
  slug: id,
  projectID: 'project-1',
  directory,
  title: id,
  version: '1',
  time: {
    created: 0,
    updated: 0,
  },
});

const makeWorktreeMetadata = (overrides: Partial<WorktreeMetadata> = {}): WorktreeMetadata => ({
  path: '/destination',
  projectDirectory: '/repo',
  branch: 'feature',
  label: 'Destination',
  worktreeStatus: 'ready',
  worktreeSource: 'existing',
  ...overrides,
});

const makeSessionStatus = (type: SessionStatus['type']): SessionStatus => {
  switch (type) {
    case 'busy':
      return { type: 'busy' };
    case 'idle':
      return { type: 'idle' };
    case 'retry':
      return { type: 'retry', attempt: 1, message: 'retry', next: 0 };
  }
};

const setStatuses = (directory: string, statuses: Record<string, State['session_status'][string]['type']>): void => {
  directoryStates.set(directory, {
    session_status: Object.fromEntries(
      Object.entries(statuses).map(([sessionId, type]) => [sessionId, makeSessionStatus(type)]),
    ),
  });
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for condition');
};

const deferred = (): DeferredVoid => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const getIncompleteRollbackCause = (error: Error): IncompleteRollbackCause => {
  const cause = error.cause;
  if (!cause || !(cause instanceof Object)) {
    throw new Error('Expected rollback error cause details');
  }

  const parsed = cause as Partial<IncompleteRollbackCause>;
  if (!(parsed.moveError instanceof Error)) {
    throw new Error('Expected rollback moveError cause');
  }
  if (!Array.isArray(parsed.rollbackFailures)) {
    throw new Error('Expected rollback failures in cause');
  }

  const rollbackFailures = parsed.rollbackFailures.map((entry) => {
    if (!entry || !(entry instanceof Object)) {
      throw new Error('Expected rollback failure entry');
    }
    const failure = entry as { sessionId?: unknown; error?: unknown };
    if (typeof failure.sessionId !== 'string') {
      throw new Error('Expected rollback failure session ID');
    }
    if (!(failure.error instanceof Error)) {
      throw new Error('Expected rollback failure error');
    }
    return { sessionId: failure.sessionId, error: failure.error };
  });

  return {
    moveError: parsed.moveError,
    rollbackFailures,
  };
};

describe('moveSessionTreeToExistingWorktree', () => {
  beforeEach(() => {
    moveCalls.length = 0;
    refreshCalls.length = 0;
    removeWorktreeCalls.length = 0;
    metadataWrites.length = 0;
    toastSuccesses.length = 0;
    toastErrors.length = 0;
    directoryStates.clear();
    storedMetadata.clear();
    sessionUIState.worktreeMetadata = new Map();
    sessionUIState.availableWorktreesByProject = new Map();
    latestMetadataResult = makeWorktreeMetadata({ label: 'Latest destination' });
    sessionUIState.availableWorktrees = [latestMetadataResult];
    moveSessionImplementation = async () => {};
    refreshImplementation = async () => {};
    createQuickWorktreeImplementation = async () => makeWorktreeMetadata({ path: '/created-worktree', worktreeSource: 'created-for-session' });
    resolveProjectRefImplementation = () => ({ id: 'project-1', path: '/repo' });
    waitForWorktreeGitReadyImplementation = async () => {};
    console.warn = () => {};
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
  });

  test('moves the root before descendants, only transfers changes once, and refreshes both directories', async () => {
    const root = makeSession('root');
    const child = makeSession('child');
    const previousRootMetadata = makeWorktreeMetadata({ path: '/old-root', label: 'Old root' });
    const previousChildMetadata = makeWorktreeMetadata({ path: '/old-child', label: 'Old child' });
    const destination = makeWorktreeMetadata();
    setStatuses('/source', { root: 'idle', child: 'idle' });
    storedMetadata.set(root.id, previousRootMetadata);
    storedMetadata.set(child.id, previousChildMetadata);

    const result = await moveSessionTreeToExistingWorktree({
      root,
      descendants: [child],
      sourceDirectory: '/source',
      destination,
    });

    expect(result).toBe('/destination');
    expect(moveCalls).toEqual([
      { sessionId: 'root', sourceDirectory: '/source', destinationDirectory: '/destination', moveChanges: true },
      { sessionId: 'child', sourceDirectory: '/source', destinationDirectory: '/destination', moveChanges: false },
    ]);
    expect(metadataWrites).toEqual([
      { sessionId: 'root', metadata: latestMetadataResult },
      { sessionId: 'child', metadata: latestMetadataResult },
    ]);
    expect(refreshCalls).toEqual([['/source', '/destination']]);
    expect(removeWorktreeCalls).toEqual([]);
  });

  test('rejects a destination that normalizes to the source directory', async () => {
    setStatuses('/source', { root: 'idle' });

    await expect(moveSessionTreeToExistingWorktree({
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/source/',
      destination: makeWorktreeMetadata({ path: '/source' }),
    })).rejects.toThrow('Source and destination are the same');

    expect(moveCalls).toEqual([]);
    expect(refreshCalls).toEqual([]);
  });

  test('rejects a destination worktree that is not ready', async () => {
    setStatuses('/source', { root: 'idle' });

    await expect(moveSessionTreeToExistingWorktree({
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata({ worktreeStatus: 'pending' }),
    })).rejects.toThrow('Destination worktree is not ready');

    expect(moveCalls).toEqual([]);
  });

  test('rejects when the root session is busy before setup', async () => {
    setStatuses('/source', { root: 'busy' });

    await expect(moveSessionTreeToExistingWorktree({
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    })).rejects.toThrow('Session is not idle');

    expect(moveCalls).toEqual([]);
  });

  test('rejects when any descendant is busy before setup', async () => {
    const root = makeSession('root');
    const child = makeSession('child');
    setStatuses('/source', { root: 'idle', child: 'retry' });

    await expect(moveSessionTreeToExistingWorktree({
      root,
      descendants: [child],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    })).rejects.toThrow('Session is not idle');

    expect(moveCalls).toEqual([]);
  });

  test('rejects a duplicate move request while the root move is pending', async () => {
    const root = makeSession('root');
    const rootMove = deferred();
    setStatuses('/source', { root: 'idle' });
    moveSessionImplementation = async (session, sourceDirectory) => {
      if (session.id === 'root' && sourceDirectory === '/source') {
        return rootMove.promise;
      }
    };

    const firstMove = moveSessionTreeToExistingWorktree({
      root,
      descendants: [],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    });
    await waitFor(() => moveCalls.length === 1);

    await expect(moveSessionTreeToExistingWorktree({
      root,
      descendants: [],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    })).rejects.toThrow('Session move already in progress');

    rootMove.resolve();
    await firstMove;
    expect(moveCalls).toHaveLength(1);
  });

  test('rolls back completed moves in reverse order, restores previous metadata, and never removes an existing destination', async () => {
    const root = makeSession('root');
    const childA = makeSession('child-a');
    const childB = makeSession('child-b');
    const previousRootMetadata = makeWorktreeMetadata({ path: '/old-root', label: 'Old root' });
    const previousChildAMetadata = makeWorktreeMetadata({ path: '/old-child-a', label: 'Old child A' });
    const previousChildBMetadata = makeWorktreeMetadata({ path: '/old-child-b', label: 'Old child B' });
    setStatuses('/source', { root: 'idle', 'child-a': 'idle', 'child-b': 'idle' });
    storedMetadata.set(root.id, previousRootMetadata);
    storedMetadata.set(childA.id, previousChildAMetadata);
    storedMetadata.set(childB.id, previousChildBMetadata);
    moveSessionImplementation = async (session, sourceDirectory) => {
      if (session.id === 'child-b' && sourceDirectory === '/source') {
        throw new Error('child-b failed');
      }
    };

    await expect(moveSessionTreeToExistingWorktree({
      root,
      descendants: [childA, childB],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    })).rejects.toThrow('child-b failed');

    expect(moveCalls).toEqual([
      { sessionId: 'root', sourceDirectory: '/source', destinationDirectory: '/destination', moveChanges: true },
      { sessionId: 'child-a', sourceDirectory: '/source', destinationDirectory: '/destination', moveChanges: false },
      { sessionId: 'child-b', sourceDirectory: '/source', destinationDirectory: '/destination', moveChanges: false },
      { sessionId: 'child-a', sourceDirectory: '/destination', destinationDirectory: '/source', moveChanges: false },
      { sessionId: 'root', sourceDirectory: '/destination', destinationDirectory: '/source', moveChanges: true },
    ]);
    expect(metadataWrites).toEqual([
      { sessionId: 'root', metadata: latestMetadataResult },
      { sessionId: 'child-a', metadata: latestMetadataResult },
      { sessionId: 'child-a', metadata: previousChildAMetadata },
      { sessionId: 'root', metadata: previousRootMetadata },
    ]);
    expect(storedMetadata.get(root.id)).toBe(previousRootMetadata);
    expect(storedMetadata.get(childA.id)).toBe(previousChildAMetadata);
    expect(storedMetadata.get(childB.id)).toBe(previousChildBMetadata);
    expect(removeWorktreeCalls).toEqual([]);
    expect(refreshCalls).toEqual([]);
  });

  test('rolls back the root and never moves a child that becomes busy after the root move starts', async () => {
    const root = makeSession('root');
    const child = makeSession('child');
    const rootMove = deferred();
    const previousRootMetadata = makeWorktreeMetadata({ path: '/old-root', label: 'Old root' });
    const previousChildMetadata = makeWorktreeMetadata({ path: '/old-child', label: 'Old child' });
    setStatuses('/source', { root: 'idle', child: 'idle' });
    setStatuses('/destination', {});
    storedMetadata.set(root.id, previousRootMetadata);
    storedMetadata.set(child.id, previousChildMetadata);
    moveSessionImplementation = async (session, sourceDirectory) => {
      if (session.id === 'root' && sourceDirectory === '/source') {
        return rootMove.promise;
      }
    };

    const movePromise = moveSessionTreeToExistingWorktree({
      root,
      descendants: [child],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    });

    await waitFor(() => moveCalls.length === 1);
    setStatuses('/source', { root: 'idle', child: 'busy' });
    setStatuses('/destination', { root: 'idle' });
    rootMove.resolve();

    await expect(movePromise).rejects.toThrow('Session is not idle');

    expect(moveCalls).toEqual([
      { sessionId: 'root', sourceDirectory: '/source', destinationDirectory: '/destination', moveChanges: true },
      { sessionId: 'root', sourceDirectory: '/destination', destinationDirectory: '/source', moveChanges: true },
    ]);
    expect(metadataWrites).toEqual([
      { sessionId: 'root', metadata: latestMetadataResult },
      { sessionId: 'root', metadata: previousRootMetadata },
    ]);
    expect(storedMetadata.get(root.id)).toBe(previousRootMetadata);
    expect(storedMetadata.get(child.id)).toBe(previousChildMetadata);
    expect(removeWorktreeCalls).toEqual([]);
    expect(refreshCalls).toEqual([]);
  });

  test('reports an incomplete rollback explicitly and still does not remove the existing destination', async () => {
    const root = makeSession('root');
    const child = makeSession('child');
    setStatuses('/source', { root: 'idle', child: 'idle' });
    moveSessionImplementation = async (session, sourceDirectory) => {
      if (session.id === 'child' && sourceDirectory === '/source') {
        throw new Error('child failed');
      }
      if (session.id === 'root' && sourceDirectory === '/destination') {
        throw new Error('rollback failed');
      }
    };

    const error = await moveSessionTreeToExistingWorktree({
      root,
      descendants: [child],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    }).catch((rejection) => rejection);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.message.includes('could not be fully rolled back')).toBe(true);
    const cause = getIncompleteRollbackCause(error);
    expect(cause.moveError.message).toBe('child failed');
    expect(cause.rollbackFailures).toEqual([{ sessionId: 'root', error: new Error('rollback failed') }]);

    expect(removeWorktreeCalls).toEqual([]);
  });

  const expectBusyOrRetryRollbackBlock = async (status: Extract<SessionStatus['type'], 'busy' | 'retry'>): Promise<void> => {
    const root = makeSession('root');
    const child = makeSession('child');
    setStatuses('/source', { root: 'idle', child: 'idle' });
    setStatuses('/destination', {});
    moveSessionImplementation = async (session, sourceDirectory) => {
      if (sourceDirectory === '/source' && session.id === 'root') {
        setStatuses('/destination', { root: status });
        return;
      }
      if (sourceDirectory === '/source' && session.id === 'child') {
        throw new Error('child failed');
      }
    };

    await expect(moveSessionTreeToExistingWorktree({
      root,
      descendants: [child],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    })).rejects.toThrow('could not be fully rolled back');

    expect(moveCalls).toEqual([
      { sessionId: 'root', sourceDirectory: '/source', destinationDirectory: '/destination', moveChanges: true },
      { sessionId: 'child', sourceDirectory: '/source', destinationDirectory: '/destination', moveChanges: false },
    ]);
    expect(removeWorktreeCalls).toEqual([]);
  };

  test('does not attempt rollback for a moved root that becomes busy in the destination', async () => {
    await expectBusyOrRetryRollbackBlock('busy');
  });

  test('does not attempt rollback for a moved root that becomes retry in the destination', async () => {
    await expectBusyOrRetryRollbackBlock('retry');
  });

  test('keeps the move successful when the post-move refresh fails', async () => {
    const root = makeSession('root');
    setStatuses('/source', { root: 'idle' });
    refreshImplementation = async () => {
      throw new Error('refresh failed');
    };

    const result = await moveSessionTreeToExistingWorktree({
      root,
      descendants: [],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    });

    expect(result).toBe('/destination');
    expect(refreshCalls).toEqual([['/source', '/destination']]);
  });

  test('removes a newly created worktree when git-ready setup fails', async () => {
    setStatuses('/source', { root: 'idle' });
    waitForWorktreeGitReadyImplementation = async () => {
      throw new Error('git-ready failed');
    };

    startSessionTreeWorktreeMove({
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/source',
      successMessage: 'success',
      failureMessage: 'failed',
    });

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'failed', description: 'git-ready failed' }]);
    expect(removeWorktreeCalls).toEqual([{
      projectDirectory: '/repo',
      directory: '/created-worktree',
      deleteLocalBranch: true,
    }]);
    expect(moveCalls).toEqual([]);
  });

  test('removes a newly created worktree when a session becomes busy before the first move', async () => {
    setStatuses('/source', { root: 'idle' });
    waitForWorktreeGitReadyImplementation = async () => {
      setStatuses('/source', { root: 'busy' });
    };

    startSessionTreeWorktreeMove({
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/source',
      successMessage: 'success',
      failureMessage: 'failed',
    });

    await waitFor(() => toastErrors.length === 1);
    expect(removeWorktreeCalls).toEqual([{
      projectDirectory: '/repo',
      directory: '/created-worktree',
      deleteLocalBranch: true,
    }]);
    expect(moveCalls).toEqual([]);
  });

  test('surfaces a pre-destination preparation failure without attempting removal', async () => {
    setStatuses('/source', { root: 'idle' });
    resolveProjectRefImplementation = () => null;

    startSessionTreeWorktreeMove({
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/source',
      successMessage: 'success',
      failureMessage: 'failed',
    });

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'failed', description: 'Unable to find the project for this session' }]);
    expect(removeWorktreeCalls).toEqual([]);
    expect(moveCalls).toEqual([]);
  });
});
