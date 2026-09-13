import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { routeMessage } from '@/sync/session-ui-store';
import { toast } from '@/components/ui';
import type { AgentWithExtras } from './useAgentsStore';

type RouteMessageInput = Parameters<typeof routeMessage>[0];

const routeMessageCalls: RouteMessageInput[] = [];
const routeMessageMock = mock((input: RouteMessageInput) => {
  routeMessageCalls.push(input);
  return Promise.resolve('prompt' as const);
});

const upsertedSessions: Session[] = [];
const registeredDirectories: Array<{ sessionID: string; directory: string }> = [];
const ensureChildCalls: Array<{ directory: string; bootstrap?: boolean }> = [];
const worktreeMetadataCalls: Array<{ sessionId: string; path: string }> = [];
const worktreeCreateCalls: Array<{ project: { id?: string; path: string }; args: Record<string, unknown>; options: unknown }> = [];
const worktreeBootstrapWaitCalls: string[] = [];
const operationOrder: string[] = [];
let isGitRepository = false;
let waitForWorktreeSetup = false;
// The platform-shaped worktree path each test's mocked creation reports.
let createdWorktreePath = '/repo-worktrees/fix-thing';
const createWorktreeWithDefaultsMock = mock((project: { id?: string; path: string }, args: Record<string, unknown>, options: unknown) => {
  worktreeCreateCalls.push({ project, args, options });
  return Promise.resolve({
    source: 'sdk',
    name: 'fix-thing',
    path: createdWorktreePath,
    projectDirectory: '/repo',
    branch: 'fix-thing',
    label: 'fix-thing',
    worktreeRoot: '/repo-worktrees/fix-thing',
    worktreeStatus: 'pending',
    headState: 'branch',
    worktreeSource: 'created-for-session',
  });
});
const childState = {
  session: [] as Session[],
  sessionTotal: 0,
  limit: 5,
};
let currentDirectory = '/repo';
const listAgentsCalls: Array<string | null | undefined> = [];
let listAgentsImpl: (directory: string | null | undefined) => Promise<AgentWithExtras[]> = async () => [];

mock.module('@/sync/session-ui-store', () => ({
  routeMessage: routeMessageMock,
  useSessionUIStore: {
    getState: () => ({
      markSessionAsOpenChamberCreated: mock(() => undefined),
      setWorktreeMetadata: (sessionId: string, metadata: { path: string }) => {
        worktreeMetadataCalls.push({ sessionId, path: metadata.path });
      },
    }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => null,
    listAgents: (directory: string | null | undefined) => {
      listAgentsCalls.push(directory);
      return listAgentsImpl(directory);
    },
    withDirectory: async (directory: string, fn: () => Promise<Session>) => {
      const previous = currentDirectory;
      currentDirectory = directory;
      try {
        return await fn();
      } finally {
        currentDirectory = previous;
      }
    },
    createSession: async (params?: { title?: string }): Promise<Session> => {
      operationOrder.push(`createSession:${currentDirectory}`);
      return {
        id: 'ses_multirun',
        title: params?.title ?? '',
        directory: currentDirectory,
        time: { created: 1, updated: 1 },
      } as Session;
    },
  },
}));

mock.module('@/lib/gitApi', () => ({
  checkIsGitRepository: mock(() => Promise.resolve(isGitRepository)),
}));

// `loadAgents` tags each agent through its config route; these tests only need
// the directory list, so the route is a local no-op.
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () =>
    new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    }),
}));

mock.module('@/lib/worktrees/worktreeCreate', () => ({
  createWorktreeWithDefaults: createWorktreeWithDefaultsMock,
  resolveRootTrackingRemote: mock(() => Promise.resolve(null)),
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  waitForWorktreeBootstrap: (directory: string) => {
    worktreeBootstrapWaitCalls.push(directory);
    operationOrder.push(`wait:${directory}`);
    return Promise.resolve();
  },
}));

mock.module('@/lib/worktrees/worktreeStatus', () => ({
  getRootBranch: mock(() => Promise.resolve('main')),
}));

mock.module('@/lib/openchamberConfig', () => ({
  getWorktreeSetupWaitEnabled: mock(() => Promise.resolve(waitForWorktreeSetup)),
  saveWorktreeSetupCommands: mock(() => Promise.resolve()),
}));

mock.module('./useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({ currentDirectory: '/repo' }),
  },
}));

mock.module('./useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', path: '/repo' }],
    }),
  },
}));

