import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session, SessionStatus } from '@/lib/opencode/model';
import type { State } from '@/sync/types';
import type { WorktreeMetadata } from '@/types/worktree';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import type { SessionTreeMoveIntent, SessionTreeMoveMessages } from './sessionWorktreeMove';

const moveCalls: Array<{
  sessionId: string;
  sourceDirectory: string;
  destinationDirectory: string;
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
) => Promise<void>;
type RefreshImplementation = (directories: string[]) => Promise<void>;
type CreateQuickWorktreeOptions = { preferredName?: string; startRef?: string };
type GitStatusResult = {
  current: string;
  isClean: boolean;
  files: Array<{ path: string; index: string; working_dir: string }>;
};
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
const createQuickWorktreeCalls: Array<{ project: ProjectRef; options: CreateQuickWorktreeOptions }> = [];
const metadataWrites: Array<{ sessionId: string; metadata: WorktreeMetadata | null }> = [];
const toastSuccesses: string[] = [];
const toastErrors: Array<{ title: string; description?: string }> = [];
const toastWarnings: string[] = [];
const titleWrites: Array<{ directory: string; title: string; by: 'agent' | 'user' }> = [];
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
let isGitRepositoryImplementation = async (directory: string): Promise<boolean> => {
  void directory;
  return true;
};
let getGitStatusImplementation = async (directory: string): Promise<GitStatusResult> => {
  void directory;
  return {
  current: 'feature',
  isClean: true,
  files: [],
  };
};
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
let projectFolderInRepository = '';
// Folder per project path, for tests where projects share a repository; falls back to `projectFolderInRepository`.
const projectFoldersByPath = new Map<string, string>();
let directoryInsideCheckout = true;

mock.module('@/components/ui', () => ({
  toast: {
    success: (message: string) => {
      toastSuccesses.push(message);
    },
    error: (title: string, options?: { description?: string }) => {
      toastErrors.push({ title, description: options?.description });
    },
    warning: (message: string) => {
      toastWarnings.push(message);
    },
  },
}));

mock.module('@/lib/gitApi', () => ({
  checkIsGitRepository: (directory: string) => isGitRepositoryImplementation(directory),
  getGitStatus: (directory: string) => getGitStatusImplementation(directory),
  setGitWorktreeTitle: (directory: string, title: string, by: 'agent' | 'user') => {
    titleWrites.push({ directory, title, by });
    return Promise.resolve({ applied: true, title });
  },
  deleteRemoteBranch: mock(),
  resolveGitRepositoryPrefix: mock((directory: string) => Promise.resolve(projectFoldersByPath.get(directory) ?? projectFolderInRepository)),
  validateWorktreeDirectory: mock(() => Promise.resolve({ valid: directoryInsideCheckout, insideWorktreeRoot: directoryInsideCheckout, resolvedWorktreeRoot: null, resolvedCwd: null })),
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

// The server's map of running sessions; null is a failed read, the default.
let hostActiveSessions: Record<string, SessionStatus> | null = null;
const hostStatusReads: string[] = [];

// The server's answer to where a session is; by default a move shows as soon as it was requested.
const serverSessionReads: { sessionId: string; directory: string }[] = [];
// The folder each read went through: it picks the server asked.
const sessionReadFolders: (string | null)[] = [];
const defaultServerDirectory = (sessionId: string): string => (
  [...moveCalls].reverse().find((call) => call.sessionId === sessionId)?.destinationDirectory ?? '/not-moved'
);
let serverDirectoryImplementation = defaultServerDirectory;
// Holds a session read open, for a server that does not answer; gets the read's abort signal.
let sessionReadGate: ((signal: AbortSignal | undefined) => Promise<void>) | null = null;
// Runs before the server's map of running sessions answers, for a read that is still in flight.
let hostStatusReadGate: ((read: number) => Promise<void>) | null = null;
// Sessions whose move reached the local stores: the real move publishes only while its caller's server is current.
const publishedMoves: string[] = [];

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getSession: async (sessionId: string, via?: string | null, signal?: AbortSignal) => {
      if (sessionReadGate) await sessionReadGate(signal);
      const directory = serverDirectoryImplementation(sessionId);
      serverSessionReads.push({ sessionId, directory });
      sessionReadFolders.push(via ?? null);
      return { id: sessionId, directory };
    },
  },
}));

