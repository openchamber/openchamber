// @ts-expect-error Bun provides this module at test runtime; the extension tsconfig intentionally omits Bun globals.
import { describe, expect, it, mock } from 'bun:test';

import { createGitContextResolver } from './git-context-resolver';
import {
  GIT_OPERATION_KIND,
  createGitExecutionCoordinator,
  type GitExecutionContext,
  type GitExecutionLease,
} from './git-execution-coordinator';
import {
  GIT_EXECUTION_ERROR_CODES,
  GitExecutionOverloadedError,
} from './git-execution-errors';
import { createGitExecutionRuntime } from './git-execution-runtime';
import { getGitExecutionEnv } from './git-execution-scope';
import {
  GIT_OPERATION_PROFILE,
  GIT_SERVICE_OPERATION_CLASSIFICATION,
  type GitServiceOperationName,
} from './git-operation-classification';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  workspace: { fs: { readFile: async () => new Uint8Array() } },
}));

const coreModule = await import('./gitService');
const { createGitExecutionService } = await import('./git-execution-service');

type GitExecutionService = ReturnType<typeof createGitExecutionService>;
type CoreCall = {
  operation: GitServiceOperationName;
  args: unknown[];
  optionalLocks?: string;
};

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const executionContext = (directory = '/repo'): GitExecutionContext => {
  const isMain = directory === '/repo';
  return {
    isRepository: true,
    commonId: '/repo/.git',
    worktreeId: JSON.stringify([
      isMain ? '/repo/.git' : `/repo/.git/worktrees/${directory.split('/').pop()}`,
      directory,
    ]),
  };
};

const createRepositoryResolver = () => createGitContextResolver({
  realpath: async (value) => value,
  runGit: async (directory) => {
    const context = executionContext(directory);
    const [gitDir, topLevel] = JSON.parse(context.worktreeId) as [string, string];
    return { success: true, stdout: [topLevel, gitDir, context.commonId].join('\n') };
  },
});

const createFailingResolver = (error: Error = new Error('Git is unavailable')) => createGitContextResolver({
  realpath: async (value) => value,
  runGit: async () => {
    throw error;
  },
});

const createCoreProxy = (
  handler: (operation: GitServiceOperationName, args: unknown[]) => unknown | Promise<unknown>,
): typeof coreModule => new Proxy(coreModule, {
  get(target, property, receiver) {
    if (
      typeof property === 'string'
      && Object.prototype.hasOwnProperty.call(GIT_SERVICE_OPERATION_CLASSIFICATION, property)
    ) {
      return (...args: unknown[]) => handler(property as GitServiceOperationName, args);
    }
    return Reflect.get(target, property, receiver);
  },
});

