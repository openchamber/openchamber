import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CreateWorktreeArgs, ProjectRef } from '@/lib/worktrees/worktreeManager';

interface MockBranchTracking {
  main?: string;
}

const project: ProjectRef = { id: 'project-1', path: '/repo' };

let projectRoot = '/repo';
let gitStatus: {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
} | null = null;
let branchTracking: MockBranchTracking = {};
const createdPayloads: CreateWorktreeArgs[] = [];

mock.module('@/lib/gitApi', () => ({
  getGitStatus: () => (gitStatus ? Promise.resolve(gitStatus) : Promise.reject(new Error('no status'))),
  getGitBranches: () => Promise.resolve({
    all: [],
    current: '',
    branches: branchTracking.main
      ? { main: { current: false, name: 'main', commit: 'abc1234', label: '', tracking: branchTracking.main } }
      : {},
  }),
}));

mock.module('@/lib/worktrees/worktreeStatus', () => ({
  resolveProjectRoot: (directory: string) => Promise.resolve(projectRoot || directory),
  invalidateResolvedProjectRootCache: mock(),
  getRootBranch: () => Promise.resolve(gitStatus?.current || 'HEAD'),
}));

mock.module('@/lib/worktrees/worktreeManager', () => ({
  createWorktree: (_project: ProjectRef, args: CreateWorktreeArgs) => {
    createdPayloads.push(args);
    return Promise.resolve({
      source: 'sdk',
      name: 'wt',
      path: '/repo/.oc/worktrees/wt',
      projectDirectory: '/repo',
      branch: 'wt',
      label: 'wt',
      worktreeRoot: '/repo/.oc/worktrees/wt',
      worktreeStatus: 'ready',
      headState: 'branch',
      worktreeSource: 'created-for-session',
    });
  },
}));

const { createWorktreeWithDefaults, withWorktreeRemoteStartRef } = await import('./worktreeCreate');

const baseArgs = (overrides: CreateWorktreeArgs = {}): CreateWorktreeArgs => ({
  preferredName: 'openchamber/feature',
  mode: 'new',
  branchName: 'openchamber/feature',
  worktreeName: 'openchamber/feature',
  ...overrides,
});

describe('withWorktreeRemoteStartRef', () => {
  beforeEach(() => {
    projectRoot = '/repo';
    gitStatus = { current: 'main', tracking: 'origin/main', ahead: 0, behind: 0 };
    branchTracking = {};
    createdPayloads.length = 0;
  });

  test('selects the tracked remote ref for the runtime to fetch', async () => {
    gitStatus = { current: 'main', tracking: 'origin/main', ahead: 0, behind: 15 };

    const args = await withWorktreeRemoteStartRef(project, baseArgs());

    expect(args.startRef).toBe('remotes/origin/main');
  });

  test('selects the tracked remote ref when the explicit start ref names the current branch', async () => {
    gitStatus = { current: 'main', tracking: 'origin/main', ahead: 0, behind: 3 };

    const args = await withWorktreeRemoteStartRef(project, baseArgs({ startRef: 'main' }));

    expect(args.startRef).toBe('remotes/origin/main');
  });

  test('keeps the local base when it has unpublished commits', async () => {
    gitStatus = { current: 'main', tracking: 'origin/main', ahead: 2, behind: 15 };

    const args = baseArgs();
    const resolved = await withWorktreeRemoteStartRef(project, args);

    expect(resolved).toBe(args);
  });

  test('keeps the local base without upstream tracking', async () => {
    gitStatus = { current: 'main', tracking: null, ahead: 0, behind: 0 };

    const args = baseArgs();
    const resolved = await withWorktreeRemoteStartRef(project, args);

    expect(resolved).toBe(args);
  });

  test('keeps the requested base when git status is unavailable', async () => {
    gitStatus = null;

    const args = baseArgs();
    const resolved = await withWorktreeRemoteStartRef(project, args);

    expect(resolved).toBe(args);
  });

  test('keeps an explicit non-root local start ref untouched', async () => {
    gitStatus = { current: 'main', tracking: 'origin/main', ahead: 0, behind: 15 };

    const args = baseArgs({ startRef: 'release/1.2' });
    const resolved = await withWorktreeRemoteStartRef(project, args);

    expect(resolved).toBe(args);
  });

  test('keeps an explicit remote start ref untouched', async () => {
    const args = baseArgs({ startRef: 'remotes/origin/main' });
    const resolved = await withWorktreeRemoteStartRef(project, args);

    expect(resolved).toBe(args);
  });

  test('keeps a commit SHA start ref untouched', async () => {
    const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    const args = baseArgs({ startRef: sha });
    const resolved = await withWorktreeRemoteStartRef(project, args);

    expect(resolved).toBe(args);
  });

  test('keeps the requested base in existing mode', async () => {
    const args = baseArgs({ mode: 'existing', existingBranch: 'origin/feature' });
    const resolved = await withWorktreeRemoteStartRef(project, args);

    expect(resolved).toBe(args);
  });

  test('keeps the requested base on a detached root checkout', async () => {
    gitStatus = { current: '', tracking: null, ahead: 0, behind: 0 };

    const args = baseArgs();
    const resolved = await withWorktreeRemoteStartRef(project, args);

    expect(resolved).toBe(args);
  });

  test('reads the root checkout state, not the project directory state', async () => {
    projectRoot = '/primary';
    gitStatus = { current: 'main', tracking: 'origin/main', ahead: 0, behind: 15 };

    const args = await withWorktreeRemoteStartRef(project, baseArgs());

    expect(args.startRef).toBe('remotes/origin/main');
  });
});

describe('createWorktreeWithDefaults remote source integration', () => {
  beforeEach(() => {
    projectRoot = '/repo';
    gitStatus = { current: 'main', tracking: 'origin/main', ahead: 0, behind: 0 };
    branchTracking = { main: 'origin/main' };
    createdPayloads.length = 0;
  });

  test('sets the new branch\'s own upstream when using the tracked remote source', async () => {
    gitStatus = { current: 'main', tracking: 'origin/main', ahead: 0, behind: 15 };

    await createWorktreeWithDefaults(project, baseArgs());

    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0].startRef).toBe('remotes/origin/main');
    expect(createdPayloads[0].setUpstream).toBe(true);
    expect(createdPayloads[0].upstreamRemote).toBe('origin');
    expect(createdPayloads[0].upstreamBranch).toBe('openchamber/feature');
  });

  test('keeps upstream defaults when the start ref is untouched', async () => {
    gitStatus = { current: 'main', tracking: 'origin/main', ahead: 2, behind: 0 };

    await createWorktreeWithDefaults(project, baseArgs());

    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0].startRef).toBe(undefined);
    expect(createdPayloads[0].setUpstream).toBe(true);
    expect(createdPayloads[0].upstreamRemote).toBe('origin');
    expect(createdPayloads[0].upstreamBranch).toBe('openchamber/feature');
  });

  test('passes an explicit remote start ref through with upstream defaults as before', async () => {
    await createWorktreeWithDefaults(project, baseArgs({ startRef: 'remotes/origin/main' }));

    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0].startRef).toBe('remotes/origin/main');
    expect(createdPayloads[0].setUpstream).toBe(true);
    expect(createdPayloads[0].upstreamRemote).toBe('origin');
    expect(createdPayloads[0].upstreamBranch).toBe('openchamber/feature');
  });
});