mock.module('@/lib/openchamberConfig', () => ({
  getWorktreeCreateCommand: async () => '',
  substituteCommandVariables: (command: string) => command,
}));
mock.module('@/lib/sharedTrustConfirmation', () => ({
  resolveWorktreeTeardownCommands: async () => [],
}));

mock.module('@/lib/worktreeSessionCreator', () => ({
  createQuickWorktree: mock((project: ProjectRef, options: CreateQuickWorktreeOptions) => {
    createQuickWorktreeCalls.push({ project, options });
    return createQuickWorktreeImplementation(project, options);
  }),
  resolveProjectRef: mock((directory: string) => resolveProjectRefImplementation(directory)),
  // Its folder rule is covered by `projectPathForCheckoutFolder` in worktreePaths.test.ts.
  resolveFolderProjectRef: mock((directory: string) => Promise.resolve(resolveProjectRefImplementation(directory))),
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  waitForWorktreeGitReady: mock((directory: string) => waitForWorktreeGitReadyImplementation(directory)),
  clearWorktreeBootstrapState: mock(),
  getWorktreeBootstrapState: () => null,
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

// Mirrors session-actions: every child store is scanned, because a session's
// live status can be reported by a directory other than its own, and "no store
// covers this session" is 'unknown', never 'idle' — a populated store map says
// nothing about a session none of its stores holds.
const getSessionLiveActivity = (sessionId: string): 'unknown' | 'idle' | 'active' => {
  for (const state of directoryStates.values()) {
    const status = state.session_status[sessionId];
    if (status && status.type !== 'idle') return 'active';
  }
  for (const state of directoryStates.values()) {
    if (Object.hasOwn(state.session_status, sessionId)) return 'idle';
  }
  return 'unknown';
};

mock.module('@/sync/session-actions', () => ({
  moveSessionToDirectory: async (session: Session, sourceDirectory: string, destinationDirectory: string, isCurrent?: () => boolean) => {
    moveCalls.push({ sessionId: session.id, sourceDirectory, destinationDirectory });
    await moveSessionImplementation(session, sourceDirectory, destinationDirectory);
    if (!isCurrent || isCurrent()) publishedMoves.push(session.id);
  },
  // As the real one: the stores answer first, then the server's map of running sessions.
  readSessionsLiveActivity: async (sessionIds: string[], directory: string) => {
    const activities = sessionIds.map(getSessionLiveActivity);
    if (activities.includes('active')) return 'active';
    if (!activities.includes('unknown')) return 'idle';
    hostStatusReads.push(directory);
    if (hostStatusReadGate) await hostStatusReadGate(hostStatusReads.length);
    if (hostActiveSessions === null) return 'unknown';
    const running = hostActiveSessions;
    return sessionIds.some((id) => running[id]) ? 'active' : 'idle';
  },
  isSessionBusyNow: (sessionId: string) => getSessionLiveActivity(sessionId) === 'active',
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
  moveWorktreeSessionsThenRemove,
  requestSessionTreeMove,
  SessionMoveOutcomeUnknownError,
} = await import('./sessionWorktreeMove');
const { WorktreeKeepStoppedError } = await import('./worktreeRemovalFlow');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');

const makeSession = (id: string, directory = '/source'): Session => ({
  id,
  projectID: 'project-1',
  directory,
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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

const makeMoveMessages = (): SessionTreeMoveMessages => ({
  success: 'move succeeded',
  failure: 'move failed',
  outcomeUnknown: 'worktree kept',
});

const makeQuickIntent = (): SessionTreeMoveIntent => ({
  kind: 'quick',
  root: makeSession('root'),
  descendants: [],
  sourceDirectory: '/source',
  messages: makeMoveMessages(),
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

  // SAFETY: createIncompleteRollbackError in the module under test attaches
  // this exact cause shape when rollback reporting fails.
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
    // SAFETY: the same helper populates every rollback entry with a string ID
    // and Error instance before this test helper reads it back.
    const failure = entry as { sessionId: string; error: Error };
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
    createQuickWorktreeCalls.length = 0;
    metadataWrites.length = 0;
    toastSuccesses.length = 0;
    toastErrors.length = 0;
    toastWarnings.length = 0;
    titleWrites.length = 0;
    directoryStates.clear();
    storedMetadata.clear();
    sessionUIState.worktreeMetadata = new Map();
    sessionUIState.availableWorktreesByProject = new Map();
    latestMetadataResult = makeWorktreeMetadata({ label: 'Latest destination' });
    sessionUIState.availableWorktrees = [latestMetadataResult];
    moveSessionImplementation = async () => {};
    refreshImplementation = async () => {};
    isGitRepositoryImplementation = async () => true;
    getGitStatusImplementation = async () => ({
      current: 'feature',
      isClean: true,
      files: [],
    });
    createQuickWorktreeImplementation = async () => makeWorktreeMetadata({ path: '/created-worktree', worktreeSource: 'created-for-session' });
    resolveProjectRefImplementation = () => ({ id: 'project-1', path: '/repo' });
    waitForWorktreeGitReadyImplementation = async () => {};
    projectFolderInRepository = '';
    projectFoldersByPath.clear();
    directoryInsideCheckout = true;
    console.warn = () => {};
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
  });

  test('moves descendants before the root and refreshes both directories', async () => {
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
      { sessionId: 'child', sourceDirectory: '/source', destinationDirectory: '/destination' },
      { sessionId: 'root', sourceDirectory: '/source', destinationDirectory: '/destination' },
    ]);
    expect(metadataWrites).toEqual([
      { sessionId: 'child', metadata: latestMetadataResult },
      { sessionId: 'root', metadata: latestMetadataResult },
    ]);
    expect(refreshCalls).toEqual([['/source', '/destination']]);
    expect(removeWorktreeCalls).toEqual([]);
  });

  test('moves into the project folder inside an existing worktree while the metadata keeps the worktree root', async () => {
    const root = makeSession('root');
    setStatuses('/source', { root: 'idle' });
    projectFolderInRepository = 'ai';

    const result = await moveSessionTreeToExistingWorktree({
      root,
      descendants: [],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    });

    expect(result).toBe('/destination/ai');
    expect(moveCalls).toEqual([{ sessionId: 'root', sourceDirectory: '/source', destinationDirectory: '/destination/ai' }]);
    expect(metadataWrites).toEqual([{ sessionId: 'root', metadata: latestMetadataResult }]);
  });

  test('takes the folder from the project of the moved session when two projects share the repository', async () => {
    const sourceDirectory = '/repo/ai/src';
    setStatuses(sourceDirectory, { root: 'idle' });
    projectFoldersByPath.set('/repo/ai', 'ai');
    projectFoldersByPath.set('/repo/web', 'web');
    resolveProjectRefImplementation = (directory) => (
      directory === sourceDirectory ? { id: 'ai', path: '/repo/ai' } : { id: 'web', path: '/repo/web' }
    );

    const result = await moveSessionTreeToExistingWorktree({
      root: makeSession('root', sourceDirectory),
      descendants: [],
      sourceDirectory,
      destination: makeWorktreeMetadata(),
    });

    expect(result).toBe('/destination/ai');
  });

  test('moves to the worktree root when the project folder is missing there', async () => {
    setStatuses('/source', { root: 'idle' });
    projectFolderInRepository = 'ai';
    directoryInsideCheckout = false;

    const result = await moveSessionTreeToExistingWorktree({
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    });

    expect(result).toBe('/destination');
    expect(toastWarnings).toHaveLength(1);
  });

  test('refuses to move a session from inside a worktree folder into the same worktree', async () => {
    setStatuses('/destination/ai', { root: 'idle' });

    await expect(moveSessionTreeToExistingWorktree({
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/destination/ai',
      destination: makeWorktreeMetadata(),
    })).rejects.toThrow('Source and destination are the same');
    expect(moveCalls).toEqual([]);
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
      { sessionId: 'child-a', sourceDirectory: '/source', destinationDirectory: '/destination' },
      { sessionId: 'child-b', sourceDirectory: '/source', destinationDirectory: '/destination' },
      { sessionId: 'child-a', sourceDirectory: '/destination', destinationDirectory: '/source' },
    ]);
    expect(metadataWrites).toEqual([
      { sessionId: 'child-a', metadata: latestMetadataResult },
      { sessionId: 'child-a', metadata: previousChildAMetadata },
    ]);
    expect(storedMetadata.get(root.id)).toBe(previousRootMetadata);
    expect(storedMetadata.get(childA.id)).toBe(previousChildAMetadata);
    expect(storedMetadata.get(childB.id)).toBe(previousChildBMetadata);
    expect(removeWorktreeCalls).toEqual([]);
    expect(refreshCalls).toEqual([]);
  });

  test('rolls back an earlier child and never moves a later descendant that becomes busy', async () => {
    const root = makeSession('root');
    const childA = makeSession('child-a');
    const childB = makeSession('child-b');
    const childAMove = deferred();
    const previousRootMetadata = makeWorktreeMetadata({ path: '/old-root', label: 'Old root' });
    const previousChildAMetadata = makeWorktreeMetadata({ path: '/old-child-a', label: 'Old child A' });
    const previousChildBMetadata = makeWorktreeMetadata({ path: '/old-child-b', label: 'Old child B' });
    setStatuses('/source', { root: 'idle', 'child-a': 'idle', 'child-b': 'idle' });
    setStatuses('/destination', {});
    storedMetadata.set(root.id, previousRootMetadata);
    storedMetadata.set(childA.id, previousChildAMetadata);
    storedMetadata.set(childB.id, previousChildBMetadata);
    moveSessionImplementation = async (session, sourceDirectory) => {
      if (session.id === 'child-a' && sourceDirectory === '/source') {
        return childAMove.promise;
      }
    };

    const movePromise = moveSessionTreeToExistingWorktree({
      root,
      descendants: [childA, childB],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    });

    await waitFor(() => moveCalls.length === 1);
    setStatuses('/source', { root: 'idle', 'child-a': 'idle', 'child-b': 'busy' });
    setStatuses('/destination', { 'child-a': 'idle' });
    childAMove.resolve();

    await expect(movePromise).rejects.toThrow('Session is not idle');

    expect(moveCalls).toEqual([
      { sessionId: 'child-a', sourceDirectory: '/source', destinationDirectory: '/destination' },
      { sessionId: 'child-a', sourceDirectory: '/destination', destinationDirectory: '/source' },
    ]);
    expect(metadataWrites).toEqual([
      { sessionId: 'child-a', metadata: latestMetadataResult },
      { sessionId: 'child-a', metadata: previousChildAMetadata },
    ]);
    expect(storedMetadata.get(root.id)).toBe(previousRootMetadata);
    expect(storedMetadata.get(childA.id)).toBe(previousChildAMetadata);
    expect(storedMetadata.get(childB.id)).toBe(previousChildBMetadata);
    expect(removeWorktreeCalls).toEqual([]);
    expect(refreshCalls).toEqual([]);
  });

  test('reports an incomplete rollback explicitly and still does not remove the existing destination', async () => {
    const root = makeSession('root');
    const childA = makeSession('child-a');
    const childB = makeSession('child-b');
    setStatuses('/source', { root: 'idle', 'child-a': 'idle', 'child-b': 'idle' });
    moveSessionImplementation = async (session, sourceDirectory) => {
      if (session.id === 'child-b' && sourceDirectory === '/source') {
        throw new Error('child-b failed');
      }
      if (session.id === 'child-a' && sourceDirectory === '/destination') {
        throw new Error('rollback failed');
      }
    };

    const error = await moveSessionTreeToExistingWorktree({
      root,
      descendants: [childA, childB],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    }).catch((rejection) => rejection);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.message.includes('could not be fully rolled back')).toBe(true);
    const cause = getIncompleteRollbackCause(error);
    expect(cause.moveError.message).toBe('child-b failed');
    expect(cause.rollbackFailures).toEqual([{ sessionId: 'child-a', error: new Error('rollback failed') }]);

    expect(removeWorktreeCalls).toEqual([]);
  });

  const expectBusyOrRetryRollbackBlock = async (status: Extract<SessionStatus['type'], 'busy' | 'retry'>): Promise<void> => {
    const root = makeSession('root');
    const childA = makeSession('child-a');
    const childB = makeSession('child-b');
    setStatuses('/source', { root: 'idle', 'child-a': 'idle', 'child-b': 'idle' });
    setStatuses('/destination', {});
    moveSessionImplementation = async (session, sourceDirectory) => {
      if (sourceDirectory === '/source' && session.id === 'child-a') {
        setStatuses('/destination', { 'child-a': status });
        return;
      }
      if (sourceDirectory === '/source' && session.id === 'child-b') {
        throw new Error('child-b failed');
      }
    };

    await expect(moveSessionTreeToExistingWorktree({
      root,
      descendants: [childA, childB],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    })).rejects.toThrow('could not be fully rolled back');

    expect(moveCalls).toEqual([
      { sessionId: 'child-a', sourceDirectory: '/source', destinationDirectory: '/destination' },
      { sessionId: 'child-b', sourceDirectory: '/source', destinationDirectory: '/destination' },
    ]);
    expect(removeWorktreeCalls).toEqual([]);
  };

  test('does not attempt rollback for a moved child that becomes busy in the destination', async () => {
    await expectBusyOrRetryRollbackBlock('busy');
  });

  test('does not attempt rollback for a moved child that becomes retry in the destination', async () => {
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

    requestSessionTreeMove(makeQuickIntent());

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'move failed', description: 'git-ready failed' }]);
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

    requestSessionTreeMove(makeQuickIntent());

    await waitFor(() => toastErrors.length === 1);
    expect(removeWorktreeCalls).toEqual([{
      projectDirectory: '/repo',
      directory: '/created-worktree',
      deleteLocalBranch: true,
    }]);
    expect(moveCalls).toEqual([]);
  });

  test('moves an existing-worktree request as soon as it is requested', async () => {
    setStatuses('/source', { root: 'idle' });

    requestSessionTreeMove({
      kind: 'existing',
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
      messages: makeMoveMessages(),
    });

    await waitFor(() => moveCalls.length === 1);
    expect(moveCalls).toEqual([{
      sessionId: 'root',
      sourceDirectory: '/source',
      destinationDirectory: '/destination',
    }]);
  });

  test('moves a non-Git source without checking its status', async () => {
    setStatuses('/source', { root: 'idle' });
    isGitRepositoryImplementation = async () => false;
    let statusCallCount = 0;
    getGitStatusImplementation = async () => {
      statusCallCount += 1;
      return {
        current: 'feature',
        isClean: true,
        files: [],
      };
    };

    requestSessionTreeMove(makeQuickIntent());

    await waitFor(() => createQuickWorktreeCalls.length === 1);
    await waitFor(() => moveCalls.length === 1);

    expect(statusCallCount).toBe(0);
    expect(moveCalls).toEqual([{
      sessionId: 'root',
      sourceDirectory: '/source',
      destinationDirectory: '/created-worktree',
    }]);
  });

  test('does not move the root when a descendant fails', async () => {
    const root = makeSession('root');
    const child = makeSession('child');
    setStatuses('/source', { root: 'idle', child: 'idle' });
    setStatuses('/destination', { root: 'idle' });
    moveSessionImplementation = async (session, sourceDirectory) => {
      if (session.id === 'child' && sourceDirectory === '/source') {
        throw new Error('child failed');
      }
    };

    await expect(moveSessionTreeToExistingWorktree({
      root,
      descendants: [child],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    })).rejects.toThrow('child failed');

    expect(moveCalls).toEqual([
      { sessionId: 'child', sourceDirectory: '/source', destinationDirectory: '/destination' },
    ]);
  });

  test('removes a newly created worktree when the move is definitely rejected', async () => {
    setStatuses('/source', { root: 'idle' });
    moveSessionImplementation = async () => {
      throw new Error('Directory does not exist: /created-worktree');
    };

    requestSessionTreeMove(makeQuickIntent());

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'move failed', description: 'Directory does not exist: /created-worktree' }]);
    expect(removeWorktreeCalls).toEqual([{
      projectDirectory: '/repo',
      directory: '/created-worktree',
      deleteLocalBranch: true,
    }]);
    expect(refreshCalls).toEqual([]);
  });

  // OpenCode admits a move before answering, so a lost response may still
  // land the session in the new worktree. Deleting it would pull the
  // directory out from under a session that moved there.
  test('keeps a newly created worktree when the move fails ambiguously', async () => {
    setStatuses('/source', { root: 'idle' });
    moveSessionImplementation = async () => {
      throw new Error('Request timed out');
    };

    requestSessionTreeMove(makeQuickIntent());

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'move failed', description: 'worktree kept' }]);
    expect(removeWorktreeCalls).toEqual([]);
    expect(refreshCalls).toEqual([['/source', '/created-worktree']]);
  });

  test('a new worktree carries the current session title and explicit user ownership', async () => {
    setStatuses('/source', { named: 'idle', plain: 'idle' });
    const named = { ...makeSession('named'), title: 'Login fix', metadata: { openchamber: { workTitle: { title: 'Login fix', by: 'agent' } } } };

    requestSessionTreeMove({ ...makeQuickIntent(), root: named });
    await waitFor(() => toastSuccesses.length === 1);
    requestSessionTreeMove({ ...makeQuickIntent(), root: { ...makeSession('plain'), title: 'Generated title' } });
    await waitFor(() => toastSuccesses.length === 2);

    setStatuses('/source', { user: 'idle' });
    requestSessionTreeMove({ ...makeQuickIntent(), root: { ...makeSession('user'), title: 'My task', metadata: { openchamber: { workTitle: { title: 'My task', by: 'user' } } } } });
    await waitFor(() => toastSuccesses.length === 3);
    expect(titleWrites).toEqual([
      { directory: '/created-worktree', title: 'Login fix', by: 'agent' },
      { directory: '/created-worktree', title: 'Generated title', by: 'agent' },
      { directory: '/created-worktree', title: 'My task', by: 'user' },
    ]);
  });

  test('keeps a newly created worktree when a descendant fails ambiguously before the root moved', async () => {
    setStatuses('/source', { root: 'idle', child: 'idle' });
    moveSessionImplementation = async (session) => {
      if (session.id === 'child') throw new Error('Request timed out');
    };

    requestSessionTreeMove({
      kind: 'quick',
      root: makeSession('root'),
      descendants: [makeSession('child')],
      sourceDirectory: '/source',
      messages: makeMoveMessages(),
    });

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'move failed', description: 'worktree kept' }]);
    expect(moveCalls).toEqual([
      { sessionId: 'child', sourceDirectory: '/source', destinationDirectory: '/created-worktree' },
    ]);
    expect(removeWorktreeCalls).toEqual([]);
    expect(refreshCalls).toEqual([['/source', '/created-worktree']]);
  });

  test('keeps a newly created worktree when the root move times out after a descendant moved', async () => {
    setStatuses('/source', { root: 'idle', child: 'idle' });
    moveSessionImplementation = async (session, sourceDirectory) => {
      if (session.id === 'root' && sourceDirectory === '/source') throw new Error('Request timed out');
    };

    requestSessionTreeMove({
      kind: 'quick',
      root: makeSession('root'),
      descendants: [makeSession('child')],
      sourceDirectory: '/source',
      messages: makeMoveMessages(),
    });

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'move failed', description: 'worktree kept' }]);
    // The definitely moved child rolls back; the root's placement is unknown.
    expect(moveCalls).toEqual([
      { sessionId: 'child', sourceDirectory: '/source', destinationDirectory: '/created-worktree' },
      { sessionId: 'root', sourceDirectory: '/source', destinationDirectory: '/created-worktree' },
      { sessionId: 'child', sourceDirectory: '/created-worktree', destinationDirectory: '/source' },
    ]);
    expect(removeWorktreeCalls).toEqual([]);
    expect(refreshCalls).toEqual([['/source', '/created-worktree']]);
  });

  test('refuses to move a session whose live status is reported by another directory', async () => {
    setStatuses('/source', { root: 'idle' });
    setStatuses('/other-directory', { root: 'busy' });

    await expect(moveSessionTreeToExistingWorktree({
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    })).rejects.toThrow('Session is not idle');

    expect(moveCalls).toEqual([]);
  });

  test('refuses to move when no child store can report session status', async () => {
    directoryStates.clear();

    await expect(moveSessionTreeToExistingWorktree({
      root: makeSession('root'),
      descendants: [],
      sourceDirectory: '/source',
      destination: makeWorktreeMetadata(),
    })).rejects.toThrow('Session status is unavailable');

    expect(moveCalls).toEqual([]);
  });

  test('surfaces a pre-destination preparation failure without attempting removal', async () => {
    setStatuses('/source', { root: 'idle' });
    resolveProjectRefImplementation = () => null;

    requestSessionTreeMove(makeQuickIntent());

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'move failed', description: 'Unable to find the project for this session' }]);
    expect(removeWorktreeCalls).toEqual([]);
    expect(moveCalls).toEqual([]);
  });
});

