import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CreateWorktreeArgs, ProjectRef } from '@/lib/worktrees/worktreeManager';

const project: ProjectRef = { id: 'project-1', path: '/repo' };

type DraftState = {
  draftId: number;
  open: boolean;
  target: 'chat' | 'project';
  selectedProjectId?: string | null;
  directoryOverride: string | null;
  pendingWorktreeRequestId?: string | null;
  bootstrapPendingDirectory?: string | null;
  preserveDirectoryOverride?: boolean;
  parentID: string | null;
  title?: string;
  initialPrompt?: string;
};

const emptyDraft = (): DraftState => ({
  draftId: 1,
  open: false,
  target: 'project',
  selectedProjectId: null,
  directoryOverride: null,
  pendingWorktreeRequestId: null,
  bootstrapPendingDirectory: null,
  preserveDirectoryOverride: false,
  parentID: null,
});

let draftState = emptyDraft();
let activeProject: { id: string; path: string } | null = { id: project.id, path: project.path };
let resolvedCommands: string[] | null = null;
const createdPayloads: CreateWorktreeArgs[] = [];
const rejectedRequests: Array<{ id: string; message: string }> = [];
const resolvedRequests: Array<{ id: string; directory: string }> = [];
const directories: string[] = [];
const toastErrors: string[] = [];

const sessionStoreState = {
  get newSessionDraft() {
    return draftState;
  },
  overrideNewSessionDraftTarget: (patch: Partial<DraftState>) => {
    draftState = { ...draftState, ...patch };
  },
  openNewSessionDraft: (options: Partial<DraftState>) => {
    draftState = { ...emptyDraft(), ...options, open: true, target: 'project' };
  },
  closeNewSessionDraft: () => {
    draftState = emptyDraft();
  },
  resolvePendingDraftWorktreeTarget: (requestId: string, directory: string | null) => {
    if (draftState.pendingWorktreeRequestId !== requestId) return;
    draftState = { ...draftState, pendingWorktreeRequestId: null, directoryOverride: directory };
  },
  setDraftBootstrapPendingDirectory: (directory: string | null) => {
    draftState = { ...draftState, bootstrapPendingDirectory: directory };
  },
};

mock.module('@/components/ui', () => ({
  toast: {
    error: (title: string) => {
      toastErrors.push(title);
    },
    success: mock(),
  },
}));

mock.module('@/lib/gitApi', () => ({
  checkIsGitRepository: async () => true,
  resolveGitPrimaryRoot: async () => project.path,
  resolveGitRepositoryPrefix: async () => '',
  validateWorktreeDirectory: async () => ({ valid: true, insideWorktreeRoot: true }),
}));

mock.module('@/lib/git/branchNameGenerator', () => ({
  generateBranchName: () => 'generated-branch',
}));

mock.module('@/lib/modelIdentifier', () => ({
  parseModelIdentifier: () => null,
}));

mock.module('@/lib/openchamberConfig', () => ({
  getWorktreeSetupWaitEnabled: async () => false,
}));

mock.module('@/lib/sharedTrustConfirmation', () => ({
  resolveWorktreeSetupCommands: async () => resolvedCommands ?? [],
  resolveWorktreeSetupCommandsOrCancel: async () => resolvedCommands,
}));

mock.module('@/lib/pathNormalization', () => ({
  normalizePath: (value: string | null) => value,
}));

mock.module('@/lib/projectResolution', () => ({
  resolveProjectForDirectory: () => null,
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  waitForWorktreeBootstrap: mock(async () => undefined),
  waitForWorktreeGitReady: async () => undefined,
}));

mock.module('@/lib/worktrees/worktreeStatus', () => ({
  getRootBranch: async () => 'main',
}));

mock.module('@/lib/worktrees/worktreeManager', () => ({
  removeProjectWorktree: mock(async () => undefined),
}));

