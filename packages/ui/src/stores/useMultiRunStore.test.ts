import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { Metadata, Session } from '@/lib/opencode/model';

const upsertedSessions: Session[] = [];
const registeredDirectories: Array<{ sessionID: string; directory: string }> = [];
const ensureChildCalls: Array<{ directory: string; bootstrap?: boolean }> = [];
const worktreeMetadataCalls: Array<{ sessionId: string; path: string }> = [];
const worktreeCreateCalls: Array<{ project: { id?: string; path: string }; args: Record<string, unknown>; options: unknown }> = [];
const worktreeBootstrapWaitCalls: string[] = [];
const operationOrder: string[] = [];
const dispatchedSessionIds: string[] = [];
const deletedSessionIds: string[] = [];
let createdCount = 0;
let rejectNextMembership = false;
let onCreate = () => {};
let isGitRepository = false;
let waitForWorktreeSetup = false;
let localBranches: string[] = [];
const startRefReads: Array<{ directory: string; startFrom: string }> = [];
let failBranchListing = false;
const usedFolders = new Set<string>();
const createWorktreeWithDefaultsMock = mock((project: { id?: string; path: string }, args: Record<string, unknown>, options: unknown) => {
  worktreeCreateCalls.push({ project, args, options });
  // Like the client and server: the folder flattens the name, and a folder
  // that exists gets a suffix. The branch is the one asked for.
  const seed = String(args.worktreeName ?? 'fix-thing').replaceAll('/', '-');
  let name = seed;
  for (let n = 2; usedFolders.has(name); n += 1) name = `${seed}-x${n}`;
  usedFolders.add(name);
  const branch = String(args.branchName ?? name);
  return Promise.resolve({
    source: 'sdk',
    name,
    path: `/repo-worktrees/${name}`,
    projectDirectory: '/repo',
    branch,
    label: branch,
    worktreeRoot: `/repo-worktrees/${name}`,
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
const recordSchema = z.record(z.string(), z.json());

/** The RFC 7386 merge the OpenChamber metadata route performs server-side. */
const mergePatch = (current: Metadata, patch: Metadata): Metadata => {
  const base: Metadata = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) { delete base[key]; continue; }
    const nested = recordSchema.safeParse(value);
    if (!nested.success) { base[key] = value; continue; }
    const previous = recordSchema.safeParse(base[key]);
    base[key] = mergePatch(previous.success ? previous.data : {}, nested.data);
  }
  return base;
};

const storedMetadata = new Map<string, Metadata>();
type FakeRuntimeClient = { runtime: string };
const sdkClient = { runtime: 'multirun.test' };
let activeClient: FakeRuntimeClient = sdkClient;

const fakeOpencodeClient = {
  getSdkClient: () => activeClient,
  createSession: async (params: { title?: string; metadata?: Metadata }, directory?: string | null): Promise<Session> => {
    const dir = directory ?? '/repo';
    operationOrder.push(`createSession:${dir}`);
    createdCount += 1;
    const id = createdCount === 1 ? 'ses_multirun' : `ses_multirun_${createdCount}`;
    storedMetadata.set(id, params.metadata ?? {});
    onCreate();
    return {
      id, projectID: 'p', title: params.title ?? '', directory: dir,
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 }, metadata: params.metadata,
    };
  },
  deleteSession: async (id: string) => {
    deletedSessionIds.push(id);
    storedMetadata.delete(id);
    return true;
  },
};

mock.module('@/sync/session-ui-store', () => ({
  routeMessage: async ({ sessionId }: { sessionId: string }) => { dispatchedSessionIds.push(sessionId); },
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
  opencodeClient: fakeOpencodeClient,
}));

mock.module('@/lib/sessionKnowledgeApi', () => ({
  syncSessionKnowledge: async () => undefined,
}));

mock.module('@/sync/session-archive-batch', () => ({
  requestSessionMetadataUpdate: async (sessionID: string, patch: Metadata) => {
    if (rejectNextMembership) {
      rejectNextMembership = false;
      return { outcome: 'unavailable' as const, reason: 'membership write failed' };
    }
    const metadata = mergePatch(storedMetadata.get(sessionID) ?? {}, patch);
    storedMetadata.set(sessionID, metadata);
    return { outcome: 'updated' as const, metadata };
  },
}));

mock.module('@/lib/gitApi', () => ({
  checkIsGitRepository: mock(() => Promise.resolve(isGitRepository)),
  getGitBranches: mock(() => (failBranchListing
    ? Promise.reject(new Error('git unavailable'))
    : Promise.resolve({ all: [...localBranches, 'remotes/origin/main'], current: 'main', branches: {} }))),
  resolveGitRepositoryPrefix: mock(() => Promise.resolve('')),
  validateWorktreeDirectory: mock(() => Promise.resolve({ valid: true, insideWorktreeRoot: true, resolvedWorktreeRoot: null, resolvedCwd: null })),
}));

mock.module('@/lib/worktrees/worktreeCreate', () => ({
  createWorktreeWithDefaults: createWorktreeWithDefaultsMock,
  resolveRootTrackingRemote: mock(() => Promise.resolve(null)),
  // Settings' remote default names origin/main; the project root needs no ref.
  resolveDefaultWorktreeStartRef: mock((directory: string, startFrom: string) => {
    startRefReads.push({ directory, startFrom });
    return Promise.resolve(startFrom === 'remote-default' ? 'remotes/origin/main' : undefined);
  }),
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  waitForWorktreeBootstrap: (directory: string) => {
    worktreeBootstrapWaitCalls.push(directory);
    operationOrder.push(`wait:${directory}`);
    return Promise.resolve();
  },
  waitForWorktreeGitReady: () => Promise.resolve(),
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

const { MULTIRUN_ISOLATION_UNAVAILABLE, useMultiRunStore } = await import('./useMultiRunStore');

describe('useMultiRunStore', () => {
  beforeEach(() => {
    upsertedSessions.length = 0;
    registeredDirectories.length = 0;
    ensureChildCalls.length = 0;
    worktreeMetadataCalls.length = 0;
    worktreeCreateCalls.length = 0;
    worktreeBootstrapWaitCalls.length = 0;
    operationOrder.length = 0;
    dispatchedSessionIds.length = 0;
    deletedSessionIds.length = 0;
    createdCount = 0;
    rejectNextMembership = false;
    activeClient = sdkClient;
    storedMetadata.clear();
    onCreate = () => {};
    isGitRepository = false;
    waitForWorktreeSetup = false;
    localBranches = [];
    startRefReads.length = 0;
    failBranchListing = false;
    usedFolders.clear();
    childState.session = [];
    childState.sessionTotal = 0;
    childState.limit = 5;
    useMultiRunStore.setState({ isLoading: false, error: null });
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

  // Oracle: requesting separate files cannot silently launch shared-directory
  // jobs. The explicit shared-directory test above is the positive control.
  test('a non-Git project requires explicit shared-directory selection', async () => {
    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Independent work', isolateRuns: true,
      groups: [{ prompt: 'Keep each result', models: [
        { providerID: 'p', modelID: 'a' }, { providerID: 'p', modelID: 'b' },
      ] }],
    });
    expect(result).toBeNull();
    expect(useMultiRunStore.getState().error).toBe(MULTIRUN_ISOLATION_UNAVAILABLE);
    expect(upsertedSessions).toEqual([]);
    expect(worktreeCreateCalls).toEqual([]);
    expect(dispatchedSessionIds).toEqual([]);
  });

  test('membership failure does not dispatch that session or discard a successful sibling', async () => {
    rejectNextMembership = true;
    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'same name', isolateRuns: false,
      groups: [{ prompt: 'question', models: [
        { providerID: 'openrouter', modelID: 'vendor/fail' },
        { providerID: 'openrouter', modelID: 'vendor/success' },
      ] }],
    });
    // Dispatch runs in the background after createMultiRun resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result?.sessionIds).toEqual(['ses_multirun_2']);
    expect(result?.failedCount).toBe(1);
    expect(deletedSessionIds).toEqual(['ses_multirun']);
    expect(dispatchedSessionIds).toEqual(['ses_multirun_2']);
    expect(upsertedSessions.map((session) => session.id)).toEqual(['ses_multirun_2']);
  });

  test('changing runtime while creating stops dispatch and registration', async () => {
    onCreate = () => {
      activeClient = { runtime: 'other-runtime.test' };
      useMultiRunStore.getState().resetForRuntimeSwitch();
    };
    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'runtime', isolateRuns: false,
      groups: [{ prompt: 'question', models: [{ providerID: 'openrouter', modelID: 'vendor/model' }] }],
    });
    expect(result).toBeNull();
    expect(dispatchedSessionIds).toEqual([]);
    expect(upsertedSessions).toEqual([]);
    expect(deletedSessionIds).toEqual([]);
    expect(useMultiRunStore.getState().isLoading).toBe(false);
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
    expect(operationOrder).toEqual(['createSession:/repo-worktrees/fix-thing-anthropic-claude-sonnet-4-5']);
    expect(registeredDirectories).toEqual([{ sessionID: 'ses_multirun', directory: '/repo-worktrees/fix-thing-anthropic-claude-sonnet-4-5' }]);
    expect(worktreeMetadataCalls).toEqual([{ sessionId: 'ses_multirun', path: '/repo-worktrees/fix-thing-anthropic-claude-sonnet-4-5' }]);
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
    expect(worktreeBootstrapWaitCalls).toEqual(['/repo-worktrees/fix-thing-anthropic-claude-sonnet-4-5']);
    expect(operationOrder).toEqual([
      'wait:/repo-worktrees/fix-thing-anthropic-claude-sonnet-4-5',
      'createSession:/repo-worktrees/fix-thing-anthropic-claude-sonnet-4-5',
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

  const laneDirectories = () => registeredDirectories.map((entry) => entry.directory);
  const requestedBranches = () => worktreeCreateCalls.map((call) => call.args.branchName);
  const requestedStartRefs = () => worktreeCreateCalls.map((call) => call.args.startRef);

  test('isolated runs start every lane from the Settings start, read once', async () => {
    isGitRepository = true;
    await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      worktreeStartFrom: 'remote-default',
      groups: [{ prompt: 'Fix it', models: [{ providerID: 'openai', modelID: 'gpt-5' }, { providerID: 'anthropic', modelID: 'claude' }] }],
    });
    expect(startRefReads).toEqual([{ directory: '/repo', startFrom: 'remote-default' }]);
    expect(requestedStartRefs()).toEqual(['remotes/origin/main', 'remotes/origin/main']);
  });

  test('isolated runs: a picked base branch wins, and the project root start is HEAD', async () => {
    isGitRepository = true;
    await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      worktreeBaseBranch: 'feature/x',
      worktreeStartFrom: 'remote-default',
      groups: [{ prompt: 'Fix it', models: [{ providerID: 'openai', modelID: 'gpt-5' }] }],
    });
    await useMultiRunStore.getState().createMultiRun({
      name: 'Fix other',
      isolateRuns: true,
      worktreeStartFrom: 'project-root',
      groups: [{ prompt: 'Fix it', models: [{ providerID: 'openai', modelID: 'gpt-5' }] }],
    });
    expect(requestedStartRefs()).toEqual(['feature/x', 'HEAD']);
  });

  test('isolated runs: every lane gets its own branch, worktree and session directory', async () => {
    isGitRepository = true;
    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      groups: [{ prompt: 'Fix it', models: [
        { providerID: 'openai', modelID: 'gpt-5' },
        { providerID: 'openai', modelID: 'gpt-5' },
        { providerID: 'anthropic', modelID: 'claude' },
        // Slugs to the same name as the first model.
        { providerID: 'openai', modelID: 'gpt.5' },
      ] }],
    });

    expect(result?.sessionIds).toHaveLength(4);
    expect(requestedBranches()).toEqual([
      'fix-thing/openai-gpt-5/1',
      'fix-thing/openai-gpt-5/2',
      'fix-thing/anthropic-claude',
      // `fix-thing/openai-gpt-5` would sit above the duplicates' branches.
      'fix-thing/openai-gpt-5-2',
    ]);
    for (const call of worktreeCreateCalls) {
      expect(call.args.worktreeName).toBe(call.args.branchName);
      expect(call.args.preferredName).toBe(call.args.branchName);
    }
    expect(new Set(laneDirectories()).size).toBe(4);
    expect(worktreeMetadataCalls.map((call) => call.path)).toEqual(laneDirectories());
  });

  test('isolated runs: a second run with the same title avoids the first run\'s branches', async () => {
    isGitRepository = true;
    localBranches = ['main', 'fix-thing/openai-gpt-5', 'fix-thing/anthropic-claude', 'fix-thing/anthropic-claude-2'];
    await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      groups: [{ prompt: 'Fix it', models: [
        { providerID: 'openai', modelID: 'gpt-5' },
        { providerID: 'anthropic', modelID: 'claude' },
      ] }],
    });
    expect(requestedBranches()).toEqual(['fix-thing/openai-gpt-5-2', 'fix-thing/anthropic-claude-3']);
  });

  test('isolated runs: lanes stay distinct when the branch list cannot be read', async () => {
    isGitRepository = true;
    failBranchListing = true;
    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      groups: [
        { prompt: 'A', models: [{ providerID: 'openai', modelID: 'gpt-5' }, { providerID: 'openai', modelID: 'gpt.5' }] },
        { prompt: 'B', models: [{ providerID: 'openai', modelID: 'gpt-5' }] },
      ],
    });
    expect(result?.sessionIds).toHaveLength(3);
    expect(requestedBranches()).toEqual(['g1/fix-thing/openai-gpt-5', 'g1/fix-thing/openai-gpt-5-2', 'g2/fix-thing/openai-gpt-5']);
  });

  test('shared runs: no worktree is made and every lane works in the draft directory', async () => {
    isGitRepository = true;
    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Question',
      isolateRuns: false,
      sharedDirectory: '/repo-worktrees/picked',
      groups: [{ prompt: 'Why?', models: [{ providerID: 'openai', modelID: 'gpt-5' }, { providerID: 'anthropic', modelID: 'claude' }] }],
    });
    expect(result?.sessionIds).toHaveLength(2);
    expect(worktreeCreateCalls).toEqual([]);
    expect(worktreeMetadataCalls).toEqual([]);
    expect(laneDirectories()).toEqual(['/repo-worktrees/picked', '/repo-worktrees/picked']);
  });

  test('shared runs in a worktree the draft just made wait for its setup when Settings say so', async () => {
    isGitRepository = true;
    waitForWorktreeSetup = true;
    await useMultiRunStore.getState().createMultiRun({
      name: 'Question',
      isolateRuns: false,
      sharedDirectory: '/repo-worktrees/picked',
      groups: [{ prompt: 'Why?', models: [{ providerID: 'openai', modelID: 'gpt-5' }, { providerID: 'anthropic', modelID: 'claude' }] }],
    });
    expect(operationOrder).toEqual([
      'wait:/repo-worktrees/picked',
      'createSession:/repo-worktrees/picked',
      'createSession:/repo-worktrees/picked',
    ]);
  });

  test('shared runs without a draft directory use the project directory', async () => {
    isGitRepository = true;
    waitForWorktreeSetup = true;
    await useMultiRunStore.getState().createMultiRun({
      name: 'Question',
      isolateRuns: false,
      groups: [{ prompt: 'Why?', models: [{ providerID: 'openai', modelID: 'gpt-5' }] }],
    });
    expect(worktreeBootstrapWaitCalls).toEqual([]);
    expect(laneDirectories()).toEqual(['/repo']);
  });

  test('a project without Git can explicitly choose a shared directory', async () => {
    isGitRepository = false;
    await useMultiRunStore.getState().createMultiRun({
      name: 'Question',
      isolateRuns: false,
      groups: [{ prompt: 'Why?', models: [{ providerID: 'openai', modelID: 'gpt-5' }, { providerID: 'anthropic', modelID: 'claude' }] }],
    });
    expect(worktreeCreateCalls).toEqual([]);
    expect(laneDirectories()).toEqual(['/repo', '/repo']);
  });
});