describe('moveWorktreeSessionsThenRemove', () => {
  const WORKTREE = '/worktrees/feature';
  let removals = 0;

  const stopReason = async (run: Promise<{ removed: boolean }>): Promise<string> => {
    try {
      await run;
      return 'resolved';
    } catch (error) {
      return error instanceof WorktreeKeepStoppedError ? error.reason : String(error);
    }
  };

  const keep = (sessions: Session[]) => moveWorktreeSessionsThenRemove({
    worktreePath: WORKTREE,
    projectDirectory: '/repo',
    // The global list after the moves: only sessions not moved yet are still in the worktree.
    readSessions: () => sessions.filter((session) => !moveCalls.some((call) => call.sessionId === session.id)),
    removeWorktree: async () => {
      removals += 1;
      return true;
    },
  });

  beforeEach(() => {
    moveCalls.length = 0;
    refreshCalls.length = 0;
    metadataWrites.length = 0;
    hostStatusReads.length = 0;
    serverSessionReads.length = 0;
    sessionReadFolders.length = 0;
    serverDirectoryImplementation = defaultServerDirectory;
    directoryStates.clear();
    storedMetadata.clear();
    hostActiveSessions = {};
    removals = 0;
    moveSessionImplementation = async () => {};
    refreshImplementation = async () => {};
    resolveProjectRefImplementation = () => ({ id: 'project-1', path: '/repo' });
    sessionReadGate = null;
    hostStatusReadGate = null;
    publishedMoves.length = 0;
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
    console.warn = () => {};
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    hostActiveSessions = null;
    sessionReadGate = null;
    hostStatusReadGate = null;
  });

  const switchAway = () => switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
  const switchBack = () => switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
  const tree = () => [{ ...makeSession('child', WORKTREE), parentID: 'root' }, makeSession('root', WORKTREE)];

  // Nothing of the old server reaches the new one: no request, no store write, no rollback.
  const expectNothingAfterSwitch = (movedBeforeSwitch: string[]) => {
    expect(moveCalls.map((call) => call.sessionId)).toEqual(movedBeforeSwitch);
    expect(publishedMoves).toEqual([]);
    expect(metadataWrites).toEqual([]);
    expect(refreshCalls).toEqual([]);
    expect(serverSessionReads).toEqual([]);
    expect(removals).toBe(0);
  };

  test('a server switch while the tree move reads whether its sessions run stops before any move', async () => {
    // Read 1 is the delete's own check; read 2 the tree move's.
    hostStatusReadGate = async (read) => {
      if (read === 2) switchAway();
    };

    expect(await stopReason(keep(tree()))).toBe('switched');
    expect(hostStatusReads).toHaveLength(2);
    expectNothingAfterSwitch([]);
  });

  test('a server switch while the first subsession move is pending stops the tree and rolls nothing back', async () => {
    moveSessionImplementation = async (session) => {
      if (session.id === 'child') switchAway();
    };

    expect(await stopReason(keep(tree()))).toBe('switched');
    expectNothingAfterSwitch(['child']);
  });

  test('switching away and back while a move is pending still stops it: the round trip is another instance', async () => {
    moveSessionImplementation = async (session) => {
      if (session.id !== 'child') return;
      switchAway();
      switchBack();
    };

    expect(await stopReason(keep(tree()))).toBe('switched');
    expectNothingAfterSwitch(['child']);
  });

  test('a confirmation read the server never answers ends at the deadline and keeps the worktree', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    // Never settles, not even on abort: the deadline must not wait for the read.
    sessionReadGate = (signal) => {
      signals.push(signal);
      return new Promise(() => {});
    };
    // The ten-second deadline, shortened; the poll interval stays.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = Object.assign(
      (handler: () => void, ms?: number) => realSetTimeout(handler, ms === 10_000 ? 20 : ms),
      realSetTimeout,
    );
    try {
      expect(await stopReason(keep([makeSession('root', WORKTREE)]))).toBe('unconfirmed');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(removals).toBe(0);
  });

  // No child store covers a worktree that was not opened since the page
  // loaded, so the server's map answers for it.
  test('moves a tree whose folder has no status store when the host lists nothing running', async () => {
    const result = await keep([makeSession('child', WORKTREE), makeSession('root', WORKTREE)].map((session) => (
      session.id === 'child' ? { ...session, parentID: 'root' } : session
    )));

    expect(moveCalls).toEqual([
      { sessionId: 'child', sourceDirectory: WORKTREE, destinationDirectory: '/repo' },
      { sessionId: 'root', sourceDirectory: WORKTREE, destinationDirectory: '/repo' },
    ]);
    expect(result).toEqual({ removed: true });
    expect(removals).toBe(1);
    // Once before anything moves, then before each move, for the worktree's folder.
    expect(hostStatusReads).toEqual([WORKTREE, WORKTREE, WORKTREE, WORKTREE]);
  });

  test('a session the host reports running keeps the worktree and moves nothing', async () => {
    hostActiveSessions = { root: { type: 'busy' } };

    expect(await stopReason(keep([makeSession('root', WORKTREE)]))).toBe('busy');
    expect(moveCalls).toEqual([]);
    expect(removals).toBe(0);
  });

  test('a session that starts running between two moves stops the second one', async () => {
    moveSessionImplementation = async (session) => {
      if (session.id === 'first') hostActiveSessions = { second: { type: 'busy' } };
    };

    expect(await stopReason(keep([makeSession('first', WORKTREE), makeSession('second', `${WORKTREE}/sub`)]))).toBe('busy');
    expect(moveCalls.map((call) => call.sessionId)).toEqual(['first']);
    expect(removals).toBe(0);
  });

  test('a failed status read keeps the worktree as unknown', async () => {
    hostActiveSessions = null;

    expect(await stopReason(keep([makeSession('root', WORKTREE)]))).toBe('unknown');
    expect(moveCalls).toEqual([]);
    expect(removals).toBe(0);
  });

  test('a project registered inside the worktree is passed over for the worktree\'s project', async () => {
    resolveProjectRefImplementation = () => ({ id: 'inside', path: `${WORKTREE}/ai` });

    await keep([makeSession('root', `${WORKTREE}/ai`)]);

    expect(moveCalls).toEqual([{ sessionId: 'root', sourceDirectory: `${WORKTREE}/ai`, destinationDirectory: '/repo' }]);
  });

  test('a move that loses its answer keeps the worktree and says the outcome is unknown', async () => {
    moveSessionImplementation = async () => {
      throw new Error('Request timed out');
    };

    await expect(keep([makeSession('root', WORKTREE)])).rejects.toBeInstanceOf(SessionMoveOutcomeUnknownError);
    expect(removals).toBe(0);
    expect(refreshCalls).toEqual([[WORKTREE, '/repo']]);
  });

  // OpenCode answers a move once it is queued; removing the folder before a
  // runner there applies it left the session in the deleted folder.
  test('removes the worktree only once the server places every moved session in the project', async () => {
    let readsBeforeApplied = 2;
    serverDirectoryImplementation = (sessionId) => {
      if (sessionId === 'root' && readsBeforeApplied > 0) {
        readsBeforeApplied -= 1;
        return WORKTREE;
      }
      return defaultServerDirectory(sessionId);
    };
    let readsAtRemoval = -1;
    const result = await moveWorktreeSessionsThenRemove({
      worktreePath: WORKTREE,
      projectDirectory: '/repo',
      readSessions: () => [makeSession('root', WORKTREE)].filter((session) => !moveCalls.some((call) => call.sessionId === session.id)),
      removeWorktree: async () => {
        readsAtRemoval = serverSessionReads.length;
        return true;
      },
    });

    expect(result).toEqual({ removed: true });
    expect(serverSessionReads).toEqual([
      { sessionId: 'root', directory: WORKTREE },
      { sessionId: 'root', directory: WORKTREE },
      { sessionId: 'root', directory: '/repo' },
    ]);
    expect(readsAtRemoval).toBe(3);
    // Through the destination, never the folder on screen, which can be an isolated space.
    expect(sessionReadFolders).toEqual(['/repo', '/repo', '/repo']);
  });

  test('a move the server has not applied in time keeps the worktree', async () => {
    // Each read takes five seconds of the clock, so the wait gives up on the second.
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    serverDirectoryImplementation = () => {
      clock += 5_000;
      return WORKTREE;
    };
    try {
      expect(await stopReason(keep([makeSession('root', WORKTREE)]))).toBe('unconfirmed');
    } finally {
      Date.now = realNow;
    }
    expect(moveCalls.map((call) => call.sessionId)).toEqual(['root']);
    expect(serverSessionReads).toHaveLength(2);
    expect(removals).toBe(0);
  });
});