mock.module('./useSnippetsStore', () => ({
  useSnippetsStore: {
    getState: () => ({
      expandText: (value: string) => Promise.resolve(value),
    }),
  },
}));

mock.module('./useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      upsertSession: (session: Session) => {
        upsertedSessions.push(session);
      },
    }),
  },
}));

mock.module('@/sync/sync-refs', () => ({
  getSyncSessionDirectory: () => null,
  // useAgentsStore (now in useMultiRunStore's graph) pulls useConfigStore,
  // which registers a config-change subscription at module init.
  getSyncConfig: () => null,
  subscribeToSyncConfigChanges: () => () => {},
  registerSessionDirectory: (sessionID: string, directory: string) => {
    registeredDirectories.push({ sessionID, directory });
  },
  getSyncChildStores: () => ({
    ensureChild: (directory: string, options?: { bootstrap?: boolean }) => {
      ensureChildCalls.push({ directory, bootstrap: options?.bootstrap });
      return {
        setState: (updater: typeof childState | ((state: typeof childState) => Partial<typeof childState> | typeof childState)) => {
          const patch = typeof updater === 'function' ? updater(childState) : updater;
          if (patch !== childState) {
            Object.assign(childState, patch);
          }
        },
      };
    },
  }),
}));

const { useMultiRunStore } = await import('./useMultiRunStore');
const { resolveAvailableAgentForDirectory, useAgentsStore } = await import('./useAgentsStore');

const agent = (name: string): AgentWithExtras => ({
  name,
  mode: 'subagent',
  permission: [],
  options: {},
});

const toastInfoCalls: Array<Parameters<typeof toast.info>> = [];
let originalToastInfo: typeof toast.info;

