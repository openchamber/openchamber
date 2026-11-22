import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createUnregisteredScheduledWorktreeBridge, fillScheduledWorktreeBridge } from './worktree-bridge.js';
import { deleteBranch, isGitRepository, removeWorktree } from '../git/service.js';
import { createScheduledTasksRuntime } from './runtime.js';

const dependencies = (overrides = {}) => ({
  createWorktree: vi.fn(async () => ({ path: '/repo/.worktrees/scheduled-run-1', branch: 'openchamber/run', name: 'scheduled-run-1' })),
  createWorktreeInstanceDisposer: vi.fn(() => 'disposer'),
  removeWorktree: vi.fn(async () => {}),
  deleteBranch: vi.fn(async () => {}),
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

    await expect(bridge.remove({ projectDirectory: '/repo', worktreeDirectory: '/repo/.worktrees/x' })).rejects.toThrow('worktree bridge not registered yet');
    // "true" sends the run to creation, where the refusal above is the answer
    // it gets — not a misleading "not a repository".
    expect(bridge.isGitRepository('/repo')).toBe(true);
  });
});

describe('scheduled task worktree bridge', () => {
  it.each(['repository', 'plain folder', 'broken config', 'broken gitfile', 'missing directory',
    ...(process.platform === 'win32' ? [] : ['missing git executable', 'mount boundary', 'permission denied', 'terminated probe'])])(
    'dispatches safely through the real repository probe with %s', async (kind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'oc-schedule-probe-'));
      const directory = path.join(root, 'project');
      await mkdir(directory);
      if (kind === 'repository' || kind === 'broken config') {
        execFileSync('git', ['init', directory], { stdio: 'ignore' });
      }
      if (kind === 'broken config') {
        await writeFile(path.join(directory, '.git/config'), '[invalid');
      }
      if (kind === 'broken gitfile') {
        await writeFile(path.join(directory, '.git'), `gitdir: ${path.join(root, 'missing')}\n`);
      }
      if (kind === 'missing directory') await rm(directory, { recursive: true });
      if (kind === 'missing git executable') {
        vi.stubEnv('PATH', root);
      }
      if (kind === 'mount boundary' || kind === 'permission denied' || kind === 'terminated probe') {
        const executable = path.join(root, 'git');
        const message = kind === 'permission denied'
          ? 'fatal: cannot access project: Permission denied'
          : 'fatal: not a git repository (or any parent up to mount point /fixture)';
        const exit = kind === 'terminated probe' ? 'kill -KILL $$' : 'exit 128';
        await writeFile(executable, `#!/bin/sh\necho "${message}" >&2\n${exit}\n`);
        await chmod(executable, 0o700);
        vi.stubEnv('PATH', root);
      }
      const createWorktree = vi.fn(async () => ({ path: path.join(root, 'worktree') }));
      const bridge = fillScheduledWorktreeBridge({}, dependencies({ createWorktree, isGitRepository }));
      const task = {
        id: 'task-1', name: 'Probe test', enabled: false, runInWorktree: true, cleanupWorktree: false,
        schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
        execution: { prompt: 'Review', useDefaults: true },
        state: { createdAt: 1, updatedAt: 1 },
      };
      const fetchMock = vi.fn(async (input) => {
        const data = new URL(String(input)).pathname === '/api/session' ? { id: 'ses_probe' } : {};
        return Response.json({ data });
      });
      vi.stubGlobal('fetch', fetchMock);
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime: {
          listScheduledTasks: async () => [task],
          reconcileLoopTasks: async () => [task],
          updateScheduledTaskState: async () => ({ task, updated: true }),
        },
        listProjects: async () => [{ id: 'proj', path: directory }],
        buildOpenCodeUrl: () => 'http://localhost:1/',
        getOpenCodeAuthHeaders: () => ({}),
        waitForOpenCodeReady: async () => {},
        createTaskWorktree: bridge.create,
        removeTaskWorktree: bridge.remove,
        isGitRepository: bridge.isGitRepository,
        logger: { info() {}, warn() {}, error() {} },
      });
      try {
        await runtime.start();
        const result = await runtime.runNow('proj', task.id);
        if (kind === 'broken config' || kind === 'broken gitfile' || kind === 'missing directory' || kind === 'missing git executable' || kind === 'permission denied' || kind === 'terminated probe') {
          expect(result.ok).toBe(false);
          expect(result.error).toContain('failed to check whether the project is a git repository');
          expect(fetchMock).not.toHaveBeenCalled();
          expect(createWorktree).not.toHaveBeenCalled();
        } else {
          expect(result.ok).toBe(true);
          expect(result.directory).toBe(kind === 'repository' ? path.join(root, 'worktree') : directory);
          expect(createWorktree).toHaveBeenCalledTimes(kind === 'repository' ? 1 : 0);
        }
      } finally {
        runtime.stop();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('removes only the generated branch after the agent switches to an existing branch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oc-schedule-switched-branch-'));
    const repository = path.join(root, 'repo');
    const worktree = path.join(root, 'run');
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await mkdir(repository);
      git(repository, 'init', '-b', 'main');
      git(repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
      git(repository, 'branch', 'feature-x');
      git(repository, 'worktree', 'add', '-b', 'openchamber/run', worktree);
      git(worktree, 'switch', 'feature-x');
      const bridge = fillScheduledWorktreeBridge({}, dependencies({
        removeWorktree, deleteBranch, createWorktreeInstanceDisposer: undefined,
        bootstrapStore: undefined,
      }));
      await bridge.remove({
        projectDirectory: repository, worktreeDirectory: worktree,
        deleteLocalBranch: true, branch: 'openchamber/run',
      });
      expect(git(repository, 'show-ref', '--verify', 'refs/heads/feature-x')).toContain('refs/heads/feature-x');
      expect(spawnSync('git', ['show-ref', '--verify', 'refs/heads/openchamber/run'], { cwd: repository }).status).toBe(128);
      expect(git(repository, 'worktree', 'list', '--porcelain')).not.toContain(worktree);
      await bridge.remove({
        projectDirectory: repository, worktreeDirectory: worktree,
        deleteLocalBranch: true, branch: 'openchamber/run',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

    await bridge.remove({ projectDirectory: '/repo', worktreeDirectory: '/repo/.worktrees/run-1', deleteLocalBranch: true, branch: 'openchamber/run' });

    expect(disposer).toHaveBeenCalledWith({
      buildOpenCodeUrl: deps.buildOpenCodeUrl,
      getOpenCodeAuthHeaders: deps.getOpenCodeAuthHeaders,
    });
    expect(removeWorktree).toHaveBeenCalledWith('/repo', {
      directory: '/repo/.worktrees/run-1',
      deleteLocalBranch: false,
      disposeInstance: 'disposer',
    }, { bootstrapStore: deps.bootstrapStore });
    expect(deps.deleteBranch).toHaveBeenCalledWith('/repo', 'openchamber/run', { force: true, ifExists: true });
  });

  it('finishes branch cleanup without touching a directory that replaced the old worktree', async () => {
    const deps = dependencies();
    const bridge = fillScheduledWorktreeBridge({}, deps);
    await bridge.remove({
      projectDirectory: '/repo', worktreeDirectory: '/repo/replaced',
      branch: 'openchamber/run', deleteLocalBranch: true, removeDirectory: false,
    });
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).toHaveBeenCalledWith('/repo', 'openchamber/run', { force: true, ifExists: true });
  });

  it('keeps the branch unless the caller asked for its deletion', async () => {
    const removeWorktree = vi.fn(async () => {});
    const deps = dependencies({ removeWorktree });
    const bridge = fillScheduledWorktreeBridge({}, deps);

    await bridge.remove({ projectDirectory: '/repo', worktreeDirectory: '/repo/.worktrees/run-1', deleteLocalBranch: false, branch: 'openchamber/run' });

    expect(removeWorktree.mock.calls[0][1].deleteLocalBranch).toBe(false);
    expect(deps.deleteBranch).not.toHaveBeenCalled();
  });

  it('removes without a disposer when the creation pipeline has none', async () => {
    const removeWorktree = vi.fn(async () => {});
    const bridge = fillScheduledWorktreeBridge({}, dependencies({
      removeWorktree,
      createWorktreeInstanceDisposer: undefined,
    }));

    await bridge.remove({ projectDirectory: '/repo', worktreeDirectory: '/repo/.worktrees/run-1' });

    expect(removeWorktree.mock.calls[0][1]).toMatchObject({ deleteLocalBranch: false });
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
