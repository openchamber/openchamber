import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { createGitExecutionService } from './execution-service.js';
import {
  createGitExecutionCoordinator,
  GIT_OPERATION_KIND,
} from './execution-coordinator.js';
import { getGitExecutionEnv } from './execution-scope.js';

const contextFor = (directory) => ({
  isRepository: true,
  commonId: '/repo/.git',
  worktreeId: directory,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
};

describe('Git execution service', () => {
  it('coordinates wrapped worktree reads and writes through the shared scheduler', async () => {
    const calls = [];
    let releaseWrite;
    const raw = {
      stageFile: async () => {
        calls.push('write-start');
        return new Promise((resolve) => {
          releaseWrite = () => {
            calls.push('write-end');
            resolve('staged');
          };
        });
      },
      getDiff: async () => {
        calls.push('read');
        return 'diff';
      },
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    const write = service.stageFile('/repo', 'file.ts');
    await tick();
    const read = service.getDiff('/repo', 'file.ts', false, 3);
    await tick();

    expect(calls).toEqual(['write-start']);
    releaseWrite();
    await expect(write).resolves.toBe('staged');
    await expect(read).resolves.toBe('diff');
    expect(calls).toEqual(['write-start', 'write-end', 'read']);
  });

  it('applies optional-lock suppression only inside coordinated read execution', async () => {
    const observations = [];
    const directory = process.cwd();
    const repositoryRoot = path.resolve(directory, '../..');
    let service;
    const raw = {
      createGit: async (cwd, options) => {
        observations.push({ type: 'discovery', cwd, env: options?.envOverrides });
        return {
          raw: async () => `${repositoryRoot}\n${repositoryRoot}/.git\n${repositoryRoot}/.git\n`,
        };
      },
      getDiff: async () => {
        observations.push({
          type: 'read',
          env: getGitExecutionEnv(),
          active: service.coordinator.getStats().active,
        });
        return 'diff';
      },
      stageFile: async () => {
        observations.push({
          type: 'write',
          env: getGitExecutionEnv(),
          active: service.coordinator.getStats().active,
        });
      },
    };
    service = createGitExecutionService({ raw });

    await expect(service.getDiff(directory, 'file.ts')).resolves.toBe('diff');
    await expect(service.stageFile(directory, 'file.ts')).resolves.toBeUndefined();

    expect(observations).toEqual([
      {
        type: 'discovery',
        cwd: directory,
        env: { GIT_OPTIONAL_LOCKS: '0' },
      },
      {
        type: 'read',
        env: { GIT_OPTIONAL_LOCKS: '0' },
        active: 1,
      },
      {
        type: 'write',
        env: {},
        active: 1,
      },
    ]);
  });

  it('tracks attachment independently and queues bootstrap on its new worktree', async () => {
    const calls = [];
    const raw = {
      createWorktree: async (directory, input, options) => {
        const attachment = options.scheduleBackground(
          {
            operation: 'worktreeAttachment',
            contextDirectory: directory,
          },
          async () => {
            calls.push('attachment');
          },
        );
        const bootstrap = options.scheduleBackground(
          {
            operation: 'worktreeBootstrap',
            contextDirectory: '/repo/worktree',
          },
          async () => {
            calls.push('bootstrap');
          },
        );
        return { attachment, bootstrap, input };
      },
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    const result = await service.createWorktree('/repo', { worktreeName: 'feature' });
    await result.bootstrap;

    expect(calls).toEqual(['attachment', 'bootstrap']);
    expect(result.input).toEqual({ worktreeName: 'feature' });
  });

  it('tracks fast attachment as a topology operation after the response is ready', async () => {
    const calls = [];
    let activeNetwork;
    let releaseAttachment;
    let service;
    const raw = {
      createWorktree: async (_directory, _input, options) => {
        calls.push('create-start');
        const attachment = options.scheduleBackground(
          {
            operation: 'worktreeAttachment',
            contextDirectory: '/repo',
          },
          async () => {
            calls.push('attachment-start');
            activeNetwork = service.coordinator.getStats().activeNetwork;
            await new Promise((resolve) => { releaseAttachment = resolve; });
            calls.push('attachment-end');
          },
        );
        calls.push('create-end');
        return { attachment };
      },
      removeWorktree: async () => {
        calls.push('remove-start');
        return true;
      },
    };
    service = createGitExecutionService({
      raw,
      coordinator: undefined,
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    const created = await service.createWorktree('/repo', {
      worktreeName: 'feature',
      startRef: 'origin/main',
      setUpstream: true,
      upstreamRemote: 'origin',
      upstreamBranch: 'main',
    });
    await waitFor(() => calls.includes('attachment-start'));
    const removal = service.removeWorktree('/repo', { directory: '/repo/worktree' });
    await tick();

    expect(calls).toEqual(['create-start', 'create-end', 'attachment-start']);
    expect(activeNetwork).toBe(1);

    releaseAttachment();
    await expect(created.attachment).resolves.toBeUndefined();
    await expect(removal).resolves.toBe(true);
    expect(calls).toEqual([
      'create-start',
      'create-end',
      'attachment-start',
      'attachment-end',
      'remove-start',
    ]);
  });

  it('keeps non-repository identity calls on the raw fallback path', async () => {
    const calls = [];
    const raw = {
      getCurrentIdentity: async (directory) => {
        calls.push(directory);
        return { userName: 'User', userEmail: 'user@example.test' };
      },
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async (directory) => ({
        isRepository: false,
        requestedDirectory: directory,
        reason: 'not-a-repository',
      }) },
    });

    await expect(service.getCurrentIdentity('/not-a-repo')).resolves.toEqual({
      userName: 'User',
      userEmail: 'user@example.test',
    });
    expect(calls).toEqual(['/not-a-repo']);
  });

  it('keeps deleted-directory checks and status on the soft raw fallback path', async () => {
    const calls = [];
    const raw = {
      getStatus: async (directory, options) => {
        calls.push({ directory, options });
        return { isGitRepository: false, files: [] };
      },
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async (directory) => ({
        isRepository: false,
        requestedDirectory: directory,
        reason: 'not-a-repository',
      }) },
    });

    await expect(service.isGitRepository('/deleted-worktree')).resolves.toBe(false);
    await expect(service.getStatus('/deleted-worktree')).resolves.toEqual({
      isGitRepository: false,
      files: [],
    });
    expect(calls).toEqual([{
      directory: '/deleted-worktree',
      options: undefined,
    }]);
  });

  it('propagates a missing Git executable discovery failure', async () => {
    const failure = Object.assign(new Error('Git executable is unavailable'), {
      code: 'ENOENT',
      details: { operation: 'git-context-discovery' },
    });
    const service = createGitExecutionService({
      raw: {},
      resolver: { resolve: async () => { throw failure; } },
    });

    await expect(service.isGitRepository('/repo')).rejects.toBe(failure);
  });

  it('classifies branch and commit checkout as worktree-scoped writes', async () => {
    const kinds = [];
    const raw = {
      checkoutBranch: async () => 'branch',
      checkoutCommit: async () => 'commit',
    };
    const service = createGitExecutionService({
      raw,
      coordinator: {
        run: async (options, task) => {
          kinds.push(options.kind);
          return task();
        },
      },
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    await expect(service.checkoutBranch('/repo', 'feature')).resolves.toBe('branch');
    await expect(service.checkoutCommit('/repo', '0123456789abcdef')).resolves.toBe('commit');
    expect(kinds).toEqual([
      GIT_OPERATION_KIND.WORKTREE_WRITE,
      GIT_OPERATION_KIND.WORKTREE_WRITE,
    ]);
  });

  it('admits remote-only checkouts to network limits without penalizing local slash branches', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 4,
      globalNetworkConcurrency: 2,
      networkPerCommonContext: 1,
    });
    const started = [];
    const releases = new Map();
    const raw = {
      getRemotes: async () => [],
      checkoutBranch: async (directory) => new Promise((resolve) => {
        started.push(directory);
        releases.set(directory, resolve);
      }),
    };
    const service = createGitExecutionService({
      raw,
      coordinator,
      resolver: { resolve: async (directory) => ({
        isRepository: true,
        commonId: directory.startsWith('/repo/') ? '/repo/.git' : '/other/.git',
        worktreeId: directory,
      }) },
    });

    const remote = service.checkoutBranch('/repo/one', 'remotes/origin/remote-only');
    const sameRepository = service.checkoutBranch('/repo/two', 'remotes/origin/queued');
    const local = service.checkoutBranch('/repo/local', 'feature/topic');
    const otherRepository = service.checkoutBranch('/other/one', 'remotes/origin/other');

    try {
      await waitFor(() => started.length === 2);
      expect(new Set(started)).toEqual(new Set(['/repo/one', '/other/one']));
      expect(coordinator.getStats()).toMatchObject({ activeNetwork: 2, pending: 2 });

      releases.get('/repo/one')('remote');
      releases.get('/other/one')('other');
      await Promise.all([remote, otherRepository]);
      await waitFor(() => started.includes('/repo/two'));
      releases.get('/repo/two')('queued');
      await expect(sameRepository).resolves.toBe('queued');
      await waitFor(() => started.includes('/repo/local'));
      releases.get('/repo/local')('local');
      await expect(local).resolves.toBe('local');
    } finally {
      for (const release of releases.values()) release('cleanup');
      await Promise.allSettled([remote, sameRepository, local, otherRepository]);
    }
  });

  it('recognizes configured bare remote names without classifying other slash branches as network work', async () => {
    const network = [];
    const service = createGitExecutionService({
      raw: {
        checkoutBranch: async () => 'checked-out',
        getRemotes: async () => [{ name: 'origin' }],
      },
      coordinator: {
        run: async (options, task) => {
          network.push(options.network);
          return task();
        },
      },
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    await expect(service.checkoutBranch('/repo', 'origin/remote-only')).resolves.toBe('checked-out');
    await expect(service.checkoutBranch('/repo', 'feature/topic')).resolves.toBe('checked-out');
    expect(network).toEqual([false, true, false, false]);
  });

  it('serializes remote-only checkout fetches across worktrees in one repository', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 4,
      globalNetworkConcurrency: 4,
      networkPerCommonContext: 4,
    });
    const started = [];
    const releases = new Map();
    const raw = {
      checkoutBranch: async (directory) => new Promise((resolve) => {
        started.push(directory);
        releases.set(directory, resolve);
      }),
    };
    const service = createGitExecutionService({
      raw,
      coordinator,
      resolver: { resolve: async (directory) => ({
        isRepository: true,
        commonId: '/repo/.git',
        worktreeId: directory,
      }) },
    });

    const first = service.checkoutBranch('/repo/one', 'remotes/origin/first');
    const second = service.checkoutBranch('/repo/two', 'remotes/origin/second');

    try {
      await waitFor(() => started.length === 1);
      expect(started).toEqual(['/repo/one']);
      expect(coordinator.getStats()).toMatchObject({ active: 1, activeNetwork: 1, pending: 1 });

      releases.get('/repo/one')('first');
      await expect(first).resolves.toBe('first');
      await waitFor(() => started.length === 2);
      releases.get('/repo/two')('second');
      await expect(second).resolves.toBe('second');
    } finally {
      for (const release of releases.values()) release('cleanup');
      await Promise.allSettled([first, second]);
    }
  });

  it('classifies validate and create as network work when either branch source is remote-like', async () => {
    const admissions = [];
    const service = createGitExecutionService({
      raw: {
        validateWorktreeCreate: async () => 'validated',
        createWorktree: async () => 'created',
      },
      coordinator: {
        run: async (options, task) => {
          admissions.push(options);
          return task({ active: true });
        },
      },
      resolver: { resolve: async (directory) => contextFor(directory) },
    });
    const input = {
      existingBranch: 'local',
      startRef: 'origin/main',
    };

    await expect(service.validateWorktreeCreate('/repo', input)).resolves.toBe('validated');
    await expect(service.createWorktree('/repo', input)).resolves.toBe('created');

    expect(admissions).toEqual([
      expect.objectContaining({
        label: 'validateWorktreeCreate',
        network: true,
      }),
      expect.objectContaining({
        label: 'createWorktree',
        network: true,
      }),
    ]);
  });

  it('keeps configured remote slash checkout network-coordinated across a local-branch race', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 1,
      globalNetworkConcurrency: 1,
    });
    let localBranchExists = true;
    const admissions = [];
    const service = createGitExecutionService({
      raw: {
        getRemotes: async () => [{ name: 'origin' }],
        createGit: async () => ({
          raw: async () => (localBranchExists ? 'local-ref' : ''),
        }),
        checkoutBranch: async () => {
          expect(coordinator.getStats().activeNetwork).toBe(1);
          expect(localBranchExists).toBe(false);
          return 'checked-out';
        },
      },
      coordinator: {
        run: (options, task) => coordinator.run(options, async (lease) => {
          const result = await task(lease);
          if (options.label === 'checkout-branch-preflight') {
            localBranchExists = false;
          }
          admissions.push(options);
          return result;
        }),
      },
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    await expect(service.checkoutBranch('/repo', 'origin/topic')).resolves.toBe('checked-out');

    expect(admissions).toEqual([
      expect.objectContaining({
        label: 'checkout-branch-preflight',
        network: false,
      }),
      expect.objectContaining({
        label: 'checkoutBranch',
        kind: GIT_OPERATION_KIND.COMMON_WRITE,
        network: true,
      }),
    ]);
  });

  it('resolves integration operations from their repository input', async () => {
    const calls = [];
    const raw = {
      computeIntegratePlan: async (input) => {
        calls.push(input);
        return { commits: [] };
      },
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async (directory) => {
        calls.push(directory);
        return contextFor(directory);
      } },
    });

    await expect(service.computeIntegratePlan({
      repoRoot: '/repo',
      sourceBranch: 'feature',
      targetBranch: 'main',
    })).resolves.toEqual({ commits: [] });
    expect(calls).toEqual([
      '/repo',
      { repoRoot: '/repo', sourceBranch: 'feature', targetBranch: 'main' },
    ]);
  });

  it('forwards status queue deadlines and admits branch discovery to network work', async () => {
    const signal = new AbortController().signal;
    const calls = [];
    const service = createGitExecutionService({
      raw: {
        getStatus: async () => ({ current: 'main' }),
        getBranches: async () => ['main'],
      },
      coordinator: {
        runStatus: async (options, task) => {
          calls.push(options);
          return task(options['shape']);
        },
        run: async (options, task) => {
          calls.push(options);
          return task({ active: true });
        },
      },
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    await expect(service.getStatus('/repo', {
      mode: 'light',
      signal,
      queueTimeoutMs: 25,
    })).resolves.toEqual({ current: 'main' });
    await expect(service.getBranches('/repo')).resolves.toEqual(['main']);

    expect(calls[0]).toMatchObject({
      'shape': 'light',
      signal,
      queueTimeoutMs: 25,
    });
    expect(calls[1]).toMatchObject({
      kind: GIT_OPERATION_KIND.READ,
      network: true,
    });
  });

  it('passes the coordinated status source signal to the raw status operation', async () => {
    const sourceController = new AbortController();
    let statusOptions;
    const service = createGitExecutionService({
      raw: {
        getStatus: async (_directory, options) => {
          statusOptions = options;
          return { current: 'main' };
        },
      },
      coordinator: {
        runStatus: async (options, task) => task(options['shape'], sourceController.signal),
      },
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    await expect(service.getStatus('/repo', { mode: 'light' })).resolves.toEqual({ current: 'main' });
    expect(statusOptions).toEqual({ mode: 'light', signal: sourceController.signal });
  });

  it('applies the global network cap to branch discovery', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 4,
      globalNetworkConcurrency: 1,
      networkPerCommonContext: 4,
    });
    const started = [];
    const releases = new Map();
    const raw = {
      getBranches: async (directory) => new Promise((resolve) => {
        started.push(directory);
        releases.set(directory, resolve);
      }),
    };
    const service = createGitExecutionService({
      raw,
      coordinator,
      resolver: { resolve: async (directory) => ({
        isRepository: true,
        commonId: `${directory}/.git`,
        worktreeId: directory,
      }) },
    });

    const first = service.getBranches('/repo/one');
    const second = service.getBranches('/repo/two');
    try {
      await waitFor(() => started.length === 1);
      expect(started).toEqual(['/repo/one']);
      expect(coordinator.getStats()).toMatchObject({ activeNetwork: 1, pending: 1 });

      releases.get('/repo/one')('first');
      await expect(first).resolves.toBe('first');
      await waitFor(() => started.length === 2);
      releases.get('/repo/two')('second');
      await expect(second).resolves.toBe('second');
    } finally {
      for (const release of releases.values()) release('cleanup');
      await Promise.allSettled([first, second]);
    }
  });

  it('applies the per-repository network cap while allowing another repository', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 4,
      globalNetworkConcurrency: 2,
      networkPerCommonContext: 1,
    });
    const started = [];
    const releases = new Map();
    const raw = {
      getBranches: async (directory) => new Promise((resolve) => {
        started.push(directory);
        releases.set(directory, resolve);
      }),
    };
    const service = createGitExecutionService({
      raw,
      coordinator,
      resolver: { resolve: async (directory) => ({
        isRepository: true,
        commonId: directory.startsWith('/repo/') ? '/repo/.git' : '/other/.git',
        worktreeId: directory,
      }) },
    });

    const first = service.getBranches('/repo/one');
    const blocked = service.getBranches('/repo/two');
    const unrelated = service.getBranches('/other/one');
    try {
      await waitFor(() => started.length === 2);
      expect(started).toEqual(['/repo/one', '/other/one']);
      expect(coordinator.getStats()).toMatchObject({ activeNetwork: 2, pending: 1 });

      releases.get('/repo/one')('first');
      releases.get('/other/one')('unrelated');
      await expect(first).resolves.toBe('first');
      await expect(unrelated).resolves.toBe('unrelated');
      await waitFor(() => started.length === 3);
      releases.get('/repo/two')('blocked');
      await expect(blocked).resolves.toBe('blocked');
    } finally {
      for (const release of releases.values()) release('cleanup');
      await Promise.allSettled([first, blocked, unrelated]);
    }
  });

  it('does not classify filesystem metadata initialization as a read', async () => {
    const kinds = [];
    const service = createGitExecutionService({
      raw: {
        previewWorktreeCreate: async () => 'preview',
        canonicalizeWorktreeState: async () => 'canonical',
      },
      coordinator: {
        run: async (options, task) => {
          kinds.push(options.kind);
          return task({ active: true });
        },
      },
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    await expect(service.previewWorktreeCreate('/repo')).resolves.toBe('preview');
    await expect(service.canonicalizeWorktreeState('/repo')).resolves.toBe('canonical');
    expect(kinds).toEqual([
      GIT_OPERATION_KIND.COMMON_WRITE,
      GIT_OPERATION_KIND.COMMON_WRITE,
    ]);
  });
});