const operationCases = [
  { name: 'checkIsGitRepository', invoke: (service: GitExecutionService) => service.checkIsGitRepository('/repo') },
  { name: 'isLinkedWorktree', invoke: (service: GitExecutionService) => service.isLinkedWorktree('/repo') },
  { name: 'getGitStatus', invoke: (service: GitExecutionService) => service.getGitStatus('/repo') },
  { name: 'getGitBranches', invoke: (service: GitExecutionService) => service.getGitBranches('/repo') },
  { name: 'checkoutBranch', invoke: (service: GitExecutionService) => service.checkoutBranch('/repo', 'feature') },
  { name: 'createBranch', invoke: (service: GitExecutionService) => service.createBranch('/repo', 'feature', 'main') },
  { name: 'deleteGitBranch', invoke: (service: GitExecutionService) => service.deleteGitBranch('/repo', 'feature', true) },
  { name: 'deleteRemoteBranch', invoke: (service: GitExecutionService) => service.deleteRemoteBranch('/repo', 'feature', 'origin') },
  { name: 'listGitWorktrees', invoke: (service: GitExecutionService) => service.listGitWorktrees('/repo') },
  { name: 'validateWorktreeCreate', invoke: (service: GitExecutionService) => service.validateWorktreeCreate('/repo', {}) },
  { name: 'previewWorktreeCreate', invoke: (service: GitExecutionService) => service.previewWorktreeCreate('/repo', {}) },
  { name: 'createWorktree', invoke: (service: GitExecutionService) => service.createWorktree('/repo', {}) },
  { name: 'getWorktreeBootstrapStatus', invoke: (service: GitExecutionService) => service.getWorktreeBootstrapStatus('/repo') },
  {
    name: 'removeWorktree',
    invoke: (service: GitExecutionService) => service.removeWorktree('/repo', { directory: '/repo/worktree' }),
  },
  { name: 'getGitDiff', invoke: (service: GitExecutionService) => service.getGitDiff('/repo', 'src/a.ts', false, 3) },
  {
    name: 'getGitRangeDiff',
    invoke: (service: GitExecutionService) => service.getGitRangeDiff('/repo', 'main', 'HEAD', 'src/a.ts', 3),
  },
  { name: 'getGitRangeFiles', invoke: (service: GitExecutionService) => service.getGitRangeFiles('/repo', 'main', 'HEAD') },
  { name: 'getGitFileDiff', invoke: (service: GitExecutionService) => service.getGitFileDiff('/repo', 'src/a.ts', false) },
  { name: 'revertGitFile', invoke: (service: GitExecutionService) => service.revertGitFile('/repo', 'src/a.ts', {}) },
  { name: 'stageGitFiles', invoke: (service: GitExecutionService) => service.stageGitFiles('/repo', ['src/a.ts']) },
  { name: 'unstageGitFiles', invoke: (service: GitExecutionService) => service.unstageGitFiles('/repo', ['src/a.ts']) },
  {
    name: 'applyGitHunk',
    invoke: (service: GitExecutionService) => service.applyGitHunk('/repo', 'src/a.ts', '@@ -1 +1 @@', 'stage'),
  },
  { name: 'createGitCommit', invoke: (service: GitExecutionService) => service.createGitCommit('/repo', 'message', {}) },
  { name: 'gitPush', invoke: (service: GitExecutionService) => service.gitPush('/repo', {}) },
  { name: 'gitPull', invoke: (service: GitExecutionService) => service.gitPull('/repo', {}) },
  { name: 'listGitStashes', invoke: (service: GitExecutionService) => service.listGitStashes('/repo') },
  { name: 'countGitStashFiles', invoke: (service: GitExecutionService) => service.countGitStashFiles('/repo', ['stash@{0}']) },
  { name: 'stashGitChanges', invoke: (service: GitExecutionService) => service.stashGitChanges('/repo', {}) },
  { name: 'applyGitStash', invoke: (service: GitExecutionService) => service.applyGitStash('/repo', { ref: 'stash@{0}' }) },
  { name: 'dropGitStash', invoke: (service: GitExecutionService) => service.dropGitStash('/repo', { ref: 'stash@{0}' }) },
  { name: 'popGitStash', invoke: (service: GitExecutionService) => service.popGitStash('/repo', { ref: 'stash@{0}' }) },
  { name: 'gitFetch', invoke: (service: GitExecutionService) => service.gitFetch('/repo', {}) },
  { name: 'getGitLog', invoke: (service: GitExecutionService) => service.getGitLog('/repo', {}) },
  { name: 'getCommitFiles', invoke: (service: GitExecutionService) => service.getCommitFiles('/repo', 'abcdef1') },
  {
    name: 'getCommitFileDiff',
    invoke: (service: GitExecutionService) => service.getCommitFileDiff('/repo', 'abcdef1', 'src/a.ts', false),
  },
  { name: 'getCurrentGitIdentity', invoke: (service: GitExecutionService) => service.getCurrentGitIdentity('/repo') },
  {
    name: 'setGitIdentity',
    invoke: (service: GitExecutionService) => service.setGitIdentity('/repo', 'User', 'user@example.test', null, false, null),
  },
  { name: 'getRemotes', invoke: (service: GitExecutionService) => service.getRemotes('/repo') },
  { name: 'removeRemote', invoke: (service: GitExecutionService) => service.removeRemote('/repo', 'upstream') },
  { name: 'rebase', invoke: (service: GitExecutionService) => service.rebase('/repo', { onto: 'main' }) },
  { name: 'abortRebase', invoke: (service: GitExecutionService) => service.abortRebase('/repo') },
  { name: 'merge', invoke: (service: GitExecutionService) => service.merge('/repo', { branch: 'main' }) },
  { name: 'abortMerge', invoke: (service: GitExecutionService) => service.abortMerge('/repo') },
  { name: 'continueRebase', invoke: (service: GitExecutionService) => service.continueRebase('/repo') },
  { name: 'continueMerge', invoke: (service: GitExecutionService) => service.continueMerge('/repo') },
  { name: 'checkoutCommit', invoke: (service: GitExecutionService) => service.checkoutCommit('/repo', 'abcdef1') },
  { name: 'cherryPick', invoke: (service: GitExecutionService) => service.cherryPick('/repo', 'abcdef1') },
  { name: 'revertCommit', invoke: (service: GitExecutionService) => service.revertCommit('/repo', 'abcdef1') },
  { name: 'resetToCommit', invoke: (service: GitExecutionService) => service.resetToCommit('/repo', 'abcdef1', 'mixed', false) },
  {
    name: 'validateWorktreeDirectory',
    invoke: (service: GitExecutionService) => service.validateWorktreeDirectory('/repo', '/repo/worktrees'),
  },
  { name: 'canonicalizeWorktreeState', invoke: (service: GitExecutionService) => service.canonicalizeWorktreeState('/repo') },
] satisfies ReadonlyArray<{
  name: GitServiceOperationName;
  invoke: (service: GitExecutionService) => Promise<unknown>;
}>;