mock.module('@/lib/worktrees/worktreeCreate', () => ({
  createWorktreeWithDefaults: async (_project: ProjectRef, args: CreateWorktreeArgs) => {
    createdPayloads.push(args);
    return {
      source: 'sdk',
      name: 'generated-branch',
      path: '/repo/.oc/worktrees/generated-branch',
      projectDirectory: project.path,
      branch: 'generated-branch',
      label: 'generated-branch',
    };
  },
}));

mock.module('@/lib/worktrees/pendingDraftWorktree', () => ({
  createPendingDraftWorktreeRequest: () => 'request-1',
  rejectPendingDraftWorktreeRequest: (id: string, error: Error) => {
    rejectedRequests.push({ id, message: error.message });
  },
  resolvePendingDraftWorktreeRequest: (id: string, directory: string) => {
    resolvedRequests.push({ id, directory });
  },
  waitForPendingDraftWorktreeRequest: async () => '/repo/.oc/worktrees/generated-branch',
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: { getState: () => sessionStoreState },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => activeProject,
    }),
  },
}));

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: { getState: () => ({}) },
}));

mock.module('@/stores/contextStore', () => ({
  useContextStore: { getState: () => ({}) },
}));

mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({
      setDirectory: (directory: string) => {
        directories.push(directory);
      },
    }),
  },
}));

const { createQuickWorktree, createWorktreeDraft } = await import('./worktreeSessionCreator');

describe('quick worktree trust', () => {
  beforeEach(() => {
    draftState = emptyDraft();
    activeProject = { id: project.id, path: project.path };
    resolvedCommands = null;
    createdPayloads.length = 0;
    rejectedRequests.length = 0;
    resolvedRequests.length = 0;
    directories.length = 0;
    toastErrors.length = 0;
  });

  test('a cancelled trust prompt creates no worktree', async () => {
    expect(await createQuickWorktree(project, { cancelOnTrustDismiss: true })).toBeNull();
    expect(createdPayloads).toHaveLength(0);
  });

  test('a cancelled prompt rolls the draft back instead of leaving Creating... up', async () => {
    draftState = {
      ...emptyDraft(),
      open: true,
      selectedProjectId: project.id,
      directoryOverride: '/repo/.oc/worktrees/existing',
      preserveDirectoryOverride: true,
    };

    expect(await createWorktreeDraft()).toBeNull();

    expect(createdPayloads).toHaveLength(0);
    expect(rejectedRequests.map((request) => request.id)).toEqual(['request-1']);
    expect(draftState.open).toBe(true);
    expect(draftState.pendingWorktreeRequestId).toBeNull();
    expect(draftState.directoryOverride).toBe('/repo/.oc/worktrees/existing');
    expect(draftState.bootstrapPendingDirectory).toBeNull();
    expect(toastErrors).toEqual([]);
  });

  test('a cancelled prompt closes the draft it opened for the worktree', async () => {
    expect(await createWorktreeDraft()).toBeNull();

    expect(draftState.open).toBe(false);
    expect(draftState.pendingWorktreeRequestId).toBeNull();
  });

  test('skipping the shared commands still creates the worktree with the personal ones', async () => {
    resolvedCommands = ['cp .env.example .env'];

    expect(await createWorktreeDraft()).toBe('/repo/.oc/worktrees/generated-branch');

    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0]?.setupCommands).toEqual(['cp .env.example .env']);
    expect(resolvedRequests).toEqual([{ id: 'request-1', directory: '/repo/.oc/worktrees/generated-branch' }]);
    expect(directories).toContain('/repo/.oc/worktrees/generated-branch');
    expect(draftState.pendingWorktreeRequestId).toBeNull();
    expect(toastErrors).toEqual([]);
  });

  test('trusting the shared commands creates the worktree with the full list', async () => {
    resolvedCommands = ['bun install', 'cp .env.example .env'];

    expect(await createWorktreeDraft()).toBe('/repo/.oc/worktrees/generated-branch');

    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0]?.setupCommands).toEqual(['bun install', 'cp .env.example .env']);
  });
});