/** createMultiRun dispatches its sends in a detached task; drain it before asserting. */
const flushBackgroundDispatch = async () => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('useMultiRunStore', () => {
  beforeEach(async () => {
    upsertedSessions.length = 0;
    registeredDirectories.length = 0;
    ensureChildCalls.length = 0;
    worktreeMetadataCalls.length = 0;
    worktreeCreateCalls.length = 0;
    worktreeBootstrapWaitCalls.length = 0;
    operationOrder.length = 0;
    isGitRepository = false;
    waitForWorktreeSetup = false;
    createdWorktreePath = '/repo-worktrees/fix-thing';
    childState.session = [];
    childState.sessionTotal = 0;
    childState.limit = 5;
    currentDirectory = '/repo';
    listAgentsCalls.length = 0;
    listAgentsImpl = async () => [];
    toastInfoCalls.length = 0;
    originalToastInfo = toast.info;
    toast.info = (...args: Parameters<typeof toast.info>) => {
      toastInfoCalls.push(args);
      return 'toast-id';
    };
    useAgentsStore.setState({ agentsByDirectory: {}, agents: [], isLoading: false });
    useMultiRunStore.setState({ isLoading: false, error: null });
    // Earlier tests never awaited their detached send dispatch; drain it before
    // this test starts so its calls cannot leak into these assertions.
    routeMessageCalls.length = 0;
    await flushBackgroundDispatch();
    routeMessageCalls.length = 0;
    toastInfoCalls.length = 0;
  });

  // Restores the toast spy even when a test fails mid-flight.
  afterEach(() => {
    toast.info = originalToastInfo;
  });

  test('registers created sessions without waiting for a sidebar refresh', async () => {
    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: false,
      groups: [{
        prompt: 'Fix it',
        models: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }],
      }],
    });

    expect(result?.sessionIds).toEqual(['ses_multirun']);
    expect(upsertedSessions.map((session) => session.id)).toEqual(['ses_multirun']);
    expect(registeredDirectories).toEqual([{ sessionID: 'ses_multirun', directory: '/repo' }]);
    expect(ensureChildCalls).toEqual([{ directory: '/repo', bootstrap: false }]);
    expect(childState.session.map((session) => session.id)).toEqual(['ses_multirun']);
  });

  test('uses fast background worktree creation for isolated runs', async () => {
    isGitRepository = true;

    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      groups: [{
        prompt: 'Fix it',
        models: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }],
      }],
    });

    expect(result?.sessionIds).toEqual(['ses_multirun']);
    expect(worktreeCreateCalls.length).toBe(1);
    expect(worktreeCreateCalls[0]?.project).toEqual({ id: 'project-1', path: '/repo' });
    expect(worktreeCreateCalls[0]?.args.returnAfterDirectoryCreated).toBe(true);
    expect(worktreeCreateCalls[0]?.options).toEqual({ resolvedRootTrackingRemote: null });
    expect(worktreeBootstrapWaitCalls).toEqual([]);
    expect(operationOrder).toEqual(['createSession:/repo-worktrees/fix-thing']);
    expect(registeredDirectories).toEqual([{ sessionID: 'ses_multirun', directory: '/repo-worktrees/fix-thing' }]);
    expect(worktreeMetadataCalls).toEqual([{ sessionId: 'ses_multirun', path: '/repo-worktrees/fix-thing' }]);
  });

  test('waits for isolated worktree bootstrap when setup wait is enabled', async () => {
    isGitRepository = true;
    waitForWorktreeSetup = true;

    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      groups: [{
        prompt: 'Fix it',
        models: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }],
      }],
    });

    expect(result?.sessionIds).toEqual(['ses_multirun']);
    expect(worktreeBootstrapWaitCalls).toEqual(['/repo-worktrees/fix-thing']);
    expect(operationOrder).toEqual([
      'wait:/repo-worktrees/fix-thing',
      'createSession:/repo-worktrees/fix-thing',
    ]);
  });

  test('accepts more than 5 models per group without a "maximum 5 models" error', async () => {
    const models = Array.from({ length: 6 }, (_, i) => ({
      providerID: 'anthropic',
      modelID: `claude-sonnet-4-5-${i}`,
    }));

    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Many models',
      isolateRuns: false,
      groups: [{ prompt: 'Fix it', models }],
    });

    expect(useMultiRunStore.getState().error).toBeNull();
    expect(result?.sessionIds).toHaveLength(6);
  });

  test('accepts more than 5 models on the isolated (per-worktree) dispatch path', async () => {
    isGitRepository = true;

    const models = Array.from({ length: 6 }, (_, i) => ({
      providerID: 'anthropic',
      modelID: `claude-sonnet-4-5-${i}`,
    }));

    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Many models',
      isolateRuns: true,
      groups: [{ prompt: 'Fix it', models }],
    });

    expect(useMultiRunStore.getState().error).toBeNull();
    expect(result?.sessionIds).toHaveLength(6);
    expect(worktreeCreateCalls.length).toBe(6);
  });

  const AGENT = 'orchestrator';
  const WORKTREE = '/repo-worktrees/fix-thing';

  const createIsolatedRuns = (modelCount: number) =>
    useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      agent: AGENT,
      groups: [{
        prompt: 'Fix it',
        models: Array.from({ length: modelCount }, (_, index) => ({
          providerID: 'anthropic',
          modelID: `claude-sonnet-4-5-${index}`,
        })),
      }],
    });

  test('drops an agent the run worktree cannot resolve and toasts once for the batch', async () => {
    isGitRepository = true;
    // The project defines the agent, the per-run worktree does not: the guard
    // must resolve against each run's own directory, not the project root.
    useAgentsStore.setState({
      agentsByDirectory: {
        '/repo': [agent(AGENT)],
        [WORKTREE]: [agent('build')],
      },
    });
    listAgentsImpl = async (directory) => (directory === WORKTREE ? [agent('build')] : []);

    const result = await createIsolatedRuns(2);
    await flushBackgroundDispatch();

    expect(result?.sessionIds).toHaveLength(2);
    expect(routeMessageCalls).toHaveLength(2);
    for (const call of routeMessageCalls) {
      expect(call.directory).toBe(WORKTREE);
      expect(call.agent).toBeUndefined();
    }
    expect(toastInfoCalls).toHaveLength(1);
    const noticeId = String(toastInfoCalls[0]?.[1]?.id);
    expect(noticeId.startsWith('agent-unavailable:multirun:')).toBe(true);
    expect(noticeId.endsWith(`:${AGENT}`)).toBe(true);
  });

  test('concurrent batches dropping the same agent keep distinct notice ids', async () => {
    isGitRepository = true;
    useAgentsStore.setState({
      agentsByDirectory: { [WORKTREE]: [agent('build')] },
    });
    listAgentsImpl = async (directory) => (directory === WORKTREE ? [agent('build')] : []);

    await createIsolatedRuns(1);
    await createIsolatedRuns(1);
    await flushBackgroundDispatch();

    expect(toastInfoCalls).toHaveLength(2);
    const ids = toastInfoCalls.map((call) => String(call[1]?.id));
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id.endsWith(`:${AGENT}`)).toBe(true);
  });

  test('keeps an agent the run worktree resolves', async () => {
    isGitRepository = true;
    useAgentsStore.setState({
      agentsByDirectory: { [WORKTREE]: [agent(AGENT)] },
    });
    listAgentsImpl = async (directory) => (directory === WORKTREE ? [agent(AGENT)] : []);

    await createIsolatedRuns(1);
    await flushBackgroundDispatch();

    expect(routeMessageCalls).toHaveLength(1);
    expect(routeMessageCalls[0]?.agent).toBe(AGENT);
    expect(toastInfoCalls).toHaveLength(0);
  });

  test('loads a fresh worktree directory before resolving its runs', async () => {
    isGitRepository = true;
    // No pre-seeded store: a freshly created worktree has never loaded its
    // agent list, so the dispatch must load that directory before the guard
    // runs; otherwise the guard fails open and the unavailable agent is sent.
    listAgentsImpl = async (directory) => (directory === WORKTREE ? [agent('build')] : []);

    const result = await createIsolatedRuns(2);
    await flushBackgroundDispatch();

    expect(result?.sessionIds).toHaveLength(2);
    expect(listAgentsCalls).toEqual([WORKTREE]);
    for (const call of routeMessageCalls) {
      expect(call.directory).toBe(WORKTREE);
      expect(call.agent).toBeUndefined();
    }
    expect(toastInfoCalls).toHaveLength(1);
    const noticeId = String(toastInfoCalls[0]?.[1]?.id);
    expect(noticeId.startsWith('agent-unavailable:multirun:')).toBe(true);
    expect(noticeId.endsWith(`:${AGENT}`)).toBe(true);
  });

  test('loads a Windows-shaped worktree path under the key the guard reads', async () => {
    isGitRepository = true;
    // Raw Windows spelling: backslashes, a lowercase drive letter, and a
    // trailing slash. The guard normalizes before reading, so the pre-dispatch
    // load must land under that same normalized key; otherwise the entry is
    // invisible, the guard cannot prove absence, and the agent is sent anyway.
    const rawWorktree = 'c:\\repo-worktrees\\fix-thing\\';
    const normalizedWorktree = 'C:/repo-worktrees/fix-thing';
    createdWorktreePath = rawWorktree;
    listAgentsImpl = async (directory) => (directory === normalizedWorktree ? [agent('build')] : []);

    const result = await createIsolatedRuns(2);
    await flushBackgroundDispatch();

    expect(result?.sessionIds).toHaveLength(2);
    expect(listAgentsCalls).toEqual([normalizedWorktree]);
    // The load seeded the canonical key, not the raw Windows spelling.
    expect(useAgentsStore.getState().agentsByDirectory[normalizedWorktree]?.map((entry) => entry.name)).toEqual(['build']);
    expect(useAgentsStore.getState().agentsByDirectory[rawWorktree]).toBeUndefined();
    // The guard reads that same entry, so the missing agent is provable.
    expect(resolveAvailableAgentForDirectory(rawWorktree, AGENT)).toEqual({ reason: 'missing' });
    for (const call of routeMessageCalls) {
      expect(call.directory).toBe(rawWorktree);
      expect(call.agent).toBeUndefined();
    }
    expect(toastInfoCalls).toHaveLength(1);
    const noticeId = String(toastInfoCalls[0]?.[1]?.id);
    expect(noticeId.startsWith('agent-unavailable:multirun:')).toBe(true);
    expect(noticeId.endsWith(`:${AGENT}`)).toBe(true);
  });

  test('fails open while the run directory list has not loaded', async () => {
    isGitRepository = true;
    useAgentsStore.setState({ agentsByDirectory: {} });
    // The directory's own load fails, so its entry stays missing and the guard
    // cannot prove the agent is unavailable: the request stands and no notice
    // claims the agent was dropped.
    listAgentsImpl = async () => {
      throw new Error('network down');
    };

    await createIsolatedRuns(1);
    await flushBackgroundDispatch();

    expect(listAgentsCalls).toContain(WORKTREE);
    expect(routeMessageCalls).toHaveLength(1);
    expect(routeMessageCalls[0]?.directory).toBe(WORKTREE);
    expect(routeMessageCalls[0]?.agent).toBe(AGENT);
    expect(toastInfoCalls).toHaveLength(0);
  });
});
