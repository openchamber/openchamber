import { beforeEach, describe, expect, it, mock } from 'bun:test';

import {
  createGitExecutionCoordinator,
  GIT_OPERATION_KIND,
} from '../../web/server/lib/git/execution-coordinator.js';

const core = {
  checkIsGitRepository: mock(),
};

const runtime = {
  discover: mock(),
  runDirectoryFallbackRead: mock(),
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
};

mock.module('./gitService', () => core);
mock.module('./git-execution-runtime', () => ({ gitExecutionRuntime: runtime }));

const { createGitExecutionService } = await import('./git-execution-service');
  const {
    GIT_OPERATION_PROFILE,
    GIT_NETWORK_USAGE,
    getGitServiceOperationClassification,
  } = await import('./git-operation-classification');

describe('VS Code Git execution service discovery fallback', () => {
  beforeEach(() => {
    core.checkIsGitRepository.mockReset();
    runtime.discover.mockReset();
    runtime.runDirectoryFallbackRead.mockReset();
    runtime.runDirectoryFallbackRead.mockImplementation((_directory, task) => task());
  });

  it('propagates permission discovery failures instead of probing raw Git', async () => {
    const failure = Object.assign(
      new Error('Git context discovery failed: EACCES permission denied'),
      { code: 'EACCES' },
    );
    runtime.discover.mockRejectedValue(failure);

    await expect(createGitExecutionService({ core, runtime }).checkIsGitRepository('/repo'))
      .rejects.toBe(failure);
    expect(runtime.runDirectoryFallbackRead).not.toHaveBeenCalled();
    expect(core.checkIsGitRepository).not.toHaveBeenCalled();
  });

  it('keeps the raw fallback for an explicitly identified non-repository', async () => {
    runtime.discover.mockRejectedValue({ reason: 'not-a-repository' });
    core.checkIsGitRepository.mockResolvedValue(false);

    await expect(createGitExecutionService({ core, runtime }).checkIsGitRepository('/repo'))
      .resolves.toBe(false);
    expect(runtime.runDirectoryFallbackRead).toHaveBeenCalledWith('/repo', expect.any(Function));
    expect(core.checkIsGitRepository).toHaveBeenCalledWith('/repo');
  });

  it('keeps the built-in Repository API fallback when raw discovery cannot start', async () => {
    runtime.discover.mockRejectedValue({
      code: 'ENOENT',
      details: { operation: 'git-context-discovery' },
    });
    core.checkIsGitRepository.mockResolvedValue(true);

    await expect(createGitExecutionService({ core, runtime }).checkIsGitRepository('/repo'))
      .resolves.toBe(true);
    expect(runtime.runDirectoryFallbackRead).toHaveBeenCalledWith('/repo', expect.any(Function));
    expect(core.checkIsGitRepository).toHaveBeenCalledWith('/repo');
  });

  it('classifies branch and commit checkout as worktree-scoped writes', () => {
    expect(getGitServiceOperationClassification('checkoutBranch'))
      .toEqual({ profile: GIT_OPERATION_PROFILE.WORKTREE_WRITE, network: GIT_NETWORK_USAGE.NONE });
    expect(getGitServiceOperationClassification('checkoutCommit').profile)
      .toBe(GIT_OPERATION_PROFILE.WORKTREE_WRITE);
    expect(getGitServiceOperationClassification('getGitBranches').network)
      .toBe(GIT_NETWORK_USAGE.NONE);
  });

  it('does not let a competing topology operation overlap fast attachment', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 4,
      globalNetworkConcurrency: 2,
    });
    const context = {
      isRepository: true,
      commonId: '/repo/.git',
      worktreeId: '/repo',
    };
    const calls = [];
    let finishCreate = null;
    let releaseAttachment;
    let attachmentStarted = false;
    const raw = {
      createWorktree: async (_directory, _input, options) => {
        const attachment = options.scheduleBackground(
          {
            operation: 'worktreeAttachment',
            contextDirectory: '/repo',
            network: false,
          },
          async () => {
            attachmentStarted = true;
            calls.push('attachment-start');
            await new Promise((resolve) => { releaseAttachment = resolve; });
            calls.push('attachment-end');
          },
        );
        await new Promise((resolve) => { finishCreate = resolve; });
        return { attachment };
      },
    };
    const runtime = {
      discover: async () => context,
      runServiceOperation: (_operation, _directory, task, options = {}) => coordinator.run({
        context,
        kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
        targetWorktree: true,
        network: options.network,
      }, task),
      runInternalOperationInContext: (_operation, operationContext, task, options = {}) => coordinator.run({
        context: operationContext,
        kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
        targetWorktree: true,
        network: options.network,
        lease: options.lease,
      }, task),
    };
    const service = createGitExecutionService({ core: { ...core, createWorktree: raw.createWorktree }, runtime });

    const created = service.createWorktree('/repo', { startRef: 'origin/main' });
    await waitFor(() => finishCreate !== null);

    let competingStarted = false;
    const competing = coordinator.run({
      context,
      kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
      targetWorktree: true,
    }, () => {
      competingStarted = true;
      calls.push('competing-start');
      return 'competing';
    });
    finishCreate();

    const createdResult = await created;
    await waitFor(() => attachmentStarted);
    expect(calls).toEqual(['attachment-start']);
    expect(competingStarted).toBe(false);
    expect(coordinator.getStats().activeNetwork).toBe(1);

    releaseAttachment();
    await expect(createdResult.attachment).resolves.toBeUndefined();
    await expect(competing).resolves.toBe('competing');
    expect(calls).toEqual(['attachment-start', 'attachment-end', 'competing-start']);
  });

  it('keeps worktree metadata initialization out of the read classification', () => {
    expect(getGitServiceOperationClassification('previewWorktreeCreate').profile)
      .toBe(GIT_OPERATION_PROFILE.COMMON_WRITE);
    expect(getGitServiceOperationClassification('canonicalizeWorktreeState').profile)
      .toBe(GIT_OPERATION_PROFILE.COMMON_WRITE);
  });

  it('keeps validate and create network classification independent for branch sources', async () => {
    const admissions = [];
    const executionRuntime = {
      runServiceOperation: async (operation, _directory, task, options = {}) => {
        admissions.push({ operation, ...options });
        return task({
          commonId: '/repo/.git',
          worktreeId: '/repo',
          kind: 'common-write',
          targetWorktree: false,
          network: options.network === true,
          active: true,
        });
      },
    };
    const service = createGitExecutionService({
      core: {
        ...core,
        validateWorktreeCreate: mock(async () => 'validated'),
        createWorktree: mock(async () => 'created'),
      },
      runtime: executionRuntime,
    });
    const input = {
      existingBranch: 'local',
      startRef: 'origin/main',
    };

    await expect(service.validateWorktreeCreate('/repo', input)).resolves.toBe('validated');
    await expect(service.createWorktree('/repo', input)).resolves.toBe('created');

    expect(admissions).toEqual([
      expect.objectContaining({ operation: 'validateWorktreeCreate', network: true }),
      expect.objectContaining({ operation: 'createWorktree', network: true }),
    ]);
  });

  it('forwards range read signals and queue deadlines through the service boundary', async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal, queueTimeoutMs: 25 };
    const admissions = [];
    const rangeFiles = mock(async (_directory, _base, _head, receivedOptions) => {
      expect(receivedOptions).toBe(options);
      return ['src/a.ts'];
    });
    const rangeDiff = mock(async (_directory, _base, _head, _filePath, _contextLines, receivedOptions) => {
      expect(receivedOptions).toBe(options);
      return { diff: 'diff' };
    });
    const executionRuntime = {
      runServiceOperation: async (operation, directory, task, receivedOptions) => {
        admissions.push({ operation, directory, options: receivedOptions });
        return task({
          commonId: '/repo/.git',
          worktreeId: '/repo',
          kind: GIT_OPERATION_KIND.READ,
          targetWorktree: true,
          network: false,
          active: true,
        });
      },
    };
    const service = createGitExecutionService({
      core: { ...core, getGitRangeFiles: rangeFiles, getGitRangeDiff: rangeDiff },
      runtime: executionRuntime,
    });

    await expect(service.getGitRangeFiles('/repo', 'main', 'feature', options))
      .resolves.toEqual(['src/a.ts']);
    await expect(service.getGitRangeDiff('/repo', 'main', 'feature', 'src/a.ts', 3, options))
      .resolves.toEqual({ diff: 'diff' });

    expect(admissions).toEqual([
      { operation: 'getGitRangeFiles', directory: '/repo', options },
      { operation: 'getGitRangeDiff', directory: '/repo', options },
    ]);
    expect(rangeFiles).toHaveBeenCalledWith('/repo', 'main', 'feature', options);
    expect(rangeDiff).toHaveBeenCalledWith('/repo', 'main', 'feature', 'src/a.ts', 3, options);
  });
});