describe('VS Code Git execution service facade', () => {
  it('delegates every classified operation through an executable table and scopes raw observations only', async () => {
    const calls: CoreCall[] = [];
    const core = createCoreProxy(async (operation, args) => {
      calls.push({ operation, args, optionalLocks: getGitExecutionEnv().GIT_OPTIONAL_LOCKS });
      return { operation };
    });
    const runtime = createGitExecutionRuntime({
      resolver: createFailingResolver(),
      coordinator: createGitExecutionCoordinator(),
      realpath: async (value) => value,
    });
    const service = createGitExecutionService({ core, runtime });

    expect(operationCases.map(({ name }) => name).sort())
      .toEqual(Object.keys(GIT_SERVICE_OPERATION_CLASSIFICATION).sort());

    for (const operationCase of operationCases) {
      const result = await operationCase.invoke(service);
      expect(result).toEqual({ operation: operationCase.name });
    }

    expect(calls.map(({ operation }) => operation)).toEqual(operationCases.map(({ name }) => name));
    for (const call of calls) {
      const profile = GIT_SERVICE_OPERATION_CLASSIFICATION[call.operation].profile;
      const observationalRaw = profile === GIT_OPERATION_PROFILE.READ
        || call.operation === 'checkIsGitRepository'
        || call.operation === 'validateWorktreeDirectory';
      expect(call.optionalLocks).toBe(observationalRaw ? '0' : undefined);
    }
    expect(runtime.getStats()).toMatchObject({
      resolver: { inFlightAliases: 0, inFlightContexts: 0, discovery: { active: 0, pending: 0 } },
      coordinator: { active: 0, pending: 0, activeNetwork: 0, statusInFlight: 0 },
    });
  });

  it('acquires one outer lease before built-in selection and keeps raw fallback under that lease', async () => {
    const coordinator = createGitExecutionCoordinator();
    const originalRun = coordinator.run.bind(coordinator);
    let activeLease: GitExecutionLease | null = null;
    let leaseAdmissions = 0;
    coordinator.run = ((options, task) => originalRun(options, async (lease) => {
      leaseAdmissions += 1;
      activeLease = lease;
      try {
        return await task(lease);
      } finally {
        activeLease = null;
      }
    })) as typeof coordinator.run;

    const observedLeases: GitExecutionLease[] = [];
    const events: string[] = [];
    const core = createCoreProxy(async (operation) => {
      if (operation !== 'getGitBranches') throw new Error(`Unexpected core operation: ${operation}`);
      expect(activeLease).not.toBeNull();
      observedLeases.push(activeLease!);
      events.push(`built-in:${coordinator.getStats().active}`);
      await Promise.resolve();
      expect(activeLease).not.toBeNull();
      observedLeases.push(activeLease!);
      events.push(`raw-fallback:${coordinator.getStats().active}:${getGitExecutionEnv().GIT_OPTIONAL_LOCKS}`);
      return { current: 'main', branches: [], remoteBranches: [] };
    });
    const runtime = createGitExecutionRuntime({
      resolver: createRepositoryResolver(),
      coordinator,
    });
    const service = createGitExecutionService({ core, runtime });

    await service.getGitBranches('/repo');

    expect(events).toEqual(['built-in:1', 'raw-fallback:1:0']);
    expect(leaseAdmissions).toBe(1);
    expect(observedLeases).toHaveLength(2);
    expect(observedLeases[0]).toBe(observedLeases[1]);
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0, activeNetwork: 0 });
  });

  it('shares in-flight status work through the top-level facade', async () => {
    const statusGate = deferred<unknown>();
    const statusStarted = deferred();
    let statusCalls = 0;
    const core = createCoreProxy(async (operation) => {
      if (operation !== 'getGitStatus') throw new Error(`Unexpected core operation: ${operation}`);
      statusCalls += 1;
      statusStarted.resolve();
      expect(getGitExecutionEnv()).toEqual({ GIT_OPTIONAL_LOCKS: '0' });
      return statusGate.promise;
    });
    const runtime = createGitExecutionRuntime({ resolver: createRepositoryResolver() });
    const service = createGitExecutionService({ core, runtime });

    const first = service.getGitStatus('/repo');
    const second = service.getGitStatus('/repo', { mode: 'light' });
    await statusStarted.promise;
    expect(statusCalls).toBe(1);

    const status = { branch: 'main', files: [] };
    statusGate.resolve(status);
    await expect(first).resolves.toBe(status);
    await expect(second).resolves.toBe(status);
    expect(statusCalls).toBe(1);
    expect(runtime.getStats().coordinator.statusInFlight).toBe(0);
  });

  it('admits worktree attachment and bootstrap after their parent leases', async () => {
    const events: string[] = [];
    let attachmentPromise: Promise<void> | undefined;
    let bootstrapPromise: Promise<void> | undefined;
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 3 });
    const core = createCoreProxy(async (operation, args) => {
      if (operation !== 'createWorktree') throw new Error(`Unexpected core operation: ${operation}`);
      const execution = args[2] as NonNullable<Parameters<typeof coreModule.createWorktree>[2]>;
      events.push(`parent:${coordinator.getStats().active}`);
      attachmentPromise = execution.scheduleBackground!({
        operation: 'worktreeAttachment',
        contextDirectory: '/repo',
        network: false,
      }, async () => {
        events.push(`attachment:start:${coordinator.getStats().active}`);
        bootstrapPromise = execution.scheduleBackground!({
          operation: 'worktreeBootstrap',
          contextDirectory: '/repo/worktree',
          network: false,
        }, async () => {
          events.push(`bootstrap:${coordinator.getStats().active}`);
        });
        events.push('attachment:end');
      });
      events.push('parent:return');
      return {
        head: '',
        name: 'worktree',
        branch: 'feature',
        path: '/repo/worktree',
        directoryCreated: true,
        bootstrapStatus: { status: 'pending', error: null, updatedAt: 1 },
      };
    });
    const runtime = createGitExecutionRuntime({
      resolver: createRepositoryResolver(),
      coordinator,
    });
    const service = createGitExecutionService({ core, runtime });

    await service.createWorktree('/repo', {});
    expect(attachmentPromise).toBeDefined();
    await attachmentPromise!;
    expect(bootstrapPromise).toBeDefined();
    await bootstrapPromise!;

    expect(events.indexOf('parent:return')).toBeLessThan(events.indexOf('attachment:start:1'));
    expect(events.indexOf('attachment:end')).toBeLessThan(events.indexOf('bootstrap:1'));
    expect(coordinator.getStats()).toMatchObject({
      active: 0,
      pending: 0,
      activeNetwork: 0,
      statusInFlight: 0,
    });
    expect(coordinator.getGeneration(executionContext('/repo')).common).toBe(6);
  });

  it('preserves structured coordinator failures and ordinary repository fallback behavior', async () => {
    const structuredError = new GitExecutionOverloadedError('discovery overloaded', { scope: 'test' });
    let structuredCoreCalls = 0;
    const structuredCore = createCoreProxy(async () => {
      structuredCoreCalls += 1;
      return true;
    });
    const structuredRuntime = createGitExecutionRuntime({ resolver: createFailingResolver(structuredError) });
    const structuredService = createGitExecutionService({ core: structuredCore, runtime: structuredRuntime });

    await expect(structuredService.checkIsGitRepository('/repo')).rejects.toBe(structuredError);
    expect(structuredCoreCalls).toBe(0);
    expect(structuredError.code).toBe(GIT_EXECUTION_ERROR_CODES.OVERLOADED);

    let fallbackCoreCalls = 0;
    const fallbackCore = createCoreProxy(async (operation) => {
      expect(operation).toBe('checkIsGitRepository');
      fallbackCoreCalls += 1;
      return false;
    });
    const fallbackRuntime = createGitExecutionRuntime({ resolver: createFailingResolver() });
    const fallbackService = createGitExecutionService({ core: fallbackCore, runtime: fallbackRuntime });

    await expect(fallbackService.checkIsGitRepository('/repo')).resolves.toBe(false);
    expect(fallbackCoreCalls).toBe(1);
  });

  it('propagates queue overload without invoking the rejected core operation', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 1,
      maxQueuePerContext: 1,
      maxGlobalQueue: 1,
    });
    const runtime = createGitExecutionRuntime({ resolver: createRepositoryResolver(), coordinator });
    let stageCalls = 0;
    const core = createCoreProxy(async (operation) => {
      expect(operation).toBe('stageGitFiles');
      stageCalls += 1;
    });
    const service = createGitExecutionService({ core, runtime });
    const gate = deferred();
    const blocker = coordinator.run({
      context: executionContext('/repo'),
      kind: GIT_OPERATION_KIND.READ,
    }, () => gate.promise);
    await flushMicrotasks();

    const admitted = service.stageGitFiles('/repo', ['src/a.ts']);
    await flushMicrotasks();
    await expect(service.stageGitFiles('/repo', ['src/b.ts'])).rejects.toMatchObject({
      code: GIT_EXECUTION_ERROR_CODES.OVERLOADED,
      details: { scope: 'context-queue', limit: 1 },
    });
    expect(stageCalls).toBe(0);

    gate.resolve();
    await blocker;
    await admitted;
    expect(stageCalls).toBe(1);
  });
});
