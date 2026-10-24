import { describe, expect, it, vi } from 'vitest';

import { createUnregisteredScheduledWorktreeBridge, fillScheduledWorktreeBridge } from './worktree-bridge.js';

const dependencies = (overrides = {}) => ({
  createWorktree: vi.fn(async () => ({ path: '/repo/.worktrees/scheduled-run-1', branch: 'openchamber/run', name: 'scheduled-run-1' })),
  createWorktreeInstanceDisposer: vi.fn(() => 'disposer'),
  removeWorktree: vi.fn(async () => {}),
  isGitRepository: vi.fn(async () => true),
  buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
  getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer token' }),
  bootstrapStore: { store: true },
  ...overrides,
});

describe('scheduled task worktree bridge before the git routes register', () => {
  it('refuses to create with a reason a run can report', async () => {
    const bridge = createUnregisteredScheduledWorktreeBridge();

    // An empty answer here would read as "not a git repository" and let the
    // run quietly use the checkout (#1959).
    await expect(bridge.create({ projectDirectory: '/repo' })).rejects.toThrow('worktree bridge not registered yet');
  });

  it('has nothing to remove and claims nothing about the folder', async () => {
    const bridge = createUnregisteredScheduledWorktreeBridge();

    await expect(bridge.remove({ projectDirectory: '/repo', worktreeDirectory: '/repo/.worktrees/x' })).resolves.toBeUndefined();
    // "true" sends the run to creation, where the refusal above is the answer
    // it gets — not a misleading "not a repository".
    expect(bridge.isGitRepository('/repo')).toBe(true);
  });
});

describe('scheduled task worktree bridge', () => {
  it('creates a run worktree through the dialog pipeline and normalizes the answer', async () => {
    const createWorktree = vi.fn(async () => ({ path: '/repo/.worktrees/run-1', branch: '', name: undefined }));
    const bridge = fillScheduledWorktreeBridge({}, dependencies({ createWorktree }));

    const created = await bridge.create({ projectDirectory: '/repo', baseBranch: 'release/2.5' });

    expect(createWorktree).toHaveBeenCalledWith('/repo', { mode: 'new', startRef: 'release/2.5' });
    // An answer without a branch reads as null, not as an empty string.
    expect(created).toEqual({ directory: '/repo/.worktrees/run-1', branch: null, name: null });
  });

  it('starts from the checkout when no base branch was picked', async () => {
    const createWorktree = vi.fn(async () => ({ path: '/repo/.worktrees/run-2' }));
    const bridge = fillScheduledWorktreeBridge({}, dependencies({ createWorktree }));

    await bridge.create({ projectDirectory: '/repo', baseBranch: '' });

    // No startRef key at all: the creation path decides from HEAD.
    expect(createWorktree).toHaveBeenCalledWith('/repo', { mode: 'new' });
  });

  it('has no create function when the git routes did not register one', async () => {
    const bridge = fillScheduledWorktreeBridge({}, dependencies({ createWorktree: undefined }));

    expect(bridge.create).toBeNull();
    // The run fails rather than pretending the project is not a repository.
    expect(bridge.isGitRepository).toBeInstanceOf(Function);
  });

  it('removes the run worktree with its branch and releases its instance by path', async () => {
    const removeWorktree = vi.fn(async () => {});
    const disposer = vi.fn(() => 'disposer');
    const deps = dependencies({
      removeWorktree,
      createWorktreeInstanceDisposer: disposer,
    });
    const bridge = fillScheduledWorktreeBridge({}, deps);

    await bridge.remove({ projectDirectory: '/repo', worktreeDirectory: '/repo/.worktrees/run-1', deleteLocalBranch: true });

    expect(disposer).toHaveBeenCalledWith({
      buildOpenCodeUrl: deps.buildOpenCodeUrl,
      getOpenCodeAuthHeaders: deps.getOpenCodeAuthHeaders,
    });
    expect(removeWorktree).toHaveBeenCalledWith('/repo', {
      directory: '/repo/.worktrees/run-1',
      deleteLocalBranch: true,
      disposeInstance: 'disposer',
    }, { bootstrapStore: deps.bootstrapStore });
  });

  it('keeps the branch unless the caller asked for its deletion', async () => {
    const removeWorktree = vi.fn(async () => {});
    const bridge = fillScheduledWorktreeBridge({}, dependencies({ removeWorktree }));

    await bridge.remove({ projectDirectory: '/repo', worktreeDirectory: '/repo/.worktrees/run-1', deleteLocalBranch: false });

    expect(removeWorktree.mock.calls[0][1].deleteLocalBranch).toBe(false);
  });

  it('removes without a disposer when the creation pipeline has none', async () => {
    const removeWorktree = vi.fn(async () => {});
    const bridge = fillScheduledWorktreeBridge({}, dependencies({
      removeWorktree,
      createWorktreeInstanceDisposer: undefined,
    }));

    await bridge.remove({ projectDirectory: '/repo', worktreeDirectory: '/repo/.worktrees/run-1' });

    expect(removeWorktree.mock.calls[0][1]).toMatchObject({ deleteLocalBranch: true });
    expect(Object.hasOwn(removeWorktree.mock.calls[0][1], 'disposeInstance')).toBe(true);
    expect(removeWorktree.mock.calls[0][1].disposeInstance).toBeUndefined();
  });

  it('lets a failing repository probe stay an error', async () => {
    const isGitRepository = vi.fn(async () => {
      throw new Error('git is unavailable');
    });
    const bridge = fillScheduledWorktreeBridge({}, dependencies({ isGitRepository }));

    // A swallowed error would read as "not a git repository" and let the run
    // quietly use the checkout (#1959).
    await expect(bridge.isGitRepository('/repo')).rejects.toThrow('git is unavailable');
  });

  it('leaves a bridge that is not an object alone', () => {
    expect(fillScheduledWorktreeBridge(null, dependencies())).toBeNull();
    expect(fillScheduledWorktreeBridge(undefined, dependencies())).toBeUndefined();
  });
});
